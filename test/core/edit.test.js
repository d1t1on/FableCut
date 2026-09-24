/* core/edit.js — timeline edit operations on an explicit project doc, and
   the clip drag gesture math. test/edit-ops.test.js runs them through
   app.js's wrappers (toasts, undo, selection); this file pins the doc-in API:
   in-place changes, result records, the beforeChange hook, id-factory order.
   A known bug would be pinned by a test marked "current behavior; BUG-xx";
   Phase 3 fixed the last ones (D4, D6, docs/specs/0001). */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const E = require("../../core/edit");
const { mediaTimeAt } = require("../../core/keyframes");
const { MIN_DUR } = require("../../core/schema");

const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);
const clip = (id, over = {}) => ({ id, mediaId: "m", kind: "video", track: "V1", start: 0, in: 0, duration: 4, props: {}, ...over });
const doc = (clips, media = [{ id: "m", kind: "video", duration: 20 }]) => ({ clips, media });
const byId = (d, id) => d.clips.find((c) => c.id === id);
const ids = (list) => list.map((c) => c.id);
/* Deterministic ctx that records every call, and the doc as beforeChange saw it. */
function mkCtx(d, { disabled = [], minDur } = {}) {
  const calls = [];
  const off = new Set(disabled);
  let n = 0;
  return {
    calls,
    snaps: [],
    newId() { calls.push("id"); return "c_n" + ++n; },
    newLinkId() { calls.push("lg"); return "lg_n" + ++n; },
    isEnabled: (lane) => !off.has(lane),
    ...(minDur != null ? { minDur } : {}),
    beforeChange() { calls.push("before"); this.snaps.push(JSON.stringify(d.clips)); },
  };
}
/* V1 picture + A1/A2 stems (one group) on [0, 8] from in 2; a gap; a second
   group on [10, 14]; a music bed on A3 [0, 14]. */
function linkedAv() {
  const grp = (sfx, start, inn, dur, g) => [
    clip("v" + sfx, { start, in: inn, duration: dur, linkGroup: g }),
    clip("l" + sfx, { kind: "audio", track: "A1", start, in: inn, duration: dur, linkGroup: g, props: { audioChannel: 0 } }),
    clip("r" + sfx, { kind: "audio", track: "A2", start, in: inn, duration: dur, linkGroup: g, props: { audioChannel: 1 } }),
  ];
  return doc([...grp("", 0, 2, 8, "g1"), ...grp("2", 10, 12, 4, "g2"),
    clip("song", { mediaId: "s", kind: "audio", track: "A3", duration: 14 })],
  [{ id: "m", kind: "video", duration: 20 }, { id: "s", kind: "audio", duration: 30 }]);
}
const LANES = ["V3", "V2", "V1", "A1", "A2", "A3", "A4"];

/* ── splitClipAt ── */
test("splitClipAt: c keeps the left piece, the right piece is appended and returned", () => {
  const c = clip("a", {
    start: 2, in: 1, duration: 4, props: { speed: 2 }, name: "cam",
    keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 10 }, { t: 3, v: 30, ease: "linear" }] },
    transitionIn: { type: "fade", duration: 0.5 }, transitionOut: { type: "whip", duration: 0.25 },
  });
  const d = doc([c]);
  const ctx = mkCtx(d);
  const right = E.splitClipAt(d, c, 3.5, ctx);
  assert.equal(d.clips[1], right);
  assert.equal(d.clips[0], c, "left keeps its identity");
  assert.deepEqual([c.start, c.in, c.duration], [2, 1, 1.5]);
  assert.deepEqual([right.id, right.start, right.in, right.duration, right.name], ["c_n1", 3.5, 4, 2.5, "cam"]);
  assert.deepEqual(c.keyframes.x.map((k) => k.t), [0, 1, 3], "the key past the cut stays as an anchor (D4)");
  assert.deepEqual(right.keyframes.x, [{ t: -0.5, v: 10 }, { t: 1.5, v: 30, ease: "linear" }], "…and the nearest one before it");
  assert.deepEqual(c.transitionIn, { type: "fade", duration: 0.5 });
  assert.ok(Object.hasOwn(c, "transitionOut") && c.transitionOut === undefined);
  assert.equal(right.transitionIn, undefined);
  assert.deepEqual(right.transitionOut, { type: "whip", duration: 0.25 });
  assert.notEqual(right.props, c.props);
  assert.deepEqual(ctx.calls, ["id"], "a primitive: no beforeChange, no relink");
});

test("splitClipAt: t within minDur of an edge (or outside) → null, nothing touched", () => {
  const c = clip("a", { start: 1 });
  const d = doc([c]);
  for (const t of [1, 1 + MIN_DUR, 5 - MIN_DUR, 5, 0, 9, NaN]) assert.equal(E.splitClipAt(d, c, t, mkCtx(d)), null, `t=${t}`);
  assert.equal(E.splitClipAt(d, c, 1.3, mkCtx(d, { minDur: 0.5 })), null, "ctx.minDur wins");
  assert.equal(d.clips.length, 1);
  assert.equal(c.duration, 4);
  assert.throws(() => E.splitClipAt(d, c, 2, {}), /ctx\.newId must be a function/);
});

test("splitClipAt: the right piece starts at the media time under the cut, ramps included (BUG-12)", () => {
  const v = clip("v", { in: 1, duration: 6, keyframes: { speed: [{ t: 0, v: 1 }, { t: 6, v: 3, ease: "linear" }] } });
  const d = doc([v]);
  const right = E.splitClipAt(d, v, 2, mkCtx(d));
  near(right.in, 1 + 2 + 4 / 6, 1e-9, "in + ∫₀² (1 + t/3) dt, not in + 2 × static speed");
});

