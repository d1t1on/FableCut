/* Edit-op sequences for property tests, run through the real core ops.

   An op is a plain descriptor { op, …fractions } whose parameters are
   LATE-BOUND: each fraction u ∈ [0, 1] is resolved against the document as it
   is when the op runs (which clip, where inside it, which gap, which lane), so
   a sequence stays meaningful however earlier ops reshaped the doc, and
   shrinks toward u = 0 ("the first clip, at its start").

   A session mirrors how app.js wires core/edit.js (see its wrappers
   splitAtPlayhead, trimToPlayhead, closeGapAtPlayhead, startClipGesture, …):
     doc      normalizeProject(raw).project — what the editor holds
     ctx      deterministic ids (c_n1, lg_n2, …), isEnabled from
              doc.disabledTracks, MIN_DUR, and beforeChange = pushUndo
     history  a core/history instance; a snapshot is core/project
              snapshotContent(doc) (clips, media, folders — D3), restored
              with restoreContent, exactly app.js's pushUndo / undo / redo
   Ops: split (all / a selection), splitAtWorkArea, trimToPlayhead in/out,
   trimToWorkArea, closeGap, delete, drag move / trim-l / trim-r (beginDrag +
   dragTo, pushing the pointerdown snapshot like the gesture's onUp — only
   when the doc changed), toggleLane (no undo entry, like
   toggleTrackEnabled), undo, redo, removeMedia (the bin's delete button,
   core removeMedia), and setTiming (an inspector start / length edit through
   core setClipTiming, or a speed write at a playhead inside the clip through
   setAnimProp + syncLinkedSpeed, like app.js applyInspectorField). The last
   two are in no family: the properties that use them name them.

   Every op appends a readable line to session.log; play() appends the log and
   the clips to an assertion's message, so a shrunk counterexample reads as a
   script. Clips carry a Symbol lineage tag (ORIGIN) while an op runs: object
   spread copies it onto split pieces, JSON (snapshots, validation) never sees
   it. */
"use strict";
const { fc } = require("./fc");
const E = require("../../core/edit");
const K = require("../../core/keyframes");
const P = require("../../core/project");
const { syncLinkedSpeed } = require("../../core/links");
const { createHistory } = require("../../core/history");
const { clipEnd } = K;
const { MIN_DUR } = require("../../core/schema");
const { loadProject } = require("./arb");

const ORIGIN = Symbol("origin");
const PPS = 60, DRAG_PX = 3; // app.js: state.pps default; a drag counts after > 3 px of pointer motion
const q = (t) => Math.round(t * 1000) / 1000;
const num = (t) => String(+t.toFixed(4));
const pick = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))];
const projEnd = (doc) => doc.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

function idFactory(prefix = "n") {
  let n = 0;
  return { newId: () => `c_${prefix}${++n}`, newLinkId: () => `lg_${prefix}${++n}` };
}

function createSession(raw, { prefix } = {}) {
  const ids = idFactory(prefix);
  const s = { raw, ids, history: createHistory({ limit: 100 }), log: [] };
  s.doc = loadProject(raw);
  s.snapshot = () => P.snapshotContent(s.doc); // app.js pushUndo
  s.isEnabled = (lane) => !s.doc.disabledTracks.includes(lane);
  s.enabledLanes = () => s.doc.tracks.filter((t) => s.isEnabled(t.id)).map((t) => t.id); // display order
  s.ctx = { ...ids, isEnabled: s.isEnabled, minDur: MIN_DUR, beforeChange: () => s.history.push(s.snapshot()) };
  return s;
}

const refused = (reason) => ({ changed: false, created: [], removed: [], reason });
const ok = (extra) => ({ changed: true, created: [], removed: [], ...extra });

