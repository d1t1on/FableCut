/* INV-15: a timeline patch op IS the editor's own edit.

   Each timeline op of core/patch.js (splitClip, trimClip, moveClip, closeGap,
   setTiming, removeClip {linked:true}) runs two ways on the same generated
   project:
     agent path  patchProject(raw, [op]) — what MCP and REST run
     UI path     test/drivers/edit.js, the real app.js wrappers: select + at(t)
                 + split() / trimToPlayhead() / drag(…"move"…) / closeGap() /
                 inspect(start | duration) / deleteSelected()
   and both documents must be equal after the same normalization — the
   editor's own load + save (serializeProject ∘ normalizeProject) — with the
   ids each path generated renamed by creation order (the patch counter says
   c_p1, lg_p2, …, the driver's uid c_u1, lg_u2, …).

   Excluded, because they are not the document: the driver's undo history,
   selection, toasts and save count. One documented difference: a moveClip
   onto a lane the editor doesn't show, or of the other kind, is REFUSED by the
   op (explicit intent, all-or-nothing), while the UI silently ignores such a
   drop and still moves the clip in time — there the rest of the move (the op
   without `track`) must match the UI.
   Every other refusal (nothing to split / trim, no gap) must leave the UI's
   document unchanged too, and no op may add a validation error (INV-01). */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const A = require("../support/arb");
const { createEditDriver } = require("../drivers/edit");
const { patchProject } = require("../../core/patch");
const { normalizeProject, serializeProject } = require("../../core/project");
const { diffProjects } = require("../../core/summary");
const { clipEnd } = require("../../core/keyframes");
const E = require("../../core/edit");
const { loadFixture } = require("../fixtures");

const json = (x) => JSON.parse(JSON.stringify(x));
const q = (t) => Math.round(t * 1000) / 1000;
const pick = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))];
const projEnd = (doc) => doc.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
const counter = () => { let n = 0; return { newId: (p = "c_") => `${p}p${++n}`, newLinkId: () => `lg_p${++n}` }; };

/* The editor's load + save, then generated ids renamed by creation order. */
const saved = (doc) => serializeProject(normalizeProject(json(doc)).project);
function canonical(doc, known) {
  const out = saved(doc);
  const nth = (id) => +/(\d+)$/.exec(id)[1]; // the id counter = creation order
  const fresh = [...new Set(out.clips.flatMap((c) => [c.id, c.linkGroup]).filter((id) => id && !known.has(id)))];
  const rename = new Map(fresh.sort((a, b) => nth(a) - nth(b)).map((id, i) => [id, `new#${i + 1}`]));
  for (const c of out.clips) {
    if (rename.has(c.id)) c.id = rename.get(c.id);
    if (rename.has(c.linkGroup)) c.linkGroup = rename.get(c.linkGroup);
  }
  return out;
}
const knownIds = (raw) => new Set(saved(raw).clips.flatMap((c) => [c.id, c.linkGroup]).filter(Boolean));

/* Run `op` both ways on `raw`; `ui(driver)` is the editor's action. */
function sameAsEditor(raw, op, ui) {
  const known = knownIds(raw);
  const res = patchProject(json(raw), [op], counter());
  const drv = createEditDriver(json(raw));
  ui(drv);
  const byUi = canonical(drv.save(), known);
  const why = (what, got) => `${what}\nop: ${JSON.stringify(op)}\n` +
    `patch → UI diff:\n  ${diffProjects(got, byUi, { limit: 40 }).join("\n  ") || "(none)"}`;
  if (res.ok) {
    const byPatch = canonical(res.doc, known);
    assert.deepEqual(byPatch, byUi, why("INV-15: the op and the editor disagree", byPatch));
    return "done";
  }
  assert.deepEqual(res.newErrors, [], `INV-01: the op added a validation error\n${res.error}`);
  if (op.op === "moveClip" && op.track !== undefined && / lane /.test(res.error)) {
    // the documented difference: the op refuses the lane, the UI ignores it — the rest must match
    const { track, ...rest } = op;
    const again = rest.start === undefined && rest.dt === undefined ? null : patchProject(json(raw), [rest], counter());
    const byPatch = canonical(again ? again.doc : raw, known);
    assert.deepEqual(byPatch, byUi, why(`INV-15: ${res.error}\n…and without the lane the op and the editor disagree`, byPatch));
    return "lane refused";
  }
  const untouched = canonical(raw, known);
  assert.deepEqual(byUi, untouched, why(`INV-15: the op refused (${res.error}) but the editor changed the document`, untouched));
  return "refused";
}