test("splitClipAt: the pieces own their props (BUG-15) and each keeps its outer transition, fitted to the piece (BUG-16)", () => {
  const tin = { type: "fade", duration: 3 }, tout = { type: "whip", duration: 5 };
  const c = clip("t", {
    kind: "text", mediaId: null, duration: 6, props: { fontCutSet: ["Anton"] },
    transitionIn: tin, transitionOut: tout,
  });
  const d = doc([c]);
  const right = E.splitClipAt(d, c, 2, mkCtx(d));
  assert.equal(right.in, 0, "a title has no source time (D5, BUG-19)");
  assert.deepEqual(right.props.fontCutSet, ["Anton"]);
  assert.notEqual(right.props.fontCutSet, c.props.fontCutSet, "BUG-15: array props are copied");
  assert.deepEqual([c.transitionIn, c.transitionOut], [{ type: "fade", duration: 2 }, undefined], "the 2 s left piece");
  assert.deepEqual([right.transitionIn, right.transitionOut], [undefined, { type: "whip", duration: 4 }], "the 4 s right piece");
  assert.deepEqual([tin.duration, tout.duration], [3, 5], "shortened transitions are new objects");
});

test("D5: svg clips keep their animation time across split, trim to playhead, trim to IN/OUT and trim-l; image/text/adjust keep in 0", () => {
  const svg = () => clip("s", { kind: "svg", start: 2, in: 1, duration: 4, props: { speed: 2 } });
  let s = svg(), d = doc([s], [{ id: "m", kind: "svg" }]);
  assert.equal(E.splitClipAt(d, s, 3, mkCtx(d)).in, 3, "split: 1 + 1 s × 2");
  s = svg(); d = doc([s], []);
  E.trimClipTo(d, s, 3, "in", mkCtx(d));
  assert.equal(s.in, 3, "trim to playhead");
  s = svg(); d = doc([s], []);
  E.trimToRange(d, 3, null, mkCtx(d));
  assert.equal(s.in, 3, "trim to IN");
  s = svg(); d = doc([s], []);
  const g = E.beginDrag(d, s, "trim-l");
  E.dragTo(d, g, 1);
  assert.equal(s.in, 3, "trim-l");
  E.dragTo(d, g, -2);
  assert.deepEqual([s.start, s.in, s.duration], [1.5, 0, 4.5], "extending stops at in 0");
  for (const kind of ["image", "text", "adjust"]) {
    const c = clip(kind, { kind, mediaId: kind === "image" ? "m" : null, start: 2, in: 0, duration: 4, props: { speed: 2 } });
    const dd = doc([c]);
    assert.equal(E.splitClipAt(dd, c, 3, mkCtx(dd)).in, 0, `${kind}: split`);
    E.trimClipTo(dd, c, 2.5, "in", mkCtx(dd));
    E.trimToRange(dd, 2.7, null, mkCtx(dd));
    E.dragTo(dd, E.beginDrag(dd, c, "trim-l"), 0.1);
    assert.equal(c.in, 0, `${kind}: trims`);
  }
});

/* ── splitAt (split at playhead) ── */
test("splitAt: no selection → every clip under t on any lane, plus partners; one beforeChange first", () => {
  const d = linkedAv();
  const before = JSON.stringify(d.clips);
  const ctx = mkCtx(d, { disabled: ["A3"] });
  const r = E.splitAt(d, 4, {}, ctx);
  assert.equal(r.changed, true);
  assert.deepEqual(ids(r.created), ["c_n1", "c_n2", "c_n3", "c_n4"]);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(ctx.calls, ["before", "id", "id", "id", "id", "lg"], "ids in clip order, then the link id");
  assert.deepEqual(ctx.snaps, [before], "the undo snapshot is the pre-edit doc");
  assert.equal(byId(d, "song").duration, 4, "a disabled lane is still split (splitAt ignores isEnabled)");
  const rights = r.created.slice(0, 3);
  assert.ok(rights.every((x) => x.linkGroup === "lg_n5"));
  assert.equal(r.created[3].linkGroup, undefined);
});

test("splitAt: a selection limits the cut to it and its linked partners", () => {
  const d = linkedAv();
  const r = E.splitAt(d, 4, { selIds: new Set(["l"]) }, mkCtx(d));
  assert.deepEqual(r.created.map((x) => x.track), ["A1", "V1", "A2"]);
  assert.equal(byId(d, "song").duration, 14);
});

test("splitAt: nothing under t → refused, no beforeChange, no ids", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  const r = E.splitAt(d, 20, {}, ctx);
  assert.deepEqual(r, { changed: false, created: [], removed: [], reason: "nothing" });
  assert.deepEqual(ctx.calls, []);
  assert.equal(E.splitAt(d, 4, { selIds: new Set(["v2"]) }, ctx).reason, "nothing");
  assert.throws(() => E.splitAt(d, 4, {}, { newId: () => "x" }), /ctx\.newLinkId/);
});

test("splitAt: legacy pairwise links re-pair on the right halves", () => {
  const d = doc([clip("pv", { linkedId: "pa" }), clip("pa", { kind: "audio", track: "A1", linkedId: "pv" })]);
  const r = E.splitAt(d, 1, undefined, mkCtx(d));
  const [rv, ra] = r.created;
  assert.deepEqual([rv.linkedId, ra.linkedId], [ra.id, rv.id]);
  assert.equal(byId(d, "pv").linkedId, "pa");
});