/* ── Ops: (session, args) → { line, r, info? } ── */
function drag(mode) {
  return (s, a) => {
    const c = pick(s.doc.clips, a.clip);
    if (!c) return { line: mode, r: refused("no-clip") };
    // dt ranges that reach past both ends of what the gesture allows
    const [lo, hi] = mode === "move" ? [-(c.start + 1), c.duration + 3]
      : mode === "trim-l" ? [-(Math.min(c.start, 3) + 0.5), c.duration + 0.5]
        : [-(c.duration + 0.5), 4];
    const dt = q(lo + a.dt * (hi - lo));
    const sel = mode === "move" && a.sel.length ? [...new Set([c.id, ...a.sel.map((u) => pick(s.doc.clips, u).id)])] : [];
    const snap = s.snapshot(); // taken at pointerdown
    const d = E.beginDrag(s.doc, c, mode, { selIds: new Set(sel) });
    const moved = Math.abs(dt) * PPS > DRAG_PX;
    let changed = false;
    if (moved) {
      E.dragTo(s.doc, d, dt, { minDur: MIN_DUR });
      changed = s.snapshot() !== snap;
      if (changed) s.history.push(snap); // onUp: the pointerdown state, when the drag changed anything
    }
    return { line: `${mode} ${c.id} dt=${num(dt)}${sel.length > 1 ? " sel=" + sel : ""}`, r: changed ? ok() : refused(moved ? "unchanged" : "click"), info: { clipId: c.id, mode, group: d.group.map((x) => x.id) } };
  };
}
const RUN = {
  split(s, a) {
    const c = pick(s.doc.clips, a.clip);
    if (!c) return { line: "split", r: refused("no-clip") };
    const t = q(c.start + a.at * c.duration);
    const sel = a.sel === "none" ? [] : a.sel === "clip" ? [c.id] : [...new Set([c.id, pick(s.doc.clips, a.extra).id])];
    return { line: `split t=${num(t)}${sel.length ? " sel=" + sel : ""}`, r: E.splitAt(s.doc, t, { selIds: new Set(sel) }, s.ctx), info: { t } };
  },
  splitAtWorkArea(s) {
    const { inPoint, outPoint } = s.doc;
    return { line: `splitAtWorkArea [${inPoint}, ${outPoint}]`, r: E.splitAtTimes(s.doc, [inPoint, outPoint], s.ctx) };
  },
  trimToPlayhead(s, a) {
    const c = pick(s.doc.clips, a.clip);
    if (!c) return { line: "trimToPlayhead", r: refused("no-clip") };
    const t = q(c.start + (a.at * 1.4 - 0.2) * c.duration); // sometimes outside the clip
    return { line: `trimToPlayhead ${a.side} ${c.id} t=${num(t)}`, r: E.trimClipTo(s.doc, c, t, a.side, s.ctx), info: { clipId: c.id, side: a.side, t } };
  },
  trimToWorkArea(s) {
    const { inPoint, outPoint } = s.doc;
    return { line: `trimToWorkArea [${inPoint}, ${outPoint}]`, r: E.trimToRange(s.doc, inPoint, outPoint, s.ctx), info: { inPoint, outPoint } };
  },
  closeGap(s, a) {
    const lanes = s.enabledLanes();
    const end = projEnd(s.doc);
    let t = null;
    if (a.inGap && lanes.length) {
      const gaps = E.listAlignedGaps(s.doc, 0, end + 1, lanes, s.ctx);
      if (gaps.length) { const g = pick(gaps, a.at); t = (g.L + g.R) / 2; }
    }
    if (t == null) t = q(a.at * (end + 1));
    let gapStart = 0; // the L closeGapAt closes down to (INV-14)
    for (const id of lanes) { const g = E.gapAt(s.doc, id, t); if (g) gapStart = Math.max(gapStart, g.gapStart); }
    return { line: `closeGap t=${num(t)}`, r: E.closeGapAt(s.doc, t, lanes, s.ctx), info: { t, gapStart } };
  },
  delete(s, a) {
    const ids = new Set(a.clips.map((u) => pick(s.doc.clips, u)).filter(Boolean).map((c) => c.id));
    return { line: `delete ${[...ids]}`, r: E.removeClips(s.doc, s.doc.clips.filter((c) => ids.has(c.id)), s.ctx) };
  },
  move: drag("move"),
  trimL: drag("trim-l"),
  trimR: drag("trim-r"),
  toggleLane(s, a) {
    const lane = pick(s.doc.tracks, a.lane).id;
    const off = new Set(s.doc.disabledTracks);
    if (off.has(lane)) off.delete(lane); else off.add(lane);
    s.doc.disabledTracks = [...off].sort();
    return { line: `toggleLane ${lane} → ${off.has(lane) ? "off" : "on"}`, r: ok() };
  },
  undo(s) {
    const snap = s.history.undo(s.snapshot());
    if (snap == null) return { line: "undo", r: refused("empty") };
    P.restoreContent(s.doc, snap);
    return { line: "undo", r: ok() };
  },
  redo(s) {
    const snap = s.history.redo(s.snapshot());
    if (snap == null) return { line: "redo", r: refused("empty") };
    P.restoreContent(s.doc, snap);
    return { line: "redo", r: ok() };
  },
  removeMedia(s, a) {
    const m = pick(s.doc.media, a.media);
    if (!m) return { line: "removeMedia", r: refused("no-media") };
    return { line: `removeMedia ${m.id}`, r: E.removeMedia(s.doc, m.id, s.ctx) };
  },
  setTiming(s, a) {
    const c = pick(s.doc.clips, a.clip);
    if (!c) return { line: "setTiming", r: refused("no-clip") };
    if (a.field === "speed") {
      const t = q(c.start + a.at * c.duration), v = q(0.25 + a.v * 3.75);
      const snap = s.snapshot(); // the inspector records undo on focus; here only when it changed
      const fx = K.setAnimProp(c, "speed", v, { time: t, fps: s.doc.fps });
      if (fx.ok) syncLinkedSpeed(s.doc.clips, c);
      const changed = s.snapshot() !== snap;
      if (changed) s.history.push(snap);
      return { line: `setTiming ${c.id} speed=${num(v)} t=${num(t)}`, r: changed ? ok() : refused(fx.ok ? "nothing" : "off-clip") };
    }
    const v = a.field === "start" ? q(a.v * (projEnd(s.doc) + 2)) : q(a.v * 10);
    return { line: `setTiming ${c.id} ${a.field}=${num(v)}`, r: E.setClipTiming(s.doc, c, { [a.field]: v }, s.ctx) };
  },
};