/* Late-bound parameters: fractions resolved against the generated doc. */
function build(fc) {
  const frac = fc.integer({ min: 0, max: 1000 }).map((i) => i / 1000);
  const onClip = (raw, u) => pick(raw.clips, u);
  const inClip = (c, u) => q(c.start + (u * 1.2 - 0.1) * c.duration); // sometimes off the clip
  return {
    splitClip: [fc.record({ mode: fc.constantFrom("id", "ids", "all"), clip: frac, extra: frac, at: frac }), (raw, a) => {
      const c = onClip(raw, a.clip);
      const ids = a.mode === "all" ? [] : a.mode === "id" ? [c.id] : [...new Set([c.id, onClip(raw, a.extra).id])];
      const t = a.mode === "all" ? q(a.at * (projEnd(raw) + 1)) : inClip(c, a.at);
      const sel = a.mode === "all" ? { all: true } : a.mode === "id" ? { id: c.id } : { ids };
      return [{ op: "splitClip", ...sel, t }, (d) => d.select(...ids).at(t).split()];
    }],
    trimClip: [fc.record({ clip: frac, side: fc.constantFrom("in", "out"), at: frac }), (raw, a) => {
      const c = onClip(raw, a.clip), t = inClip(c, a.at);
      return [{ op: "trimClip", id: c.id, side: a.side, t }, (d) => d.select(c.id).at(t).trimToPlayhead(a.side)];
    }],
    moveClip: [fc.record({ clip: frac, how: fc.constantFrom("start", "dt", "dt", "none"), u: frac,
      lane: fc.constantFrom("none", "none", "same", "same", "other", "new"), laneU: frac }), (raw, a) => {
      const c = onClip(raw, a.clip);
      const lanes = normalizeProject(json(raw)).project.tracks;
      // a shown lane of the clip's kind (a drop the UI takes), of the other kind, or one it doesn't show
      const kind = (l) => (l.kind === "audio") === (c.kind === "audio");
      const shown = lanes.filter((l) => (a.lane === "same") === kind(l));
      const track = a.lane === "new" ? "V" + (lanes.length + 3)
        : a.lane !== "none" && shown.length ? pick(shown, a.laneU).id : undefined;
      const how = a.how === "none" && !track ? "dt" : a.how;
      const start = q(a.u * (projEnd(raw) + 2));
      const dt = q(-(c.start + 1) + a.u * (c.start + c.duration + 4));
      const op = { op: "moveClip", id: c.id, ...(how === "start" ? { start } : how === "dt" ? { dt } : {}), ...(track ? { track } : {}) };
      // the drag's dt, exactly as the op derives it (a start lands via start − c.start)
      const by = how === "start" ? start - c.start : how === "dt" ? dt : 0;
      return [op, (d) => d.drag(c.id, "move", 0, by, { track })];
    }],
    closeGap: [fc.record({ at: frac, inGap: fc.boolean() }), (raw, a) => {
      const doc = normalizeProject(json(raw)).project;
      const on = (id) => !doc.disabledTracks.includes(id);
      const lanes = doc.tracks.map((l) => l.id).filter(on), end = projEnd(doc);
      const gaps = a.inGap && lanes.length ? E.listAlignedGaps(doc, 0, end + 1, lanes, { isEnabled: on }) : [];
      const t = gaps.length ? (pick(gaps, a.at).L + pick(gaps, a.at).R) / 2 : q(a.at * (end + 1));
      return [{ op: "closeGap", t }, (d) => d.at(t).closeGap()];
    }],
    setTiming: [fc.record({ clip: frac, fields: fc.constantFrom("start", "duration", "both"), s: frac, dur: frac }), (raw, a) => {
      const c = onClip(raw, a.clip);
      const start = a.fields !== "duration" ? q(a.s * (projEnd(raw) + 3) - 1) : undefined; // < 0 sometimes: clamped
      const duration = a.fields !== "start" ? q(a.dur * 10) : undefined; // < MIN_DUR sometimes: clamped
      return [{ op: "setTiming", id: c.id, ...(start !== undefined ? { start } : {}), ...(duration !== undefined ? { duration } : {}) }, (d) => {
        if (start !== undefined) d.inspect(c.id, "start", start); // two inspector fields, the same end state
        if (duration !== undefined) d.inspect(c.id, "duration", duration);
      }];
    }],
    removeClip: [fc.record({ clip: frac }), (raw, a) => {
      const c = onClip(raw, a.clip);
      return [{ op: "removeClip", id: c.id, linked: true }, (d) => d.select(c.id).deleteSelected()];
    }],
  };
}