/* ── splitAtTimes (split at IN/OUT) ── */
test("splitAtTimes: cuts right to left on enabled lanes; null markers are ignored", () => {
  const d = linkedAv();
  const ctx = mkCtx(d, { disabled: ["V1"] });
  const r = E.splitAtTimes(d, [1, 9], ctx);
  assert.equal(r.changed, true);
  const starts = (lane) => d.clips.filter((c) => c.track === lane).map((c) => c.start).sort((a, b) => a - b);
  assert.deepEqual(starts("A3"), [0, 1, 9]);
  // V1 is disabled, but its group partners on A1/A2 cross IN, so the whole group is cut
  // (like every group-wide edit: a disabled lane is hidden, not unlinked — D2)
  assert.deepEqual(starts("V1"), [0, 1, 10]);
  assert.deepEqual(r.created.map((c) => c.start), [9, 1, 1, 1, 1], "the 9 s cut first");
  assert.equal(ctx.calls[0], "before");
  assert.deepEqual(E.splitAtTimes(d, [null, undefined], ctx).reason, "no-markers");
  assert.deepEqual(E.splitAtTimes(d, [null, 30], ctx).reason, "nothing");
  assert.throws(() => E.splitAtTimes(d, [1], { newId() {}, newLinkId() {} }), /ctx\.isEnabled/);
});

/* ── trimClipTo (trim to playhead) ── */
test("trimClipTo: in / out trims move the clip edge; linked partners follow", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  const v = byId(d, "v");
  assert.deepEqual(E.trimClipTo(d, v, 3, "in", ctx), { changed: true, created: [], removed: [], trimmed: true });
  for (const id of ["v", "l", "r"]) assert.deepEqual([byId(d, id).start, byId(d, id).in, byId(d, id).duration], [3, 5, 5], id);
  E.trimClipTo(d, v, 6, "out", ctx);
  for (const id of ["v", "l", "r"]) assert.equal(byId(d, id).duration, 3, id);
  assert.deepEqual(ctx.calls, ["before", "before"]);
});

test("trimClipTo: refused for no clip or an in-trim at/before the start — no beforeChange", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  assert.equal(E.trimClipTo(d, null, 3, "in", ctx).reason, "no-clip");
  assert.equal(E.trimClipTo(d, byId(d, "v2"), 10, "in", ctx).reason, "at-start");
  assert.equal(E.trimClipTo(d, byId(d, "v2"), 2, "in", ctx).reason, "at-start");
  assert.deepEqual(ctx.calls, []);
});

test("trimClipTo: acts like a cut — keyframes re-based (BUG-14a), the trimmed edge's transition cleared (BUG-14b), the other fitted (BUG-22)", () => {
  const t = clip("t", {
    kind: "text", mediaId: null, start: 2, duration: 4,
    keyframes: { x: [{ t: 3, v: 1 }] }, transitionIn: { type: "fade", duration: 1 }, transitionOut: { type: "fade", duration: 2.5 },
  });
  const d = doc([t]);
  const ctx = mkCtx(d);
  const r = E.trimClipTo(d, t, 3, "in", ctx);
  assert.deepEqual([r.changed, r.trimmed, t.start, t.duration], [true, true, 3, 3]);
  assert.deepEqual(t.keyframes.x, [{ t: 2, v: 1 }], "BUG-14a: the key keeps its timeline time (5 s)");
  assert.equal(t.transitionIn, undefined, "BUG-14b: the trimmed edge loses its transition");
  assert.deepEqual(t.transitionOut, { type: "fade", duration: 2.5 }, "the other one still fits");
  assert.equal(t.in, 0, "a title's in stays 0 (D5, BUG-14c)");
  E.trimClipTo(d, t, 4, "out", ctx);
  assert.deepEqual([t.duration, t.transitionOut], [1, undefined], "trim out clears the out-transition");
  assert.deepEqual(ctx.calls, ["before", "before"]);
});

test("trimClipTo: nothing to trim → refused, no beforeChange (BUG-14d)", () => {
  const t = clip("t", { start: 2, duration: 4 });
  const d = doc([t]);
  const ctx = mkCtx(d);
  const before = JSON.stringify(d);
  for (const [at, side] of [[20, "out"], [6, "out"], [2 + MIN_DUR, "out"], [6, "in"], [6 - MIN_DUR, "in"], [1, "out"], [4, "sideways"]]) {
    const r = E.trimClipTo(d, t, at, side, ctx);
    assert.deepEqual([r.changed, r.trimmed, r.reason], [false, false, "nothing"], `${side} ${at}`);
  }
  assert.deepEqual(ctx.calls, []);
  assert.equal(JSON.stringify(d), before);
});

test("trimClipTo: every link-group member re-bases its own keyframes and loses the trimmed edge's transition", () => {
  const v = clip("v", { linkGroup: "g", transitionIn: { type: "fade", duration: 1 }, keyframes: { x: [{ t: 2, v: 1 }] } });
  const a = clip("a", { kind: "audio", track: "A1", linkGroup: "g", transitionIn: { type: "fade", duration: 1 }, keyframes: { volume: [{ t: 3, v: 0 }] } });
  const d = doc([v, a]);
  E.trimClipTo(d, a, 1, "in", mkCtx(d));
  for (const x of [v, a]) assert.deepEqual([x.start, x.in, x.duration, x.transitionIn], [1, 1, 3, undefined], x.id);
  assert.deepEqual(v.keyframes.x, [{ t: 1, v: 1 }]);
  assert.deepEqual(a.keyframes.volume, [{ t: 2, v: 0 }]);
});

