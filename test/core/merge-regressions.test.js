"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../core/project");
const L = require("../../core/links");
const { validateProject } = require("../../core/validate");
const { build } = require("../fixtures");

test("BUG-29: v1.9 locks, unlink flags and colored markers survive the core round trip", () => {
  const doc = build.project({ clips: [build.clip("v", { locked: true, disabled: true, unlinked: true })],
    lockedTracks: ["V1"], untargetedTracks: ["A1"], markers: [{ t: 2, label: "cue", color: "red" }] });
  const out = P.serializeProject(P.normalizeProject(doc).project);
  assert.deepEqual(out.lockedTracks, ["V1"]);
  assert.deepEqual(out.untargetedTracks, ["A1"]);
  for (const k of ["locked", "disabled", "unlinked"]) assert.equal(out.clips[0][k], true);
  assert.deepEqual(out.markers, doc.markers);
  assert.deepEqual(validateProject(out).filter((i) => /UNKNOWN_CLIP_FIELD|SCHEMA_ADDITIONAL/.test(i.code)), []);
});

test("BUG-30: explicitly unlinked audio and video stay separate on reload, including legacy pairs", () => {
  for (const who of ["v", "a"]) {
    const clips = [build.clip("v", { linkedId: "a" }), build.clip("a", { kind: "audio", track: "A1", linkedId: "v" })];
    clips.find(c => c.id === who).unlinked = true;
    L.relinkClips(clips);
    assert.ok(clips.every(c => !c.linkGroup && !c.linkedId));
  }
});

test("BUG-31: marker undo/redo is scoped to marker edits and shares the content history", () => {
  const { createHistory } = require("../../core/history");
  const p = P.normalizeProject(build.project()).project;
  const h = createHistory();
  const snap = (markers) => P.snapshotContent(p, { markers });
  const current = (entry) => snap(Object.hasOwn(JSON.parse(entry), "markers"));
  h.push(snap(true));
  p.markers = [{ t: 3, label: "beat", color: "cyan" }];
  P.restoreContent(p, h.undo(current));
  assert.deepEqual(p.markers, []);
  P.restoreContent(p, h.redo(current));
  assert.equal(p.markers[0].color, "cyan");
  h.push(snap(false));
  p.markers[0].t = 4; // a later marker change must not be reverted by a clip-only entry
  P.restoreContent(p, h.undo(current));
  assert.equal(p.markers[0].t, 4);
});

test("BUG-32: a real end-edge snap beats the closer frame-grid rounding on a clip move", () => {
  const E = require("../../core/edit");
  const c = build.clip("v", { start: 1, duration: 2 });
  const d = build.project({ clips: [c] });
  const drag = E.beginDrag(d, c, "move");
  E.dragTo(d, drag, 0.01, { snapInfo: t => t < 2 ? { t: 1, hit: false } : { t: 3.04, hit: true } });
  assert.ok(Math.abs(c.start - 1.04) < 1e-9);
});

test("BUG-33: timeline patches honor inferred linked locks and explicit force on splits", () => {
  const { patchProject } = require("../../core/patch");
  let n = 0;
  const ctx = { newId: () => "c_" + ++n, newLinkId: () => "lg_" + ++n };
  const doc = build.project({ media: [build.media("m")], clips: [
    build.clip("v", { mediaId: "m" }), build.clip("a", { mediaId: "m", kind: "audio", track: "A1", locked: true }),
  ] });
  for (const op of [{ op: "moveClip", id: "v", dt: 1 }, { op: "trimClip", id: "v", side: "out", t: 3 },
    { op: "setTiming", id: "v", duration: 3 }, { op: "splitClip", ids: ["v"], t: 2 }]) {
    const r = patchProject(doc, [op], ctx);
    assert.equal(r.ok, false, JSON.stringify(op));
    assert.match(r.error, /locked/);
  }
  const r = patchProject(doc, [{ op: "splitClip", id: "v", t: 2, force: true }], ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.doc.clips.length, 4);
});

test("merged edit context: targeting and group locks filter split, work-area trim and gap moves", () => {
  const E = require("../../core/edit");
  let n = 0;
  const ctx = { newId: () => "c_" + ++n, newLinkId: () => "lg_" + ++n,
    isEnabled: () => true, isTarget: lane => lane === "V1", canEdit: c => c.id !== "locked" };
  const doc = () => build.project({ clips: [build.clip("yes"), build.clip("locked"), build.clip("other", { track: "V2" })] });
  let d = doc();
  assert.equal(E.splitAt(d, 2, {}, ctx).created.length, 1);
  assert.equal(d.clips.find(c => c.id === "locked").duration, 5);
  assert.equal(d.clips.find(c => c.id === "other").duration, 5);
  d = doc();
  assert.equal(E.splitAt(d, 2, { selIds: new Set(["other"]) }, ctx).created.length, 1, "selection overrides targeting");
  d = doc();
  E.splitAtTimes(d, [2], ctx);
  assert.equal(d.clips.find(c => c.id === "locked").duration, 5);
  assert.equal(d.clips.find(c => c.id === "yes").duration, 2);
  d = doc();
  E.trimToRange(d, 1, 4, ctx);
  assert.equal(d.clips.find(c => c.id === "locked").duration, 5);
  assert.equal(d.clips.find(c => c.id === "yes").duration, 3);
  d = build.project({ clips: [build.clip("yes", { start: 4 }), build.clip("locked", { start: 4 })] });
  E.closeGapAt(d, 2, ["V1"], ctx);
  assert.equal(d.clips[0].start, 0);
  assert.equal(d.clips[1].start, 4);
});

test("merged snapping: nearest actual target wins, ties prefer the start, grids only round the start", () => {
  const E = require("../../core/edit");
  for (const [a, b, expected] of [
    [{ t: 1.25, hit: true }, { t: 3.125, hit: true }, 1.125],
    [{ t: 1.125, hit: true }, { t: 3.25, hit: true }, 1.125],
    [{ t: 1.125, hit: true }, { t: 2.875, hit: true }, 1.125],
    [{ t: 1.125, hit: false }, { t: 3, hit: false }, 1.125],
  ]) {
    const c = build.clip("v", { start: 1, duration: 2 });
    const d = build.project({ clips: [c] });
    E.dragTo(d, E.beginDrag(d, c, "move"), 0, { snapInfo: t => t < 2 ? a : b });
    assert.equal(c.start, expected, JSON.stringify([a, b]));
  }
});

test("merged automatic links: unlinked true opts out on either side, false allows inference", () => {
  for (const who of ["v", "a"]) for (const unlinked of [true, false]) {
    const clips = [build.clip("v", { mediaId: "m" }), build.clip("a", { mediaId: "m", kind: "audio", track: "A1" })];
    clips.find(c => c.id === who).unlinked = unlinked;
    L.relinkClips(clips);
    assert.equal(!!clips[0].linkGroup, !unlinked);
    assert.equal(!!clips[1].linkGroup, !unlinked);
  }
});
