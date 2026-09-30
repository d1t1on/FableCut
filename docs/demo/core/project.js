/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — the data side of loading and saving project.json.

   Dual-mode classic script, loaded after core/schema.js and core/links.js:
   a <script> tag exposes FableCore.project, Node require()s it. No DOM and
   no app state. app.js keeps applyProject(data) and projectJSON() as the
   wrappers that own everything stateful: the live lane list (TRACKS, with
   colors and heights), state.*, media-element teardown, canvas size, UI
   syncs, the validation report, font loading and the migration save.

   normalizeProject(data, { prevFps }) → {
     project   every project field applyProject assigns: name, width, height,
               fps, background, revision, folders, media, clips, markers,
               inPoint, outPoint, exportFrame, encodeProfile, tracks (lane
               defs [{id, kind}], sorted, covering every clip's lane),
               disabledTracks, panSchema (always 1)
     fonts     text-clip font families to load (first-seen order, no repeats)
     migrated  true when the doc predates panSchema: the one-time stem-pan
               migration ran and the app must save once to persist it
   }
     prevFps    fps to keep when data.fps is missing or not > 0 (the app
                passes its current project.fps; default 30)
   data.clips is ADOPTED, not copied — as applyProject always did: the
   returned project.clips is data.clips itself, its clip objects normalized in
   place (in defaulted, and 0 for image/text/adjust (D5); props merged with
   DEFAULT_PROPS, keyframes sorted, links completed by relinkClips — ids on
   disk kept, new ones deterministic).
   So validate `data` before normalizing it. Every other field is a fresh
   array / object (marker objects are shared).

   serializeProject(project, trackDefs = project.tracks) → the project.json
   document the app PUTs: fixed key order, allowlisted fields, transient media
   dropped, exportFrame re-normalized, disabledTracks limited to trackDefs.
   Clip props / keyframes / transitions are shared with `project`, not copied.

   snapshotContent(project, { markers? }) → an undo snapshot (a string); restoreContent(
   project, snap, laneDefs) swaps one back in — see "Undo snapshots" below.

   Lanes a clip names but tracks[] lacks are still guessed from the clip kind
   and the id's letter (ensureLanesCoverClips).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports)
    module.exports = factory(require("./schema.js"), require("./links.js"));
  else {
    const core = root.FableCore || {};
    if (!core.schema) throw new Error("core/schema.js must load before core/project.js");
    if (!core.links) throw new Error("core/links.js must load before core/project.js");
    root.FableCore.project = factory(core.schema, core.links);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (S, L) {
  "use strict";
  const { DEFAULT_PROPS, PROJECT_SCHEMA, TIMED_KINDS } = S;
  const { relinkClips, defaultPanForChannel } = L;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)); // app.js clamp (same NaN behavior)

  /* Lanes when project.tracks is absent or empty (V3…V1 + A1…A4). */
  const DEFAULT_TRACK_DEFS = PROJECT_SCHEMA.$defs.project.properties.tracks.default;
  const TIMELINE_START_TIME = 0.000; // composition timeline start (seconds)

  /* ── Field normalizers ── */
  /* IN/OUT work area: finite, ≥ t0; OUT at or before IN clears both. */
  function normalizeWorkArea(i, o, t0 = TIMELINE_START_TIME) {
    let inPoint = (i != null && isFinite(i)) ? Math.max(t0, +i) : null;
    let outPoint = (o != null && isFinite(o)) ? Math.max(t0, +o) : null;
    if (inPoint != null && outPoint != null && outPoint <= inPoint) {
      inPoint = null;
      outPoint = null;
    }
    return { inPoint, outPoint };
  }
  /* Project-bin folders: first of each id wins, dangling parents → root. */
  function normalizeFolders(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const f of list) {
      if (!f || !f.id || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({
        id: String(f.id),
        name: String(f.name || "Folder").trim() || "Folder",
        parentId: f.parentId || null,
        open: f.open !== false,
      });
    }
    for (const f of out) if (f.parentId && !seen.has(f.parentId)) f.parentId = null;
    return out;
  }
  function normalizeMediaEntry(m) {
    if (!m || typeof m !== "object") return m;
    return { ...m, folderId: m.folderId || null };
  }
  /* Floor to even ≥ 8 — required for libx264 + yuv420p (chroma 2×2). */
  function evenFloor(n) {
    return Math.max(8, Math.floor(n / 2) * 2);
  }
  /* Delivery crop inside the canvas, even-sized; null = full canvas. */
  function normalizeExportFrame(raw, canvasW, canvasH) {
    if (!raw || typeof raw !== "object") return null;
    let w = Math.round(+raw.w), h = Math.round(+raw.h);
    if (!w || !h || w < 8 || h < 8) return null;
    let x = Math.round(+raw.x || 0), y = Math.round(+raw.y || 0);
    w = evenFloor(Math.min(w, canvasW));
    h = evenFloor(Math.min(h, canvasH));
    x = clamp(x, 0, Math.max(0, canvasW - w));
    y = clamp(y, 0, Math.max(0, canvasH - h));
    if (w >= canvasW && h >= canvasH) return null;
    return { x, y, w, h };
  }
  /* Disabled lanes: only ids in laneIds (a Set or array), unique, sorted. */
  function normalizeDisabledTracks(raw, laneIds) {
    if (raw == null) return [];
    const arr = Array.isArray(raw) ? raw : [];
    const has = new Set(laneIds);
    return [...new Set(arr.filter((id) => has.has(id)))].sort();
  }

  /* ── Lanes ── */
  /* Timeline order: video V-high → V1 on top, then audio A1 → An. Returns a new
     array of the same objects (the app sorts its live track objects with it). */
  function sortTrackDefs(list) {
    const num = (t) => parseInt(t.id.slice(1), 10) || 0;
    const vids = list.filter((t) => t.kind === "video").sort((a, b) => num(b) - num(a));
    const auds = list.filter((t) => t.kind === "audio").sort((a, b) => num(a) - num(b));
    return [...vids, ...auds];
  }
  /* project.tracks → lane defs [{id, kind}]: absent or empty = the defaults;
     entries without an id or a video/audio kind are dropped, first id wins. */
  function normalizeTrackDefs(defs) {
    const raw = Array.isArray(defs) && defs.length
      ? defs.filter((d) => d && d.id && (d.kind === "video" || d.kind === "audio"))
      : DEFAULT_TRACK_DEFS;
    const seen = new Set();
    const list = [];
    for (const d of raw) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      list.push({ id: d.id, kind: d.kind === "audio" ? "audio" : "video" });
    }
    return sortTrackDefs(list);
  }
  /* Add a lane for every clip.track that defs lacks (agents may use V4+ before
     the UI adds it). The kind is guessed: audio clip or an A<n> id → audio.
     Returns defs itself when nothing was added, else a new sorted array. */
  function ensureLanesCoverClips(defs, clips) {
    const ids = new Set(defs.map((d) => d.id));
    const added = [];
    for (const c of clips) {
      if (!c.track || ids.has(c.track)) continue;
      const kind = c.kind === "audio" || /^A\d+$/i.test(c.track) ? "audio" : "video";
      added.push({ id: c.track, kind });
      ids.add(c.track); // one lane per id, however many clips name it
    }
    return added.length ? sortTrackDefs([...defs, ...added]) : defs;
  }
  const serializeTracks = (defs) => defs.map(({ id, kind }) => ({ id, kind }));

  /* ── Load ── */
  function normalizeProject(data, { prevFps = 30 } = {}) {
    const width = data.width || 1280, height = data.height || 720;
    const wa = normalizeWorkArea(data.inPoint, data.outPoint);
    const folders = normalizeFolders(data.folders);
    const media = (data.media || []).map(normalizeMediaEntry);
    const clips = data.clips || [];
    const tracks = ensureLanesCoverClips(normalizeTrackDefs(data.tracks), clips);
    const folderIds = new Set(folders.map((f) => f.id));
    for (const m of media) {
      if (m.folderId && !folderIds.has(m.folderId)) m.folderId = null;
    }
    // One-shot migration for projects saved before props.pan existed. Gated by
    // panSchema so a later write that omits pan:0 (compact MCP / agent rebuild)
    // does not re-hard-pan a deliberately centered stem.
    const migrated = !(data.panSchema >= 1);
    const fonts = new Set();
    for (const c of clips) {
      // agents often omit `in` on text/adjust clips; NaN would poison split/trim
      // math. Only timed kinds have a source position (D5): nothing reads `in`
      // for image/text/adjust, so a stray value there is dropped
      c.in = TIMED_KINDS.includes(c.kind) && Number.isFinite(+c.in) ? +c.in : 0;
      const raw = c.props || {};
      c.props = { ...DEFAULT_PROPS, ...raw };
      if (migrated && !Object.hasOwn(raw, "pan") && Number.isInteger(raw.audioChannel) && raw.audioChannel >= 0)
        c.props.pan = defaultPanForChannel(raw.audioChannel);
      if (c.keyframes) for (const arr of Object.values(c.keyframes))
        if (Array.isArray(arr)) arr.sort((a, b) => a.t - b.t);
      if (c.kind === "text" && c.props.font) fonts.add(c.props.font);
    }
    // AV links aren't always on disk (older saves / agents): keep the groups
    // there are, link the rest by matching timing
    relinkClips(clips);
    return {
      project: {
        name: data.name || "Untitled Project",
        width, height,
        fps: (Number(data.fps) > 0 ? Number(data.fps) : prevFps),
        background: data.background || "#000000",
        revision: data.revision || 0,
        folders, media, clips,
        markers: (data.markers || []).filter((m) => m && isFinite(m.t)).sort((a, b) => a.t - b.t),
        inPoint: wa.inPoint,
        outPoint: wa.outPoint,
        exportFrame: normalizeExportFrame(data.exportFrame, width, height),
        encodeProfile: data.encodeProfile || null,
        tracks,
        disabledTracks: normalizeDisabledTracks(data.disabledTracks, tracks.map((t) => t.id)),
        lockedTracks: normalizeDisabledTracks(data.lockedTracks, tracks.map((t) => t.id)),
        untargetedTracks: normalizeDisabledTracks(data.untargetedTracks, tracks.map((t) => t.id)),
        panSchema: 1,
      },
      fonts: [...fonts],
      migrated,
    };
  }

  /* ── Save ── */
  function serializeProject(project, trackDefs = project.tracks || DEFAULT_TRACK_DEFS) {
    const { name, width, height, fps, background, revision, folders, media, clips, markers, inPoint, outPoint, disabledTracks, encodeProfile } = project;
    const tracks = serializeTracks(trackDefs);
    const out = {
      name, width, height, fps, background, revision,
      panSchema: 1,
      folders: (folders || []).map(({ id, name, parentId, open }) =>
        ({ id, name, parentId: parentId || null, open: open !== false })),
      tracks,
      media: media.filter((m) => !m.transient).map(({ id, name, kind, src, duration, width, height, folderId }) =>
        ({ id, name, kind, src, duration, width, height, folderId: folderId || null })),
      clips: clips.map(({ id, mediaId, kind, track, start, in: inn, duration, name, props, keyframes, transitionIn, transitionOut, linkedId, linkGroup, styleName, locked, disabled, unlinked }) => {
        const clipOut = { id, mediaId, kind, track, start, in: inn, duration, name, props, keyframes, transitionIn, transitionOut };
        if (locked === true) clipOut.locked = true;
        if (disabled === true) clipOut.disabled = true;
        if (unlinked === true) clipOut.unlinked = true;
        if (styleName) clipOut.styleName = styleName; // title style picker reads it back
        if (linkGroup) clipOut.linkGroup = linkGroup;
        if (linkedId) clipOut.linkedId = linkedId;
        return clipOut;
      }),
      markers: (markers || []).map(({ t, label, color }) => ({ t, ...(label ? { label } : {}), ...(color ? { color } : {}) })),
      inPoint: inPoint == null ? null : inPoint,
      outPoint: outPoint == null ? null : outPoint,
      disabledTracks: normalizeDisabledTracks(disabledTracks, tracks.map((t) => t.id)),
    };
    for (const key of ["lockedTracks", "untargetedTracks"]) {
      const lanes = normalizeDisabledTracks(project[key], tracks.map((t) => t.id));
      if (lanes.length) out[key] = lanes;
    }
    const ef = normalizeExportFrame(project.exportFrame, width, height);
    if (ef) out.exportFrame = ef;
    if (encodeProfile) out.encodeProfile = encodeProfile;
    return out;
  }

  /* ── Undo snapshots (docs/specs/0001, D3) ──
     An undo step records the document CONTENT: clips, media and folders.
     Marker edits opt in to markers; ordinary content entries leave them alone.
     IN/OUT, the lane list and lane toggles stay outside history. */
  const snapshotContent = (project, { markers = false } = {}) =>
    JSON.stringify({ clips: project.clips, media: project.media, folders: project.folders,
      ...(markers ? { markers: project.markers || [] } : {}) });
  /* Facts about a file, not edits: a restore keeps the live values. */
  const PROBED = ["duration", "width", "height", "channels"];
  /* Swap snapshot `snap` into `project` in place. Media metadata probed since
     the snapshot and a folder's open / closed state are not undone. Lanes grow
     to cover the restored clips (a lane removed after its clips were deleted
     comes back with them): project.tracks becomes the covering defs.
     laneDefs: the live lane defs (default project.tracks). → the added defs */
  function restoreContent(project, snap, laneDefs = project.tracks || DEFAULT_TRACK_DEFS) {
    const s = JSON.parse(snap);
    if (Object.hasOwn(s, "markers")) project.markers = s.markers;
    const media = new Map((project.media || []).map((m) => [m.id, m]));
    const folders = new Map((project.folders || []).map((f) => [f.id, f]));
    project.clips = s.clips || [];
    project.media = (s.media || []).map((m) => {
      const live = media.get(m.id);
      if (live) for (const k of PROBED) if (live[k] != null) m[k] = live[k];
      return m;
    });
    project.folders = (s.folders || []).map((f) => (folders.has(f.id) ? { ...f, open: folders.get(f.id).open } : f));
    const covered = ensureLanesCoverClips(laneDefs, project.clips);
    if (covered === laneDefs) return [];
    const had = new Set(laneDefs.map((d) => d.id));
    project.tracks = serializeTracks(covered);
    return project.tracks.filter((d) => !had.has(d.id));
  }

  return Object.freeze({
    DEFAULT_TRACK_DEFS, TIMELINE_START_TIME,
    normalizeWorkArea, normalizeFolders, normalizeMediaEntry, evenFloor, normalizeExportFrame,
    normalizeDisabledTracks,
    sortTrackDefs, normalizeTrackDefs, ensureLanesCoverClips, serializeTracks,
    normalizeProject, serializeProject,
    snapshotContent, restoreContent,
  });
});
