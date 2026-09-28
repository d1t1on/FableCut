/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — the patch interpreter: targeted edit ops on project.json,
   shared by MCP fablecut_patch_project and REST POST /api/patch.

   Dual-mode classic script, loaded after core/schema.js, core/keyframes.js,
   core/links.js, core/edit.js, core/project.js, core/summary.js and
   core/validate.js: a <script> tag exposes FableCore.patch, Node require()s
   it. Pure — it never reads or writes a file; callers own the disk, the
   revision bump and the atomic write.

   OPS — one row per op: { name, params, doc, timeline?, run(doc, op, ctx) → note }.
     The table is the single source for the tool description (describeOps),
     the unknown-op error, TIMELINE_OPS, and the contract tests that the docs
     name every op. Adding an op = adding a row + a test + a CLAUDE.md
     mention. A row edits `doc` in place, throws an Error whose message the
     agent reads, and returns a short note ("+c_x", "~c_a", "-m_b",
     "~project", "split at 4s: c_v→+c_x, c_l→+c_y").

   Timeline ops (rows with timeline: true — TIMELINE_OPS — and removeClip
   {linked:true}) are the editor's own edits: each calls core/edit exactly as
   app.js's wrapper does for the same UI action (split at playhead with a
   selection, trim to playhead, the move drag without snapping, close gap,
   the inspector's start / length, Delete), so the result equals the
   editor's (INV-15). Their ctx comes from the doc: isEnabled from
   doc.disabledTracks, the lanes the editor would show (tracks, else the
   defaults, plus any lane a clip uses), MIN_DUR, ids from ctx.newId /
   ctx.newLinkId, and a no-op beforeChange (undo history is the UI's; an
   external write resets it). First they read the doc the way the editor
   loads it: a missing `in` is 0 (counted like addClip's) and links are
   completed by links.relinkClips (D1: a legacy linkedId pair, or an ungrouped
   audio clip matching a video's media and timing, becomes a group — what the
   editor writes on its next save), so they see the groups the editor sees.

   patchProject(disk, ops, ctx) → { ok, dryRun, doc, notes, defaulted,
       newErrors, newWarnings, diff, error }
     Runs `ops` in order on a deep copy of `disk`. All-or-nothing: the first
     op that throws stops the patch (ok:false, error = its message, doc:null).
     Then the validation gate: ok is false when the result has an error
     `disk` did not have (newErrors, error = the REJECTED text), so a problem
     already on disk never blocks an unrelated edit. newWarnings are the
     warnings the patch added; diff is summary.diffProjects(disk, doc).
   ctx — supplied by the caller, never read from globals:
     newId(prefix = "c_")  fresh id ("c_…" for clips, called with "m_" for
                           media); an id already in the doc (as an id or a
                           linkGroup) is skipped, so a plain counter works and
                           makes the result deterministic
     newLinkId()           fresh linkGroup id ("lg_…") for ops that link
     checkProfile(id)      optional; throws on an unknown encodeProfile id
                           (the encoding-profiles file lives server-side)
     dryRun                only marks the result; nothing here ever writes
     diffLimit             diff lines before "… +N more" (default 20)

   gate(before, candidate, what) is the validation gate on its own, for
   callers that replace the whole document (fablecut_set_project).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports)
    module.exports = factory(require("./schema.js"), require("./keyframes.js"), require("./links.js"),
      require("./edit.js"), require("./project.js"), require("./summary.js"), require("./validate.js"));
  else {
    const core = root.FableCore || {};
    // in index.html order, so the first missing one is named
    for (const dep of ["schema", "keyframes", "links", "edit", "project", "summary", "validate"])
      if (!core[dep]) throw new Error(`core/${dep}.js must load before core/patch.js`);
    root.FableCore.patch = factory(core.schema, core.keyframes, core.links, core.edit, core.project, core.summary, core.validate);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (S, K, L, E, P, Sum, V) {
  "use strict";
  const { PATCHABLE_PROJECT_FIELDS, MIN_DUR } = S;
  const { clipEnd } = K;
  const { withLinked, relinkClips } = L;
  const { normalizeTrackDefs, ensureLanesCoverClips, serializeTracks } = P;
  const { diffProjects } = Sum;
  const { validateProject, newErrors, issueKey, formatIssues } = V;

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  /* ops come from JSON, so a JSON copy is exact; it also keeps the caller's
     op objects out of the document */
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  /* path.basename for a URL path: the last "/" segment, decoded */
  const baseName = (src) => {
    const s = decodeURIComponent(src).replace(/\/+$/, "");
    return s.slice(s.lastIndexOf("/") + 1);
  };

  /* Agents often omit `in` (text/adjust clips especially); the editor assumes 0. */
  function defaultIn(clips) {
    let n = 0;
    for (const c of clips) if (isObj(c) && (c.in === undefined || c.in === null)) { c.in = 0; n++; }
    return n;
  }

  /* updateClip: top-level keys replaced, props merged key by key, null deletes */
  function mergeInto(target, set) {
    for (const [k, v] of Object.entries(set || {})) {
      if (v === null) delete target[k];
      else if (k === "props" && target.props && typeof v === "object" && !Array.isArray(v)) {
        for (const [pk, pv] of Object.entries(v)) {
          if (pv === null) delete target.props[pk]; else target.props[pk] = pv;
        }
      } else target[k] = v;
    }
  }

  /* ── Timeline ops: helpers ── */
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const sec = (t) => r3(t) + "s";
  const signed = (d) => (d >= 0 ? "+" : "") + sec(d);
  const ids = (list, mark = "~") => list.map((c) => mark + c.id).join(" ");
  function clipOf(doc, id, name) {
    const c = arr(doc.clips).find((x) => isObj(x) && x.id === id);
    if (!c) throw new Error(`${name}: no clip ${id}`);
    return c;
  }
  function seconds(op, key, name) {
    const v = op[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} needs ${key}: a number of seconds (got ${JSON.stringify(v)})`);
    return v;
  }
  const span = (c) => `${c.id} spans ${sec(c.start)}–${sec(clipEnd(c))}`;
  const an = (w) => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;
  /* The lanes the editor shows, in display order (V-high → V1, A1 → An):
     tracks (else the defaults) plus any lane a clip already uses. */
  const editorLanes = (doc) => ensureLanesCoverClips(normalizeTrackDefs(doc.tracks), doc.clips);
  /* Read the doc as the editor loads it, then hand out core/edit's ctx. */
  function timeline(doc, rc, name) {
    if (!Array.isArray(doc.clips) || !doc.clips.every(isObj))
      throw new Error(`${name}: project.clips must be an array of clip objects — fablecut_validate names the bad entry`);
    rc.defaulted += defaultIn(doc.clips);
    relinkClips(doc.clips);
    return {
      newId: () => rc.newId("c_"), newLinkId: () => rc.newLinkId(),
      isEnabled: (lane) => !arr(doc.disabledTracks).includes(lane),
      minDur: MIN_DUR,
      beforeChange() {}, // undo is the UI's own; an external write resets its history
    };
  }
  /* splitClip's selection: [id] | ids | [] (all: every clip crossing t) */
  function splitSelection(doc, op) {
    if ([op.id !== undefined, op.ids !== undefined, op.all === true].filter(Boolean).length !== 1)
      throw new Error("splitClip needs exactly one of id, ids:[…] or all:true (every clip crossing t)");
    if (op.all === true) return [];
    const list = op.ids !== undefined ? op.ids : [op.id];
    if (!Array.isArray(list) || !list.length) throw new Error("splitClip: ids must be a non-empty array of clip ids");
    for (const id of list) clipOf(doc, id, "splitClip");
    return list;
  }
  /* moveClip's lane: one the editor shows (a drop target), of the clip's kind —
     the UI ignores any other drop, the op refuses it. */
  function laneFor(doc, c, id) {
    const lanes = editorLanes(doc);
    const lane = lanes.find((l) => l.id === id);
    if (!lane) {
      const tracks = serializeTracks(lanes).concat({ id, kind: String(id)[0] === "A" ? "audio" : "video" });
      throw new Error(`moveClip: no lane ${JSON.stringify(id)} (lanes: ${lanes.map((l) => l.id).join(" ")}) — ` +
        `declare it first, in the same patch: {op:"setProject", set:{tracks:${JSON.stringify(tracks)}}}`);
    }
    if ((c.kind === "audio") !== (lane.kind === "audio"))
      throw new Error(`moveClip: ${c.id} is ${an(c.kind)} clip and ${id} is ${an(lane.kind)} lane — ` +
        "audio clips go on A lanes, every other kind on V lanes");
    return id;
  }
  const CLOSE_GAP_HINT = {
    "no-lanes": " (every lane is in disabledTracks)",
    covered: " (disable it with setProject disabledTracks, or pick another t)",
    nothing: " (t must sit in a gap every enabled lane shares, with clips after it)",
  };

  const OPS = [
    {
      name: "addClip",
      params: "clip:{kind, track, start, duration, mediaId, …}",
      doc: "add a clip; id auto-generated if omitted, a missing `in` defaults to 0",
      run(doc, op, ctx) {
        const c = clone(op.clip);
        if (!c || !c.track || typeof c.start !== "number" || typeof c.duration !== "number")
          throw new Error("addClip needs clip{track, start, duration}");
        c.id = c.id || ctx.newId("c_");
        if (doc.clips.some((x) => x.id === c.id))
          throw new Error(`addClip: duplicate clip id ${c.id} (DUP_CLIP_ID) — omit id to get a fresh one`);
        if (c.kind !== "text" && c.kind !== "adjust" && !doc.media.some((m) => m.id === c.mediaId))
          throw new Error(`addClip: unknown mediaId ${c.mediaId} (${c.mediaId == null ? "MEDIA_REQUIRED" : "MEDIA_NOT_FOUND"}) — addMedia it first, or use an id from fablecut_get_project {compact:true}`);
        ctx.defaulted += defaultIn([c]);
        doc.clips.push(c);
        return "+" + c.id;
      },
    },
    {
      name: "updateClip",
      params: "id, set:{…}",
      doc: "merge into a clip: top-level keys are replaced (keyframes/transitionIn/transitionOut wholesale), " +
        "`props` merges key by key, null deletes a key, `id` is immutable",
      run(doc, op) {
        const c = doc.clips.find((x) => x.id === op.id);
        if (!c) throw new Error("updateClip: no clip " + op.id);
        // ids are what every other op, link and selection refer to
        if (isObj(op.set) && Object.hasOwn(op.set, "id") && op.set.id !== op.id)
          throw new Error(`updateClip: clip ids are immutable (can't change ${op.id} to ${op.set.id}) — removeClip it and addClip a copy under the new id`);
        mergeInto(c, clone(op.set));
        return "~" + op.id;
      },
    },
    {
      name: "removeClip",
      params: "id, linked?",
      doc: "delete that one clip (its link partners stay); linked:true deletes its whole link group, like the editor's Delete",
      run(doc, op, rc) {
        if (op.linked !== undefined && typeof op.linked !== "boolean") throw new Error("removeClip: linked must be true or false");
        if (op.linked) {
          const c = clipOf(doc, op.id, "removeClip");
          return E.removeClips(doc, [c], timeline(doc, rc, "removeClip")).removed.map((id) => "-" + id).join(" ");
        }
        const n = doc.clips.length;
        doc.clips = doc.clips.filter((x) => x.id !== op.id);
        if (doc.clips.length === n) throw new Error("removeClip: no clip " + op.id);
        return "-" + op.id;
      },
    },
    {
      name: "addMedia",
      params: "media:{src, kind, …}",
      doc: "register a media entry; id auto-generated if omitted, name defaults to the src file name",
      run(doc, op, ctx) {
        const m = clone(op.media);
        if (!m || !m.src || !m.kind) throw new Error("addMedia needs media{src, kind}");
        m.id = m.id || ctx.newId("m_");
        if (doc.media.some((x) => x.id === m.id))
          throw new Error(`addMedia: duplicate media id ${m.id} (DUP_MEDIA_ID) — omit id to get a fresh one`);
        m.name = m.name || baseName(m.src);
        doc.media.push(m);
        return "+" + m.id;
      },
    },
    {
      name: "removeMedia",
      params: "id",
      doc: "unregister media that no clip uses",
      run(doc, op) {
        const used = doc.clips.find((c) => c.mediaId === op.id);
        if (used) throw new Error(`removeMedia: media ${op.id} is used by clip ${used.id}`);
        const n = doc.media.length;
        doc.media = doc.media.filter((x) => x.id !== op.id);
        if (doc.media.length === n) throw new Error("removeMedia: no media " + op.id);
        return "-" + op.id;
      },
    },
    {
      name: "splitClip",
      timeline: true,
      params: "id | ids:[…] | all:true, t",
      doc: "cut at time t like the editor's split: that clip, those clips, or (all) every clip crossing t — each with its " +
        "link group; the right pieces get new ids, and source time, speed ramps, keyframes and transitions stay right",
      run(doc, op, rc) {
        const sel = splitSelection(doc, op);
        const t = seconds(op, "t", "splitClip");
        const r = E.splitAt(doc, t, { selIds: new Set(sel) }, timeline(doc, rc, "splitClip"));
        if (!r.changed) {
          const where = sel.length
            ? sel.slice(0, 4).map((id) => span(clipOf(doc, id))).join(", ") + (sel.length > 4 ? ", …" : "") + "; t must fall inside"
            : "no clip crosses it; t must fall inside a clip";
          throw new Error(`splitClip: nothing to split at ${sec(t)} — ${where}, more than ${MIN_DUR}s from its edges`);
        }
        return `split at ${sec(t)}: ` + r.from.map((id, i) => `${id}→+${r.created[i].id}`).join(", ");
      },
    },
    {
      name: "trimClip",
      timeline: true,
      params: 'id, side:"in"|"out", t',
      doc: "trim the head (in) or tail (out) to time t, like the editor's trim to playhead: the whole link group, " +
        "keyframes stay where they play, the trimmed edge loses its transition",
      run(doc, op, rc) {
        const c = clipOf(doc, op.id, "trimClip");
        if (op.side !== "in" && op.side !== "out")
          throw new Error('trimClip needs side: "in" (the head moves to t) or "out" (the tail moves to t)');
        const t = seconds(op, "t", "trimClip");
        const ctx = timeline(doc, rc, "trimClip");
        const group = withLinked(doc.clips, [c]), was = span(c);
        const r = E.trimClipTo(doc, c, t, op.side, ctx);
        if (r.reason === "at-start")
          throw new Error(`trimClip: ${sec(t)} is at or before the start of ${c.id} (${sec(c.start)}) — "in" moves the head later; to move the clip use moveClip`);
        if (!r.changed)
          throw new Error(`trimClip: nothing to trim at ${sec(t)} — ${was}; t must fall inside it, more than ${MIN_DUR}s ` +
            `from its ${op.side === "in" ? "end" : "start"} (to lengthen a clip use setTiming)`);
        return `trimmed ${c.id} ${op.side} to ${sec(t)}: ${ids(group)}`;
      },
    },
    {
      name: "moveClip",
      timeline: true,
      params: "id, start | dt, track?",
      doc: "move the clip and its link group like a timeline drag without snapping: to start, or by dt seconds " +
        "(clamped at 0); track moves only this clip, onto an existing lane of its kind",
      run(doc, op, rc) {
        const c = clipOf(doc, op.id, "moveClip");
        const hasStart = op.start !== undefined, hasDt = op.dt !== undefined;
        if (hasStart && hasDt) throw new Error("moveClip takes start or dt, not both");
        if (!hasStart && !hasDt && op.track === undefined) throw new Error("moveClip needs start or dt (seconds), and/or track");
        const dt = hasStart ? seconds(op, "start", "moveClip") - c.start : hasDt ? seconds(op, "dt", "moveClip") : 0;
        timeline(doc, rc, "moveClip");
        const lane = op.track === undefined ? null : laneFor(doc, c, op.track);
        const from = c.start, track0 = c.track;
        const drag = E.beginDrag(doc, c, "move");
        E.dragTo(doc, drag, dt, { minDur: MIN_DUR }); // no ctx.snap: nothing to snap to
        if (lane) c.track = lane; // like the drop: the partners keep their lanes
        const d = c.start - from, what = [];
        if (dt) what.push(`by ${signed(d)} to ${sec(c.start)}${Math.abs(d - dt) > 1e-9 ? " (clamped at 0)" : ""}`);
        if (c.track !== track0) what.push(`lane ${track0}→${c.track}`);
        if (!d && c.track === track0) return `${c.id} unchanged`;
        return `moved ${c.id} ${what.join(", ")}: ${ids(d ? drag.group : [c])}`;
      },
    },
    {
      name: "closeGap",
      timeline: true,
      params: "t",
      doc: "close the gap at time t like the editor's close gap: every enabled lane must be empty at t; later clips on " +
        "enabled lanes shift left by the gap every lane shares, with their link groups",
      run(doc, op, rc) {
        const t = seconds(op, "t", "closeGap");
        const ctx = timeline(doc, rc, "closeGap");
        const lanes = editorLanes(doc).map((l) => l.id).filter(ctx.isEnabled); // display order, like the UI
        const starts = new Map(doc.clips.map((c) => [c, c.start]));
        const r = E.closeGapAt(doc, t, lanes, ctx);
        if (!r.changed) throw new Error(`closeGap at ${sec(t)}: ${E.closeGapMessage(r)}${CLOSE_GAP_HINT[r.reason]}`);
        return `closed ${sec(r.gap)} gap at ${sec(t)}: ${ids(doc.clips.filter((c) => c.start !== starts.get(c)))}`;
      },
    },
    {
      name: "setTiming",
      timeline: true,
      params: "id, start?, duration?",
      doc: `set start and/or duration like the inspector: the whole link group takes them (start ≥ 0, duration ≥ ${MIN_DUR}), ` +
        "and the partners take the clip's in and speed; keyframes keep their clip-local times",
      run(doc, op, rc) {
        const c = clipOf(doc, op.id, "setTiming");
        if (op.start === undefined && op.duration === undefined) throw new Error("setTiming needs start and/or duration (seconds)");
        const want = {};
        for (const k of ["start", "duration"]) if (op[k] !== undefined) want[k] = seconds(op, k, "setTiming");
        const ctx = timeline(doc, rc, "setTiming");
        const group = withLinked(doc.clips, [c]);
        if (!E.setClipTiming(doc, c, want, ctx).changed) return `${c.id} unchanged`;
        const clamped = Object.keys(want).filter((k) => c[k] !== want[k]);
        return `timing ${c.id}${clamped.length ? ` (${clamped.join(", ")} clamped)` : ""}: ${ids(group)}`;
      },
    },
    {
      name: "setProject",
      params: `set:{${PATCHABLE_PROJECT_FIELDS.join("|")}}`,
      doc: "change project fields; null deletes one",
      run(doc, op, ctx) {
        for (const [k, v] of Object.entries(op.set || {})) {
          if (!PATCHABLE_PROJECT_FIELDS.includes(k))
            throw new Error(`setProject: '${k}' not settable (allowed: ${PATCHABLE_PROJECT_FIELDS.join(", ")})`);
          if (k === "encodeProfile" && v != null && ctx.checkProfile) ctx.checkProfile(String(v));
          if (v === null) delete doc[k]; else doc[k] = clone(v);
        }
        return "~project";
      },
    },
  ];
  const opNames = () => OPS.map((o) => o.name);
  /* the editor's own edits — what agents should prefer to hand-computed updateClip / addClip */
  const TIMELINE_OPS = OPS.filter((o) => o.timeline).map((o) => o.name);

  /* The ops part of the patch tool description, one line per row. */
  const describeOps = () => OPS.map((o) => `- {op:'${o.name}', ${o.params}} — ${o.doc}`).join("\n");

  function findOp(op) {
    const row = isObj(op) ? OPS.find((o) => o.name === op.op) : undefined;
    if (!row) throw new Error(`Unknown op: ${isObj(op) ? op.op : JSON.stringify(op)} (${opNames().join("|")})`);
    return row;
  }

  /* The validation gate: errors `candidate` adds over `before` (the issues of
     the doc on disk) refuse the write; warnings it adds are reported. */
  function gate(before, candidate, what = "patch") {
    const after = validateProject(candidate);
    const added = newErrors(before, after);
    const had = new Set(arr(before).filter((i) => i.severity === "warning").map(issueKey));
    const newWarnings = after.filter((i) => i.severity === "warning" && !had.has(issueKey(i)));
    const message = added.length ? (
      `REJECTED — nothing saved. This ${what} would add ${plural(added.length, "validation error")}:\n` +
      formatIssues(added, { limit: 20 }) + "\n" +
      `Fix the field(s) above (follow the hint after "—" where there is one) and resend the ${what === "patch" ? "whole patch — it is all-or-nothing, so none of its ops were applied" : "complete document"}. ` +
      `Problems already in project.json never block an edit; only new ones do. ` +
      `Check a candidate without saving: fablecut_validate {project}. Codes: fablecut_docs {section:"Validation"}.`) : null;
    return { newErrors: added, newWarnings, message };
  }
  /* The tail of a success message: the `in` defaulting and new warnings. */
  function gateNotes({ defaulted = 0, newWarnings = [], dryRun = false }) {
    return (defaulted ? ` Defaulted in:0 on ${plural(defaulted, "clip")}.` : "") +
      (newWarnings.length
        ? `\nNew warnings (${newWarnings.length}) — ${dryRun ? "would not block" : "saved anyway"}, worth fixing:\n${formatIssues(newWarnings, { limit: 10 })}`
        : "");
  }

  /* What rows see: the caller's factories, made collision-safe, plus the
     `in`-defaulting count. */
  function runCtx(doc, ctx) {
    // taken = some clip or media already uses it as its id or linkGroup
    const taken = (id) => arr(doc.clips).concat(arr(doc.media)).some((e) => isObj(e) && (e.id === id || e.linkGroup === id));
    const fresh = (key) => (...args) => {
      if (typeof ctx[key] !== "function") throw new TypeError(`FableCore.patch: ctx.${key} must be a function`);
      for (let i = 0; i < 100; i++) { const id = ctx[key](...args); if (!taken(id)) return id; }
      throw new Error(`FableCore.patch: ctx.${key} returned 100 ids already in use`);
    };
    return { defaulted: 0, checkProfile: ctx.checkProfile, newId: fresh("newId"), newLinkId: fresh("newLinkId") };
  }

  function patchProject(disk, ops, ctx = {}) {
    const res = { ok: false, dryRun: !!ctx.dryRun, doc: null, notes: [], defaulted: 0,
      newErrors: [], newWarnings: [], diff: [], error: null };
    if (!Array.isArray(ops) || !ops.length) { res.error = "`ops` must be a non-empty array"; return res; }
    const before = validateProject(disk);
    let doc = clone(disk);
    const rc = runCtx(doc, ctx);
    try {
      for (const op of ops) res.notes.push(findOp(op).run(doc, op, rc));
    } catch (e) {
      res.notes = [];
      res.error = e instanceof Error ? e.message : String(e);
      return res;
    }
    // gate and diff what will be saved: core/edit clears a field by setting it
    // undefined (a cut edge's transition), which only JSON drops
    doc = clone(doc);
    const g = gate(before, doc, "patch");
    Object.assign(res, {
      doc, defaulted: rc.defaulted, newErrors: g.newErrors, newWarnings: g.newWarnings,
      diff: diffProjects(disk, doc, { limit: ctx.diffLimit ?? 20 }),
      ok: !g.message, error: g.message,
    });
    return res;
  }

  /* The fablecut_patch_project result text for an ok patch; `revision` is
     the one the caller saved (or, on a dry run, would save). */
  function formatPatch(res, { revision }) {
    const d = res.doc;
    return (res.dryRun ? "DRY RUN — nothing saved.\n" : "") +
      `Patched (revision ${revision}): ${res.notes.join("; ")}. Now ${d.clips.length} clip(s), ${d.media.length} media.` +
      (res.dryRun ? "" : " UI hot-reloaded.") + gateNotes(res) +
      (res.diff.length ? "\nChanges:\n" + res.diff.map((l) => "  " + l).join("\n") : "\nChanges: none");
  }

  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  return deepFreeze({ OPS, TIMELINE_OPS, describeOps, patchProject, formatPatch, gate, gateNotes, defaultIn });
});