/* ── trimToRange (trim to IN/OUT) ── */
test("trimToRange: drops heads/tails, removes clips outside, re-bases keyframes, clears trimmed transitions", () => {
  const d = linkedAv();
  byId(d, "v").keyframes = { x: [{ t: 0, v: 0 }, { t: 2, v: 5 }, { t: 7.5, v: 9 }] };
  byId(d, "v").transitionIn = { type: "fade", duration: 1 };
  byId(d, "v").transitionOut = { type: "fade", duration: 1 };
  d.clips.push(clip("title", { kind: "text", mediaId: null, track: "V2", start: 0.5, in: 0.25, duration: 2 }));
  const ctx = mkCtx(d);
  const r = E.trimToRange(d, 1, 7, ctx);
  assert.deepEqual([r.changed, r.removed], [true, ["v2", "l2", "r2"]]);
  const v = byId(d, "v");
  assert.deepEqual([v.start, v.in, v.duration], [1, 3, 6]);
  assert.deepEqual(v.keyframes.x, [{ t: -1, v: 0 }, { t: 1, v: 5 }, { t: 6.5, v: 9 }], "shifted by 1 onto the new 6 s, one anchor kept on each side (D4)");
  assert.equal(v.transitionIn, undefined);
  assert.equal(v.transitionOut, undefined);
  const title = byId(d, "title");
  assert.deepEqual([title.start, title.in, title.duration], [1, 0, 1.5], "non-media clips reset in to 0");
  assert.deepEqual(byId(d, "song").duration, 6);
  assert.deepEqual(ctx.calls, ["before"]);
});

test("trimToRange: open-ended ranges, and the clips array keeps its identity when nothing is removed", () => {
  const d = linkedAv();
  const arr = d.clips;
  assert.equal(E.trimToRange(d, null, 12, mkCtx(d)).changed, true);
  assert.equal(d.clips, arr);
  assert.deepEqual([byId(d, "v2").duration, byId(d, "song").duration], [2, 12]);
  E.trimToRange(d, 11, null, mkCtx(d));
  assert.deepEqual([byId(d, "v2").start, byId(d, "v2").in, byId(d, "v2").duration], [11, 13, 1]);
  assert.equal(byId(d, "v"), undefined);
});

test("trimToRange: refusals — no markers, nothing to trim", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  assert.equal(E.trimToRange(d, null, null, ctx).reason, "no-markers");
  assert.equal(E.trimToRange(d, 0, 20, ctx).reason, "nothing");
  assert.equal(E.trimToRange(d, 0, 14 + 5e-7, ctx).reason, "nothing", "within 1e-6 of the edge");
  assert.deepEqual(ctx.calls, []);
  assert.throws(() => E.trimToRange(d, 1, 2, {}), /ctx\.isEnabled/);
});

test("trimToRange: partners on disabled lanes are trimmed and removed with their group; unlinked clips there are not (D2, BUG-10)", () => {
  const d = linkedAv();
  byId(d, "r").keyframes = { volume: [{ t: 0.5, v: 0 }, { t: 3, v: 1 }] };
  const r = E.trimToRange(d, 1, 9, mkCtx(d, { disabled: ["A2", "A3"] }));
  for (const id of ["v", "l", "r"]) assert.deepEqual([byId(d, id).start, byId(d, id).in, byId(d, id).duration], [1, 3, 7], id);
  assert.deepEqual(byId(d, "r").keyframes.volume, [{ t: -0.5, v: 0 }, { t: 2, v: 1 }], "the stem re-bases its own keys");
  assert.deepEqual(r.removed, ["v2", "l2", "r2"]);
  assert.deepEqual([byId(d, "song").start, byId(d, "song").duration], [0, 14], "a disabled, unlinked clip is left alone");
  const all = linkedAv();
  assert.equal(E.trimToRange(all, 1, 9, mkCtx(all, { disabled: LANES })).reason, "nothing", "every lane off: nothing to trim");
});

/* ── Gaps ── */
test("gapAt: null under a clip; otherwise the free span around t", () => {
  const d = linkedAv();
  assert.equal(E.gapAt(d, "V1", 4), null);
  assert.equal(E.gapAt(d, "V1", 8 - 1e-9), null);
  assert.deepEqual(E.gapAt(d, "V1", 8), { gapStart: 8, gapEnd: 10 });
  assert.deepEqual(E.gapAt(d, "V1", 20), { gapStart: 14, gapEnd: Infinity });
  assert.deepEqual(E.gapAt(d, "V3", 3), { gapStart: 0, gapEnd: Infinity });
});

test("closeGapAt: shifts later clips on enabled lanes left by the aligned gap", () => {
  const d = linkedAv();
  const ctx = mkCtx(d, { disabled: ["A3"] });
  const plan = E.planCloseGap(d, 9, LANES.filter((l) => l !== "A3"), ctx);
  assert.deepEqual([plan.ok, plan.gap, ids(plan.movers)], [true, 2, ["v2", "l2", "r2"]]);
  assert.deepEqual(ctx.calls, [], "planning writes nothing");
  const r = E.closeGapAt(d, 9, LANES.filter((l) => l !== "A3"), ctx);
  assert.deepEqual(r, { changed: true, created: [], removed: [], gap: 2 });
  for (const id of ["v2", "l2", "r2"]) assert.equal(byId(d, id).start, 8, id);
  assert.equal(byId(d, "song").start, 0);
  assert.deepEqual(ctx.calls, ["before"]);
});

