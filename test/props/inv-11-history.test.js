/* INV-11: undo / redo. undo(op(p)) ≡ p for the WHOLE document and
   redo(undo(op(p))) ≡ op(p); an op that changes nothing leaves the history
   alone; and over any sequence the history behaves like a model stack
   (fast-check fc.commands) in which lane toggles are never undone. The
   session wires history exactly like app.js: ctx.beforeChange = pushUndo,
   a snapshot is the document content (clips, media, folders — D3), drags
   push their pointerdown snapshot on release when they changed anything. */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const A = require("../support/arb");
const O = require("../support/ops");

const whole = (doc) => JSON.parse(JSON.stringify(doc)); // every field; key order doesn't matter
const UNDO = { op: "undo" }, REDO = { op: "redo" };

/* After an arbitrary prefix (so there is history to disturb), run `op`; if it
   recorded an undo step, undo must restore p and redo must restore op(p). */
function roundTrip(fc, opArb) {
  fc.assert(fc.property(A.arbProject(), O.arbOps(O.F.ALL, { maxLength: 5 }), opArb, (raw, prefix, op) => {
    const s = O.play(raw, prefix);
    const p = whole(s.doc), n = s.history.size().undo;
    O.runOp(s, op);
    if (s.history.size().undo === n) return;
    const q = whole(s.doc);
    try {
      O.runOp(s, UNDO);
      assert.deepEqual(whole(s.doc), p, "undo(op(p)) ≠ p");
      O.runOp(s, REDO);
      assert.deepEqual(whole(s.doc), q, "redo(undo(op(p))) ≠ op(p)");
    } catch (e) { throw O.explain(e, s); }
  }));
}

propTest("INV-11a: undo restores the whole document after any clip edit, and redo re-applies it", (fc) => {
  roundTrip(fc, O.arbOp([...O.F.EDIT, "setTiming"]));
});
propTest("INV-11b: undo restores the whole document after a media entry is removed with its clips", (fc) => {
    roundTrip(fc, O.arbOp(["removeMedia"]));
  });

/* An op that leaves the document as it was must not add an undo step (nor
   clear redo). */
function noOpRecordsNothing(names) {
  return (fc) => fc.assert(fc.property(A.arbProject(), O.arbOps(O.F.ALL, { maxLength: 5 }), O.arbOp(names), (raw, prefix, op) => {
    const s = O.play(raw, prefix);
    const p = JSON.stringify(s.doc), h = s.history.size();
    O.runOp(s, op);
    if (JSON.stringify(s.doc) !== p) return;
    try { assert.deepEqual(s.history.size(), h, "a no-op changed the history"); } catch (e) { throw O.explain(e, s); }
  }));
}
propTest("INV-11c: a split, delete, gap close or trim to IN/OUT that changes nothing records nothing",
  noOpRecordsNothing(["split", "splitAtWorkArea", "delete", "closeGap", "trimToWorkArea"]));
propTest("INV-11d: a trim to playhead that changes nothing records nothing", noOpRecordsNothing(["trimToPlayhead"]));
propTest("INV-11e: a drag that ends where it started records nothing", noOpRecordsNothing(["move", "trimL", "trimR"]));

/* Model-based: the model is two stacks of whole-document states. An edit
   that records a step pushes the pre-edit state and clears redo (whether it
   SHOULD record is INV-11c–e); undo / redo must land exactly on the model's
   state, and the real stack depths must match the model's. A lane toggle is
   not an undo step and is never undone (D3): undo / redo land on the model's
   state with the lanes enabled as they are now. */
class Edit {
  constructor(op) { this.op = op; }
  check() { return true; }
  run(m, s) {
    const before = whole(s.doc), n = s.history.size().undo;
    O.runOp(s, this.op);
    if (s.history.size().undo > n) { m.undo.push(before); m.redo = []; }
    depths(m, s);
  }
  toString() { return JSON.stringify(this.op); }
}
class Step {
  constructor(dir) { this.dir = dir; }
  check() { return true; }
  run(m, s) {
    const [from, to] = this.dir === "undo" ? [m.undo, m.redo] : [m.redo, m.undo];
    const cur = whole(s.doc);
    O.runOp(s, { op: this.dir });
    if (from.length) {
      to.push(cur);
      const want = { ...from.pop(), disabledTracks: cur.disabledTracks }; // toggles stay
      assert.deepEqual(whole(s.doc), want, `${this.dir} did not restore the model state (with today's lane toggles)`);
    } else assert.deepEqual(whole(s.doc), cur, `${this.dir} on an empty stack changed the doc`);
    depths(m, s);
  }
  toString() { return this.dir; }
}
class Toggle {
  constructor(op) { this.op = op; }
  check() { return true; }
  run(m, s) {
    O.runOp(s, this.op);
    depths(m, s); // not an undo step
  }
  toString() { return JSON.stringify(this.op); }
}
function depths(m, s) {
  assert.deepEqual(s.history.size(), { undo: m.undo.length, redo: m.redo.length }, "stack depths differ from the model");
}
propTest("INV-11f: over any edit / undo / redo / lane-toggle sequence the history matches a model stack, toggles never undone (fc.commands)", (fc) => {
  const cmds = fc.commands([
    O.arbOp([...O.F.EDIT, "removeMedia", "setTiming"]).map((op) => new Edit(op)),
    O.arbOp(["toggleLane"]).map((op) => new Toggle(op)),
    fc.constant(new Step("undo")), fc.constant(new Step("undo")),
    fc.constant(new Step("redo")),
  ], { maxCommands: 30 });
  fc.assert(fc.property(A.arbProject(), cmds, (raw, list) => {
    const s = O.createSession(raw);
    try { fc.modelRun(() => ({ model: { undo: [], redo: [] }, real: s }), list); } catch (e) { throw O.explain(e, s); }
  }));
});