const fmtResult = (r) => (r.changed
  ? "ok" + (r.created.length ? " +" + r.created.map((c) => c.id).join(" +") : "") + (r.removed.length ? " -" + r.removed.join(" -") : "")
  : "refused " + r.reason);

/* Run one op descriptor on the session; tags lineage first. */
function runOp(s, op) {
  for (const c of s.doc.clips) c[ORIGIN] = c.id;
  const { op: name, ...args } = op;
  const out = RUN[name](s, args);
  s.log.push(`${s.log.length + 1}. ${out.line} → ${fmtResult(out.r)}`);
  return { name, op, ...out };
}

/* ── Readable failure context ── */
function clipLine(c) {
  const p = c.props || {};
  const kf = c.keyframes ? Object.entries(c.keyframes).map(([k, a]) => `${k}@${a.map((x) => num(x.t)).join(",")}`).join(" ") : "";
  return `  ${c.id} ${c.kind} ${c.track} [${num(c.start)}–${num(c.start + c.duration)}] in=${num(c.in)}` +
    (p.speed != null && p.speed !== 1 ? ` speed=${p.speed}` : "") +
    (c.linkGroup ? ` ${c.linkGroup}` : "") +
    (c.transitionIn ? ` tIn=${num(c.transitionIn.duration)}` : "") +
    (c.transitionOut ? ` tOut=${num(c.transitionOut.duration)}` : "") +
    (kf ? ` kf{${kf}}` : "");
}
function describeRun(s, before) {
  const d = s.doc;
  return [
    "── op log ──", ...s.log.map((l) => "  " + l),
    `── lanes ${d.tracks.map((t) => t.id).join(" ")} · disabled [${d.disabledTracks}] · IN/OUT [${d.inPoint}, ${d.outPoint}]`,
    ...(before ? ["── clips before the last op ──", ...before.clips.map(clipLine)] : []),
    "── clips now ──", ...d.clips.map(clipLine),
  ].join("\n");
}