test("closeGapAt: refusals name their reason (and the first covered lane in lane order)", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  assert.equal(E.closeGapAt(d, 9, [], ctx).reason, "no-lanes");
  assert.deepEqual(E.closeGapAt(d, 9, LANES, ctx), { changed: false, created: [], removed: [], reason: "covered", trackId: "A3" });
  assert.equal(E.closeGapAt(d, 4, LANES, ctx).trackId, "V1");
  assert.equal(E.closeGapAt(d, 20, ["V1"], ctx).reason, "nothing", "trailing void");
  assert.equal(E.closeGapAt(d, 3, ["V3"], ctx).reason, "nothing", "empty lane");
  assert.equal(E.closeGapAt(d, 9, ["V1"], mkCtx(d, { disabled: LANES })).reason, "nothing", "no movers");
  const tiny = doc([clip("a", { duration: 2 }), clip("b", { start: 2 + E.GAP_EPS / 2 })]);
  assert.equal(E.closeGapAt(tiny, 2 + E.GAP_EPS / 4, ["V1"], mkCtx(tiny)).reason, "nothing", "≤ GAP_EPS");
  assert.deepEqual(ctx.calls, []);
  assert.throws(() => E.planCloseGap(d, 9, LANES, {}), /ctx\.isEnabled/);
});

test("closeGapAt: a mover just inside GAP_EPS of the gap end is clamped at 0", () => {
  const d = doc([clip("b", { start: 3 }), clip("c", { track: "V2", start: 3 - E.GAP_EPS / 2 })]);
  E.closeGapAt(d, 1, ["V1"], mkCtx(d));
  assert.deepEqual([byId(d, "b").start, byId(d, "c").start], [0, 0]);
});

test("closeGapAt: partners on disabled lanes move with their group (D2, BUG-09)", () => {
  const d = linkedAv();
  d.clips.push(clip("late", { mediaId: "s", kind: "audio", track: "A3", start: 11, duration: 1 }));
  const plan = E.planCloseGap(d, 9, ["V1", "A1"], mkCtx(d, { disabled: ["A2", "A3"] }));
  assert.deepEqual(ids(plan.movers), ["v2", "l2", "r2"], "an unlinked clip on a disabled lane stays out");
  E.closeGapAt(d, 9, ["V1", "A1"], mkCtx(d, { disabled: ["A2", "A3"] }));
  for (const id of ["v2", "l2", "r2"]) assert.equal(byId(d, id).start, 8, id);
  assert.equal(byId(d, "late").start, 11);
});

test("listAlignedGaps: gaps shared by every lane inside [t0, t1], sorted and clipped to the range", () => {
  const d = linkedAv();
  d.clips.push(clip("late", { track: "V2", start: 16, duration: 2 }));
  const lanes = ["V1", "V2", "A1", "A2"];
  const ctx = mkCtx(d, { disabled: ["A3"] });
  assert.deepEqual(E.listAlignedGaps(d, 0, 20, lanes, ctx), [{ L: 8, R: 10 }, { L: 14, R: 16 }, { L: 18, R: 20 }]);
  assert.deepEqual(E.listAlignedGaps(d, 9, 15, lanes, ctx), [{ L: 9, R: 10 }, { L: 14, R: 15 }]);
  assert.deepEqual(E.listAlignedGaps(d, 0, 20, [...lanes, "A3"], ctx), [{ L: 14, R: 16 }, { L: 18, R: 20 }]);
  assert.deepEqual(E.listAlignedGaps(d, 0, 20, [], ctx), []);
  assert.deepEqual(E.listAlignedGaps(d, 5, 5 + E.GAP_EPS, lanes, ctx), []);
  assert.throws(() => E.listAlignedGaps(d, 0, 20, lanes, {}), /ctx\.isEnabled/);
});

test("nextGap: the first gap whose middle is after t, wrapping; reasons when there is none", () => {
  const d = linkedAv();
  const ctx = mkCtx(d, { disabled: ["A3"] });
  const lanes = ["V1", "A1", "A2"];
  assert.deepEqual(E.nextGap(d, 0, 20, 0, lanes, ctx), { gap: { L: 8, R: 10 } });
  assert.deepEqual(E.nextGap(d, 0, 20, 9, lanes, ctx), { gap: { L: 14, R: 20 } });
  assert.deepEqual(E.nextGap(d, 0, 20, 17, lanes, ctx), { gap: { L: 8, R: 10 } }, "wraps");
  assert.deepEqual(E.nextGap(d, 3, 3, 0, lanes, ctx), { gap: null, reason: "empty-range" });
  assert.deepEqual(E.nextGap(d, 1, 7, 0, lanes, ctx), { gap: null, reason: "no-gaps" });
});

/* ── removeClips ── */
test("removeClips: the list and its linked partners go; ids come back for the app's cleanup", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  const r = E.removeClips(d, [byId(d, "l2")], ctx);
  assert.deepEqual([r.changed, r.removed], [true, ["l2", "v2", "r2"]]);
  assert.deepEqual(ids(d.clips), ["v", "l", "r", "song"]);
  assert.deepEqual(ctx.calls, ["before"]);
  assert.equal(E.removeClips(d, [], ctx).reason, "nothing");
  assert.equal(E.removeClips(d, [], undefined).reason, "nothing", "ctx is optional here");
  assert.deepEqual(ctx.calls, ["before"]);
});

/* ── removeMedia (the bin's delete) ── */
test("removeMedia: the entry and every clip using it go, after one beforeChange; unknown ids are refused", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  assert.deepEqual(E.removeMedia(d, "nope", ctx), { changed: false, created: [], removed: [], reason: "no-media" });
  assert.deepEqual(ctx.calls, []);
  const r = E.removeMedia(d, "m", ctx);
  assert.deepEqual([r.changed, r.removed], [true, ["v", "l", "r", "v2", "l2", "r2"]]);
  assert.deepEqual(ids(d.clips), ["song"]);
  assert.deepEqual(d.media.map((m) => m.id), ["s"]);
  assert.deepEqual(ctx.calls, ["before"]);
  assert.equal(JSON.parse(ctx.snaps[0]).length, 7, "the snapshot is the pre-edit doc");
  const bare = { clips: [] };
  assert.equal(E.removeMedia(bare, "m", ctx).reason, "no-media", "no media list at all");
});

