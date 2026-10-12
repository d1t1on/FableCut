/* External writes (agent / MCP) applied by app.js syncFromServer: what the
   user is told. The undo-reset notice and the validation report used to be two
   toasts, the second replacing the first; they are now one. Driven through
   test/drivers/edit.js (the real syncFromServer / applyProject /
   reportProjectIssues, core/validate.js behind them). */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditDriver } = require("./drivers/edit");
const { loadFixture } = require("./fixtures");

const RESET = "Project was updated externally — undo history was reset";
const REDO = "Project was updated externally — your last change may need redoing.";
/* linked-av at a newer revision with one clip id used twice (1 error) */
const brokenWrite = () => {
  const doc = loadFixture("linked-av");
  doc.revision = 10;
  doc.clips.push({ ...doc.clips[0] });
  return doc;
};
const cleanWrite = () => ({ ...loadFixture("linked-av"), revision: 10 });

test("given undo history, when an external write with errors lands, then one toast carries both and the history is empty", async () => {
  const ed = createEditDriver(loadFixture("linked-av")).at(4);
  ed.split();
  ed.log.toasts.length = 0;
  await ed.externalWrite(brokenWrite());
  assert.deepEqual(ed.log.toasts, [`${RESET} · project.json has 1 problem — see the browser console`]);
  assert.deepEqual(ed.history(), { undo: 0, redo: 0 });
  assert.ok(ed.log.console.some((m) => /1 error\(s\)/.test(m)), "the console group still lists the issues");
});

test("given undo history, when a clean external write lands, then the reset toast reads as before", async () => {
  const ed = createEditDriver(loadFixture("linked-av")).at(4);
  ed.split();
  ed.undo(); // redo-only history counts too
  ed.log.toasts.length = 0;
  await ed.externalWrite(cleanWrite());
  assert.deepEqual(ed.log.toasts, [`${RESET}.`]);
  assert.deepEqual(ed.history(), { undo: 0, redo: 0 });
});

test("given no history, when an external write with errors lands, then only the problem toast shows", async () => {
  const ed = createEditDriver(loadFixture("linked-av"));
  await ed.externalWrite(brokenWrite());
  assert.deepEqual(ed.log.toasts, ["project.json has 1 problem — see the browser console"]);
});

test("given no history and a clean write, when synced, then nothing is toasted", async () => {
  const ed = createEditDriver(loadFixture("linked-av"));
  await ed.externalWrite(cleanWrite());
  assert.deepEqual(ed.log.toasts, []);
});

test("given an unsaved local edit, when an external write with errors lands, then both toasts fire as before", async () => {
  const ed = createEditDriver(loadFixture("linked-av")).at(4);
  ed.split();
  ed.runtime.saveTimer = setTimeout(() => {}, 60_000); // the debounced save still pending
  ed.log.toasts.length = 0;
  await ed.externalWrite(brokenWrite());
  assert.equal(ed.runtime.saveTimer, null, "the pending save is dropped");
  assert.deepEqual(ed.log.toasts, [REDO, "project.json has 1 problem — see the browser console"]);
});