/* A JSON copy of the doc before an op, with clip clones by id. */
function snapshotDoc(doc) {
  const json = JSON.stringify(doc);
  const copy = JSON.parse(json);
  return { ...copy, json, byId: new Map(copy.clips.map((c) => [c.id, c])) };
}
/* After an op: origin clip id → the clips that descend from it (sorted by start). */
function lineage(doc) {
  const m = new Map();
  for (const c of doc.clips) {
    const o = c[ORIGIN];
    if (o == null) continue;
    if (!m.has(o)) m.set(o, []);
    m.get(o).push(c);
  }
  for (const list of m.values()) list.sort((a, b) => a.start - b.start);
  return m;
}

/* Append the op log and the clips to a failure (node prints an error through
   its stack, which froze the old message, so the stack is rebuilt too). */
function explain(e, s, before) {
  if (!e || typeof e !== "object") return e;
  e.message = `${e.message}\n(after op ${s.log.length})\n${describeRun(s, before)}`;
  const at = typeof e.stack === "string" ? e.stack.indexOf("\n    at ") : -1;
  e.stack = `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}${at >= 0 ? e.stack.slice(at) : ""}`;
  return e;
}
/* Play `ops` on a fresh session of `raw`, calling check(step) after each op
   with { name, op, r, info, before, doc, s }. A thrown assertion is explained
   (op log + clips), then propagates to fast-check. */
function play(raw, ops, check, { session } = {}) {
  const s = session || createSession(raw);
  for (const op of ops) {
    const before = check ? snapshotDoc(s.doc) : null;
    const step = runOp(s, op);
    if (!check) continue;
    try { check({ ...step, before, doc: s.doc, s }); } catch (e) { throw explain(e, s, before); }
  }
  return s;
}

/* Op families: what a property's op mix is drawn from (plain names, so test
   files can use them at load time even without fast-check). */
const F = {
  SPLIT: ["split", "splitAtWorkArea"],
  TRIM: ["trimToPlayhead", "trimToWorkArea", "trimL", "trimR"],
  EDIT: ["split", "splitAtWorkArea", "trimToPlayhead", "trimToWorkArea", "closeGap", "delete", "move", "trimL", "trimR"],
  HELPERS: ["toggleLane", "undo", "redo"],
};
F.ALL = [...F.EDIT, ...F.HELPERS]; // everything but removeMedia

module.exports = fc ? build() : {};
Object.assign(module.exports, { F, ORIGIN, idFactory, createSession, runOp, play, explain, snapshotDoc, lineage, describeRun, clipLine, projEnd });

function build() {
  const frac = fc.integer({ min: 0, max: 1000 }).map((i) => i / 1000);
  const none = fc.constant({});
  const ARGS = {
    split: fc.record({ clip: frac, at: frac, sel: fc.constantFrom("none", "clip", "clips"), extra: frac }),
    splitAtWorkArea: none,
    trimToPlayhead: fc.record({ clip: frac, at: frac, side: fc.constantFrom("in", "out") }),
    trimToWorkArea: none,
    closeGap: fc.record({ at: frac, inGap: fc.boolean() }),
    delete: fc.record({ clips: fc.array(frac, { minLength: 1, maxLength: 3 }) }),
    move: fc.record({ clip: frac, dt: frac, sel: fc.array(frac, { maxLength: 2 }) }),
    trimL: fc.record({ clip: frac, dt: frac }),
    trimR: fc.record({ clip: frac, dt: frac }),
    toggleLane: fc.record({ lane: frac }),
    undo: none,
    redo: none,
    removeMedia: fc.record({ media: frac }),
    setTiming: fc.record({ clip: frac, field: fc.constantFrom("start", "duration", "speed"), v: frac, at: frac }),
  };
  const arbOp = (names = F.ALL) => fc.oneof(...names.map((n) => ARGS[n].map((a) => ({ op: n, ...a }))));
  const arbOps = (names = F.ALL, { maxLength = 8 } = {}) => fc.array(arbOp(names), { minLength: 1, maxLength });
  return { ARGS, arbOp, arbOps };
}
