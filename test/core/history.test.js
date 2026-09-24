/* core/history.js — the undo/redo stacks behind app.js pushUndo / undo / redo,
   the clip-drag gesture and syncFromServer's reset. test/edit-ops.test.js runs
   them through the app wrappers; this file pins the pure API. Snapshots are
   opaque strings here: what goes into one (the document content — see
   core/project.js snapshotContent) is the app's choice. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createHistory } = require("../../core/history");

test("push → undo → redo: each step hands back the snapshot to restore", () => {
  const h = createHistory();
  h.push("s0");
  h.push("s1");
  assert.deepEqual(h.size(), { undo: 2, redo: 0 });
  assert.equal(h.undo("s2"), "s1", "undo restores the latest push");
  assert.equal(h.undo("s1"), "s0");
  assert.deepEqual(h.size(), { undo: 0, redo: 2 });
  assert.equal(h.redo("s0"), "s1", "redo restores what the last undo replaced");
  assert.equal(h.redo("s1"), "s2");
  assert.deepEqual(h.size(), { undo: 2, redo: 0 });
});

test("undo / redo on an empty stack return null and change nothing", () => {
  const h = createHistory();
  assert.equal(h.undo("now"), null);
  assert.equal(h.redo("now"), null);
  assert.deepEqual(h.size(), { undo: 0, redo: 0 });
  h.push("a");
  assert.equal(h.redo("now"), null, "nothing undone yet");
  assert.deepEqual(h.size(), { undo: 1, redo: 0 });
});

test("a new push clears the redo stack", () => {
  const h = createHistory();
  h.push("a");
  h.undo("b");
  assert.equal(h.size().redo, 1);
  h.push("c");
  assert.deepEqual(h.size(), { undo: 1, redo: 0 });
  assert.equal(h.undo("d"), "c");
});

test("the limit drops the oldest entries (default 100)", () => {
  const h = createHistory();
  for (let i = 0; i < 105; i++) h.push("s" + i);
  assert.equal(h.size().undo, 100);
  let last;
  for (let s = h.undo("now"); s != null; s = h.undo(s)) last = s;
  assert.equal(last, "s5", "s0…s4 were dropped");

  const small = createHistory({ limit: 2 });
  for (const s of ["a", "b", "c"]) small.push(s);
  assert.deepEqual(small.size(), { undo: 2, redo: 0 });
  assert.equal(small.undo("x"), "c");
  assert.equal(small.undo("c"), "b");
  assert.equal(small.undo("b"), null);
});

test("redo refills without trimming: undo + redo never exceed the limit", () => {
  const h = createHistory({ limit: 3 });
  for (const s of ["a", "b", "c"]) h.push(s);
  h.undo("d"); h.undo("c");
  h.redo("b"); h.redo("c");
  assert.deepEqual(h.size(), { undo: 3, redo: 0 });
  assert.equal(h.undo("d"), "c");
});

test("clear empties both stacks", () => {
  const h = createHistory();
  h.push("a"); h.push("b"); h.undo("c");
  h.clear();
  assert.deepEqual(h.size(), { undo: 0, redo: 0 });
  assert.equal(h.undo("x"), null);
});

test("histories are independent, frozen, and size() is a fresh record", () => {
  const a = createHistory(), b = createHistory();
  a.push("a");
  assert.deepEqual(b.size(), { undo: 0, redo: 0 });
  assert.ok(Object.isFrozen(a));
  const s = a.size();
  s.undo = 99;
  assert.equal(a.size().undo, 1);
});