/* ── setClipTiming (inspector start / length) ── */
test("setClipTiming: start and duration for the whole link group, clamped; in and speed follow (BUG-06)", () => {
  const d = linkedAv();
  const v = byId(d, "v");
  v.props.speed = 2;
  v.keyframes = { speed: [{ t: 0, v: 2 }] };
  byId(d, "l").keyframes = { volume: [{ t: 7, v: 0 }] };
  const ctx = mkCtx(d);
  const r = E.setClipTiming(d, v, { start: 3 }, ctx);
  assert.deepEqual(r, { changed: true, created: [], removed: [] });
  for (const id of ["v", "l", "r"]) {
    const x = byId(d, id);
    assert.deepEqual([x.start, x.duration, x.in, x.props.speed, x.keyframes.speed], [3, 8, 2, 2, [{ t: 0, v: 2 }]], id);
  }
  assert.deepEqual(byId(d, "l").keyframes.volume, [{ t: 7, v: 0 }], "a stem keeps its own channels");
  E.setClipTiming(d, byId(d, "r"), { duration: 2 }, ctx); // any member can be edited
  for (const id of ["v", "l", "r"]) assert.deepEqual([byId(d, id).start, byId(d, id).duration, byId(d, id).props.speed], [3, 2, 2], id);
  assert.deepEqual(byId(d, "l").keyframes.volume, [{ t: 7, v: 0 }], "keys past a shorter end are kept (typing is not trimming)");
  E.setClipTiming(d, v, { start: -4, duration: 0 }, ctx);
  for (const id of ["v", "l", "r"]) assert.deepEqual([byId(d, id).start, byId(d, id).duration], [0, MIN_DUR], id);
  E.setClipTiming(d, v, { start: NaN, duration: "x" }, mkCtx(d, { minDur: 0.5 }));
  assert.deepEqual([v.start, v.duration], [0, 0.5], "a non-number counts as 0; ctx.minDur");
  assert.deepEqual(ctx.calls, ["before", "before", "before"]);
});

test("setClipTiming: refused when nothing would change, or without a clip", () => {
  const d = linkedAv();
  const ctx = mkCtx(d);
  assert.equal(E.setClipTiming(d, byId(d, "v"), { start: 0, duration: 8 }, ctx).reason, "nothing");
  assert.equal(E.setClipTiming(d, byId(d, "v"), {}, ctx).reason, "nothing");
  assert.equal(E.setClipTiming(d, null, { start: 1 }, ctx).reason, "no-clip");
  assert.deepEqual(ctx.calls, []);
  byId(d, "r").start = 0.5; // a drifted stem: the same value re-syncs it
  assert.equal(E.setClipTiming(d, byId(d, "v"), { start: 0 }, ctx).changed, true);
  assert.equal(byId(d, "r").start, 0);
  assert.equal(E.setClipTiming(d, byId(d, "song"), { start: 2 }, undefined).changed, true, "ctx is optional");
});

/* ── Drag gestures ── */
test("beginDrag: captures the originals; a move of a selected clip drags the selection + partners", () => {
  const d = linkedAv();
  const g = E.beginDrag(d, byId(d, "v"), "move", { selIds: new Set(["v", "song"]) });
  assert.deepEqual(ids(g.group), ["v", "song", "l", "r"]);
  assert.deepEqual([...g.groupIds], ["v", "song", "l", "r"]);
  assert.equal(g.media, d.media[0]);
  assert.deepEqual(ids(E.beginDrag(d, byId(d, "v"), "move", { selIds: new Set(["song"]) }).group), ["v", "l", "r"], "not selected: just its link group");
  assert.deepEqual(ids(E.beginDrag(d, byId(d, "v"), "trim-l", { selIds: new Set(["v", "song"]) }).group), ["v", "l", "r"], "trims ignore the selection");
  const k = E.beginDrag(doc([clip("k", { keyframes: { x: [{ t: 1, v: 2 }] } })]), clip("k", { keyframes: { x: [{ t: 1, v: 2 }] } }), "trim-l");
  assert.deepEqual(k.orig.keyframes, { x: [{ t: 1, v: 2 }] });
  assert.equal(E.beginDrag(doc([]), clip("t", { mediaId: null }), "move").media, undefined);
});

test("dragTo move: one delta for the whole group, absolute from the originals, clamped at 0", () => {
  const d = linkedAv();
  const g = E.beginDrag(d, byId(d, "v2"), "move", { selIds: new Set(["v2", "song"]) });
  E.dragTo(d, g, 3, {});
  E.dragTo(d, g, 1);
  assert.deepEqual(["v2", "l2", "r2", "song"].map((id) => byId(d, id).start), [11, 11, 11, 1], "the last call wins");
  E.dragTo(d, g, -20);
  assert.deepEqual(["v2", "l2", "r2", "song"].map((id) => byId(d, id).start), [10, 10, 10, 0], "song hits 0 first");
  assert.equal(byId(d, "v2").duration, 4);
});