const TITLES = {
  splitClip: "INV-15a: splitClip {id | ids | all, t} ≡ select + playhead + split",
  trimClip: "INV-15b: trimClip {id, side, t} ≡ select + playhead + trim to playhead",
  moveClip: "INV-15c: moveClip {id, start | dt, track?} ≡ the move drag, no snapping (a lane the editor ignores is refused)",
  closeGap: "INV-15d: closeGap {t} ≡ playhead + close gap",
  setTiming: "INV-15e: setTiming {id, start?, duration?} ≡ the inspector's start / length fields",
  removeClip: "INV-15f: removeClip {id, linked:true} ≡ select + Delete",
};
for (const [name, title] of Object.entries(TITLES)) {
  propTest(title, (fc) => {
    const [arbArgs, make] = build(fc)[name];
    const seen = new Map();
    fc.assert(fc.property(A.arbProject(), arbArgs, (raw, a) => {
      const [op, ui] = make(raw, a);
      const outcome = sameAsEditor(raw, op, ui);
      seen.set(outcome, (seen.get(outcome) || 0) + 1);
    }));
    if (process.env.FC_INV15_STATS) console.log(name, Object.fromEntries(seen));
    assert.ok(seen.has("done"), `${name} never went ahead — the generator no longer reaches it`);
  });
}

/* A deterministic companion: the legacy fixture's links exist only once the
   editor loads it (a pairwise linkedId, and a stem matching the video's media
   and timing). The op completes them the same way, so it cuts what the editor
   cuts; so do the other ops. */
propTest("INV-15 (example): on a legacy doc with implicit links, every timeline op still equals the editor", () => {
  const raw = loadFixture("legacy");
  const cases = [
    [{ op: "splitClip", id: "c_ov", t: 3 }, (d) => d.select("c_ov").at(3).split()],
    [{ op: "splitClip", all: true, t: 1.5 }, (d) => d.at(1.5).split()],
    [{ op: "trimClip", id: "c_ob", side: "in", t: 2 }, (d) => d.select("c_ob").at(2).trimToPlayhead("in")],
    [{ op: "moveClip", id: "c_oa", dt: 1 }, (d) => d.drag("c_oa", "move", 0, 1)],
    [{ op: "closeGap", t: 6.5 }, (d) => d.at(6.5).closeGap()],
    [{ op: "closeGap", t: 4 }, (d) => d.at(4).closeGap()],
    [{ op: "moveClip", id: "c_ov", dt: 2, track: "A3" }, (d) => d.drag("c_ov", "move", 0, 2, { track: "A3" })],
    [{ op: "setTiming", id: "c_ov", duration: 4 }, (d) => d.inspect("c_ov", "duration", 4)],
    [{ op: "removeClip", id: "c_ob", linked: true }, (d) => d.select("c_ob").deleteSelected()],
  ];
  const outcomes = cases.map(([op, ui]) => sameAsEditor(raw, op, ui));
  assert.deepEqual(outcomes, ["done", "done", "done", "done", "done", "refused", "lane refused", "done", "done"]);
});
