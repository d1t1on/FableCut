/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — compact text views of a project: the one-line-per-clip
   summary agents plan from, and the diff an edit reports back.

   Dual-mode classic script, loaded after core/schema.js: a <script> tag
   exposes FableCore.summary, Node require()s it. Pure — no DOM, no Node APIs.

   compactClipLine(clip, defaults?)   "c_a V1 0s+5s video(m_a in:2) link:lg_a "name" {…} kf:… in:fade/0.8"
                                      props equal to `defaults` (DEFAULT_PROPS) are hidden:
                                      the UI persists every default on every clip; link: is
                                      the linkGroup (split / trim / move act on the whole group)
   compactProject(doc)                the text fablecut_get_project {compact:true} prints
   diffProjects(before, after, {limit})
     → string[], one line per changed thing, deterministic order:
         project <field>: old→new            top-level fields (not clips/media/revision)
         -<id>                               media / clip removed
         ~<id> <field>: old→new, …           media / clip changed — timing, lane,
                                             media, props.<k>, kf.<channel> (key
                                             count), transitions, any other field
         +<compact line>                     media / clip added
       project lines first, then media, then clips; within each, removals in
       `before` order, then changes and additions in `after` order. Past
       `limit` lines (default 20) the rest collapse into "… +N more".
   ∅ marks an absent value.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports) module.exports = factory(require("./schema.js"));
  else {
    const core = root.FableCore || {};
    if (!core.schema) throw new Error("core/schema.js must load before core/summary.js");
    root.FableCore.summary = factory(core.schema);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (S) {
  "use strict";
  const { DEFAULT_PROPS } = S;

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const r3 = (n) => Math.round(n * 1000) / 1000;
  /* #abc ≡ #aabbcc ≡ #AABBCC, so a default color written another way still hides */
  const hex = (v) => typeof v === "string" && /^#[0-9a-f]{3}$/i.test(v)
    ? "#" + [...v.slice(1)].map((c) => c + c).join("").toLowerCase()
    : (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : v);

  function fmtProps(o, kind, defaults) {
    if (!o) return "";
    const kept = {};
    for (const [k, v] of Object.entries(o)) {
      if (kind !== "text" && k === "text" && v === "Title") continue;
      // pan on a linked stem is meaningful even at 0 (center): an agent
      // rebuilding from the compact view must not lose it
      if (k === "pan" && Number.isInteger(o.audioChannel) && o.audioChannel >= 0) {
        kept[k] = v;
        continue;
      }
      if (hex(defaults[k]) !== hex(v)) kept[k] = v;
    }
    return Object.keys(kept).length ? " " + JSON.stringify(kept) : "";
  }
  const fmtTrans = (t) => `${t.type}/${t.duration}`;

  function compactClipLine(c, defaults = DEFAULT_PROPS) {
    const kf = c.keyframes ? " kf:" + Object.entries(c.keyframes).map(([k, v]) => `${k}(${v?.length ?? 0})`).join(",") : "";
    const tr = (c.transitionIn ? ` in:${fmtTrans(c.transitionIn)}` : "") +
               (c.transitionOut ? ` out:${fmtTrans(c.transitionOut)}` : "");
    return `${c.id} ${c.track} ${r3(c.start)}s+${r3(c.duration)}s ${c.kind}` +
      (c.mediaId ? `(${c.mediaId}${c.in ? ` in:${r3(c.in)}` : ""})` : "") +
      (c.linkGroup ? ` link:${c.linkGroup}` : "") +
      ["locked", "disabled", "unlinked"].filter((k) => c[k] === true).map((k) => ` [${k}]`).join("") +
      (c.name ? ` "${c.name}"` : "") + fmtProps(c.props, c.kind, defaults) + kf + tr;
  }
  const compactMediaLine = (m) => `${m.id} ${m.kind} "${m.name}"${m.duration ? " " + m.duration + "s" : ""}`;

  function compactProject(doc) {
    return [
      `"${doc.name}" ${doc.width}x${doc.height}@${doc.fps} rev:${doc.revision}` +
      (doc.panSchema >= 1 ? " panSchema:1" : "") +
      (doc.background ? ` bg:${doc.background}` : "") +
      ["lockedTracks", "untargetedTracks"].filter((k) => doc[k]?.length).map((k) => ` ${k}:[${doc[k].join(",")}]`).join("") +
      (doc.markers?.length ? ` markers:${doc.markers.length} [${doc.markers.slice(0, 12).map((m) => m.t).join(",")}${doc.markers.length > 12 ? ",…" : ""}]` : ""),
      `MEDIA (${doc.media.length}):`,
      ...doc.media.map((m) => "  " + compactMediaLine(m)),
      `CLIPS (${doc.clips.length}), by track/time:`,
      ...doc.clips
        .slice()
        .sort((a, b) => (a.track === b.track ? a.start - b.start : String(a.track).localeCompare(b.track)))
        .map((c) => "  " + compactClipLine(c)),
      `(compact view — full JSON: fablecut_get_project without compact; edit via fablecut_patch_project)`,
    ].join("\n");
  }

  /* ── diff ── */
  const NONE = "∅";
  const json = (v) => (v === undefined ? NONE : String(JSON.stringify(v)));
  /* long arrays/objects shrink to a count so one field can't flood the diff */
  function val(v) {
    const s = json(v);
    if (s.length <= 60) return s;
    return Array.isArray(v) ? `[${v.length} items]` : s.slice(0, 59) + "…";
  }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? String(r3(v)) : val(v));
  const trans = (t) => (isObj(t) && t.type !== undefined ? fmtTrans(t) : val(t));
  const kfCount = (v) => (Array.isArray(v) ? String(v.length) : val(v));
  const same = (a, b) => json(a) === json(b);
  const arr = (v) => (Array.isArray(v) ? v : []);

  /* per entity: fields shown first, in this order, with their formatter; then
     the nested maps key by key (props.<k>, kf.<channel>); then any other key */
  const CLIP = {
    fields: { track: val, start: num, duration: num, in: num, kind: val, mediaId: val, name: val,
      linkGroup: val, transitionIn: trans, transitionOut: trans },
    nested: { props: ["props.", val], keyframes: ["kf.", kfCount] },
  };
  const MEDIA = {
    fields: { kind: val, name: val, src: val, duration: num, width: num, height: num, folderId: val },
    nested: {},
  };
  const union = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const mapOrNone = (v) => v === undefined || isObj(v);

  /* "field: old→new" for each field that differs */
  function fieldChanges(a, b, { fields, nested }) {
    const out = [];
    const put = (label, x, y, f) => { if (!same(x, y)) out.push(`${label}: ${f(x)}→${f(y)}`); };
    for (const [k, f] of Object.entries(fields)) put(k, a[k], b[k], f);
    for (const [k, [prefix, f]] of Object.entries(nested)) {
      // a malformed map (props: 3) is shown whole rather than walked
      if (!mapOrNone(a[k]) || !mapOrNone(b[k])) { put(k, a[k], b[k], val); continue; }
      const x = a[k] || {}, y = b[k] || {};
      for (const p of union(x, y).sort()) put(prefix + p, x[p], y[p], f);
    }
    const shown = new Set(["id", ...Object.keys(fields), ...Object.keys(nested)]);
    for (const k of union(a, b).filter((k) => !shown.has(k)).sort()) put(k, a[k], b[k], val);
    return out;
  }

  /* Entities are matched by id; a repeated id (a DUP_*_ID error already on
     disk) is told apart by its occurrence, so nothing silently merges. */
  function keyed(list) {
    const seen = new Map(), out = new Map();
    for (const e of arr(list)) {
      const o = isObj(e) ? e : {};
      const id = String(o.id), n = seen.get(id) || 0;
      seen.set(id, n + 1);
      out.set(n ? `${id}#${n}` : id, o);
    }
    return out;
  }
  function diffList(before, after, spec, line) {
    const a = keyed(before), b = keyed(after), out = [];
    for (const [k] of a) if (!b.has(k)) out.push("-" + k);
    for (const [k, e] of b) {
      if (!a.has(k)) { out.push("+" + line(e)); continue; }
      const ch = fieldChanges(a.get(k), e, spec);
      if (ch.length) out.push(`~${k} ${ch.join(", ")}`);
    }
    return out;
  }

  function diffProjects(before, after, { limit = 20 } = {}) {
    const a = isObj(before) ? before : {}, b = isObj(after) ? after : {};
    const lines = [];
    for (const k of union(a, b).filter((k) => !["clips", "media", "revision"].includes(k)).sort())
      if (!same(a[k], b[k])) lines.push(`project ${k}: ${val(a[k])}→${val(b[k])}`);
    lines.push(...diffList(a.media, b.media, MEDIA, compactMediaLine));
    lines.push(...diffList(a.clips, b.clips, CLIP, (c) => compactClipLine(c)));
    return lines.length > limit ? lines.slice(0, limit).concat(`… +${lines.length - limit} more`) : lines;
  }

  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  return deepFreeze({ compactClipLine, compactProject, diffProjects });
});