test("dragTo move: the edge closer to a snap target wins; a non-snapping edge never beats a real snap", () => {
  const d = doc([clip("a", { start: 10, duration: 4 })]);
  const g = E.beginDrag(d, d.clips[0], "move");
  const snapTo = (targets, tol = 0.3) => (t) => targets.find((s) => Math.abs(s - t) < tol) ?? t;
  E.dragTo(d, g, 1.1, { snap: snapTo([11]) });         // start 11.1 → 11
  assert.equal(d.clips[0].start, 11);
  E.dragTo(d, g, 1.1, { snap: snapTo([15.2]) });       // end 15.1 → 15.2
  near(d.clips[0].start, 11.2);
  E.dragTo(d, g, 1.1, { snap: snapTo([11, 15.15]) });  // end is 0.05 away, start 0.1 → end wins
  near(d.clips[0].start, 11.15);
  E.dragTo(d, g, 1.1, { snap: snapTo([11.2, 15]) });   // tie → the start
  near(d.clips[0].start, 11.2);
  E.dragTo(d, g, 1.1, { snap: snapTo([]) });
  near(d.clips[0].start, 11.1);
});

test("dragTo trim-l: media clips advance `in` by speed and can't reveal before in 0; partners follow", () => {
  const d = linkedAv();
  const v = byId(d, "v");
  v.props.speed = 2;
  v.keyframes = { x: [{ t: 0, v: 0 }, { t: 2, v: 4 }] };
  const g = E.beginDrag(d, v, "trim-l");
  E.dragTo(d, g, 1, { minDur: MIN_DUR });
  assert.deepEqual([v.start, v.in, v.duration], [1, 4, 7]);
  assert.deepEqual(v.keyframes.x, [{ t: -1, v: 0 }, { t: 1, v: 4 }], "the key before the new start stays as an anchor (D4)");
  for (const id of ["l", "r"]) assert.deepEqual([byId(d, id).start, byId(d, id).in, byId(d, id).props.speed], [1, 4, 2], id);
  E.dragTo(d, g, -5, {});
  assert.deepEqual([v.start, v.in, v.duration], [0, 2, 8], "clamped at the timeline start");
  assert.deepEqual(v.keyframes.x.map((k) => k.t), [0, 2], "re-based from the originals, not the last move");
  E.dragTo(d, g, 100, {});
  near(v.duration, MIN_DUR, 1e-9, "at most down to minDur");
  assert.deepEqual(v.keyframes, { x: [{ t: -5.95, v: 4 }] }, "only the anchor before 0 is left: it holds the value");
});

test("dragTo trim-l / trim-r: each linked member re-bases its own keyframes by the edge change (BUG-21)", () => {
  const d = linkedAv();
  const v = byId(d, "v"), l = byId(d, "l");
  v.keyframes = { x: [{ t: 1, v: 0 }, { t: 6, v: 9 }] };
  l.keyframes = { volume: [{ t: 0.5, v: 0 }, { t: 2, v: 1 }, { t: 7.5, v: 0 }] };
  const g = E.beginDrag(d, v, "trim-l");
  assert.deepEqual([...g.origs.keys()], ["v", "l", "r"], "originals for every member");
  E.dragTo(d, g, 1, {});
  assert.deepEqual(l.keyframes.volume.map((k) => k.t), [-0.5, 1, 6.5], "the stem's fade keeps its timeline place (and an anchor, D4)");
  assert.deepEqual(v.keyframes.x.map((k) => k.t), [0, 5]);
  assert.equal(byId(d, "r").keyframes, undefined);
  E.dragTo(d, g, 0, {});
  assert.deepEqual(l.keyframes.volume.map((k) => k.t), [0.5, 2, 7.5], "absolute from the originals");
  E.dragTo(d, E.beginDrag(d, v, "trim-r"), -3, {});
  assert.deepEqual([l.duration, l.keyframes.volume.map((k) => k.t)], [5, [0.5, 2, 7.5]]);
  assert.equal(E.beginDrag(d, v, "move").origs.size, 1, "a move keeps only the dragged clip's originals");
});

test("dragTo trim-l: a clamped edge lands exactly on its bound — in 0 at the media start, MIN_DUR at the tail (BUG-24)", () => {
  const c = clip("c", { start: 0.96, in: 0.425, duration: 0.5 });
  const d = doc([c], [{ id: "m", kind: "video", duration: 0.925 }]);
  const g = E.beginDrag(d, c, "trim-l");
  E.dragTo(d, g, -1.46, {});
  assert.equal(c.in, 0, "not 0.425 + (0.535 − 0.96) = −5.6e-17");
  E.dragTo(d, g, 5, {});
  assert.equal(c.duration, MIN_DUR);
  near(c.start + c.duration, 1.46, 1e-12, "the tail stays put");
});

test("dragTo trim-l: non-media clips keep in 0 and can extend left to the timeline start", () => {
  const t = clip("t", { kind: "text", mediaId: null, start: 3, in: 0.5 });
  const d = doc([t]);
  const g = E.beginDrag(d, t, "trim-l");
  E.dragTo(d, g, -2);
  assert.deepEqual([t.start, t.in, t.duration], [1, 0, 6]);
  E.dragTo(d, g, -10);
  assert.deepEqual([t.start, t.duration], [0, 7]);
  const img = clip("i", { kind: "image", mediaId: null, start: 3 });
  const d2 = doc([img]);
  E.dragTo(d2, E.beginDrag(d2, img, "trim-l"), 1, { snap: (x) => x + 0.5 });
  assert.deepEqual([img.start, img.in], [4.5, 0], "snap applies to the new start");
});

test("dragTo trim-l on a ramp: in follows the ramp integral; extending plays the speed held before the first key (BUG-12)", () => {
  const v = clip("v", { start: 2, in: 2, props: { speed: 1 }, keyframes: { speed: [{ t: 0, v: 3 }] } });
  const d = doc([v]);
  const g = E.beginDrag(d, v, "trim-l");
  E.dragTo(d, g, 1);
  near(v.in, 5, 1e-9, "in + ∫speed, not in + 1 × static speed 1");
  E.dragTo(d, g, -0.5);
  near(v.in, 0.5, 1e-9, "in − 0.5 × 3");
  E.dragTo(d, g, -2);
  assert.equal(v.in, 0, "stops where in reaches 0 at 3×");
  near(v.start, 2 - 2 / 3, 1e-12);
  near(v.start + v.duration, 6, 1e-12, "the tail stays put");
});

test("dragTo trim-l on a ramp with an anchor before 0: extending plays the interpolated curve, not the first value held (D4)", () => {
  // speed = 2 + t/2 on [−2, 2] (1× at the anchor, 3× at t 2), 1× before −2
  const v = clip("v", { start: 5, in: 3, keyframes: { speed: [{ t: -2, v: 1 }, { t: 2, v: 3, ease: "linear" }] } });
  const orig = { ...v, id: "orig", keyframes: JSON.parse(JSON.stringify(v.keyframes)) };
  const d = doc([v]);
  const g = E.beginDrag(d, v, "trim-l");
  E.dragTo(d, g, -1);
  near(v.in, 3 - 1.75, 1e-4, "in − ∫₋₁⁰ (2 + t/2) dt");
  assert.deepEqual(v.keyframes.speed.map((k) => k.t), [-1, 3]);
  for (const t of [5, 6, 9]) near(mediaTimeAt(v, t), mediaTimeAt(orig, t), 1e-3, `same source at ${t}`);
  E.dragTo(d, g, -5);
  assert.equal(v.in, 0);
  near(v.start, 3, 1e-9, "in reaches 0 after 2 s (∫₋₂⁰ = 3), not after 1.5 s at the 2× held at 0");
  near(v.start + v.duration, 9, 1e-12, "the tail stays put");
});

test("dragTo trim-r: stops at the media end; never below minDur; non-media is unbounded", () => {
  const d = linkedAv();
  const v2 = byId(d, "v2");
  E.dragTo(d, E.beginDrag(d, v2, "trim-r"), 100);
  assert.equal(v2.duration, 8, "media 20 s − in 12");
  assert.equal(byId(d, "l2").duration, 8);
  E.dragTo(d, E.beginDrag(d, v2, "trim-r"), -100);
  assert.equal(v2.duration, MIN_DUR);
  // BUG-01 (fixed in Phase 0.5): media now shorter than the in-point
  d.media[0].duration = 11;
  E.dragTo(d, E.beginDrag(d, v2, "trim-r"), 2);
  assert.equal(v2.duration, MIN_DUR);
  const t = clip("t", { kind: "text", mediaId: null, keyframes: { x: [{ t: 1, v: 1 }, { t: 3, v: 3 }] } });
  const d2 = doc([t]);
  E.dragTo(d2, E.beginDrag(d2, t, "trim-r"), 96, { minDur: 0.5 });
  assert.equal(t.duration, 100);
  E.dragTo(d2, E.beginDrag(d2, t, "trim-r"), -200, { minDur: 0.5 });
  assert.equal(t.duration, 0.5, "ctx.minDur");
  assert.deepEqual(t.keyframes, { x: [{ t: 1, v: 1 }] }, "only the first key past the new end is left (its anchor, D4)");
});

/* ── capToSource (a replaced, shorter source) ── */
test("capToSource: caps in, then cuts where the source window reaches the end — static speed, ramps, anchors, transitions (BUG-27)", () => {
  const c = clip("c", { in: 2, duration: 4, props: { speed: 2 }, transitionOut: { type: "fade", duration: 3 } });
  assert.equal(E.capToSource(c, 20), false, "fits: untouched");
  assert.equal(E.capToSource(c, 8), true);
  assert.deepEqual([c.in, c.duration, c.transitionOut], [2, 3, { type: "fade", duration: 3 }], "(8 − 2) / 2×");
  E.capToSource(c, 5);
  assert.deepEqual([c.duration, c.transitionOut.duration], [1.5, 1.5], "the transition fits the shorter clip");
  const past = clip("p", { in: 9, duration: 4 });
  E.capToSource(past, 5, { minDur: 0.1 });
  assert.deepEqual([past.in, past.duration], [4.999, 0.1], "in inside the file; never below minDur");
  const r = clip("r", { in: 0, duration: 4, keyframes: { speed: [{ t: 0, v: 3 }, { t: 1, v: 1, ease: "linear" }, { t: 2, v: 1 }, { t: 3, v: 2 }] } });
  E.capToSource(r, 2.5); // ∫₀¹ (3 − 2t) dt = 2, then 1× → 0.5 s more
  near(r.duration, 1.5, 1e-6);
  assert.deepEqual(r.keyframes.speed.map((k) => k.t), [0, 1, 2], "one anchor past the new end");
  near(mediaTimeAt(r, r.duration), 2.5, 1e-3);
});

/* ── Module ── */
test("module: frozen, with the documented surface", () => {
  assert.ok(Object.isFrozen(E));
  assert.deepEqual(Object.keys(E), ["GAP_EPS", "splitClipAt", "splitAt", "splitAtTimes", "trimClipTo", "trimToRange",
    "gapAt", "planCloseGap", "closeGapAt", "listAlignedGaps", "nextGap", "removeClips", "removeMedia", "setClipTiming",
    "capToSource", "beginDrag", "dragTo"]);
  assert.equal(E.GAP_EPS, 1e-4);
});
