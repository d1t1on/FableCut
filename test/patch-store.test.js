"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { seedProject } = require("./helpers");

test("BUG-35: a write-time race reapplies the original patch on the latest document", () => {
  const { applyPatch } = require("../patch-store");
  let disk = seedProject(), reads = 0, writes = 0;
  const ops = [{ op: "moveClip", id: "c_a", dt: 1 }];
  const result = applyPatch({ ops }, {
    read() {
      if (++reads === 2) { disk = seedProject({ name: "UI edit", revision: 2 }); disk.clips[0].start = 3; }
      return structuredClone(disk);
    },
    write(doc) { writes++; disk = doc; },
  });
  assert.equal(writes, 1);
  assert.equal(result.revision, 3);
  assert.equal(disk.name, "UI edit");
  assert.equal(disk.clips[0].start, 4, "the delta applies once, to the latest start");
  assert.deepEqual(ops, [{ op: "moveClip", id: "c_a", dt: 1 }]);
  assert.ok(result.diff.some((line) => /start: 3→4/.test(line)));
});

test("BUG-35: an explicit base refuses a write-time race instead of retrying", () => {
  const { applyPatch } = require("../patch-store");
  let reads = 0, writes = 0;
  assert.throws(() => applyPatch({ baseRevision: 1, ops: [{ op: "setProject", set: { name: "Agent" } }] }, {
    read: () => seedProject({ revision: ++reads === 1 ? 1 : 2 }),
    write: () => writes++,
  }), (e) => e.status === 409 && e.revision === 2 && /CONFLICT/.test(e.message));
  assert.equal(writes, 0);
});

test("patch store refuses invalid bases and preserves validation and dry-run results", () => {
  const { applyPatch } = require("../patch-store");
  let writes = 0;
  const io = { read: () => seedProject(), write: () => writes++ };
  for (const baseRevision of ["1", 1.5, -1])
    assert.throws(() => applyPatch({ baseRevision, ops: [{ op: "setProject", set: { name: "X" } }] }, io), /baseRevision/);
  const dry = applyPatch({ baseRevision: 1, dryRun: true, ops: [{ op: "setProject", set: { name: "X" } }] }, io);
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.revision, 2);
  const bad = applyPatch({ ops: [{ op: "updateClip", id: "c_a", set: { start: null } }] }, io);
  assert.equal(bad.ok, false);
  assert.ok(bad.newErrors.length);
  assert.equal(writes, 0);
});

test("patch store bounds retries when another writer keeps changing the revision", () => {
  const { applyPatch } = require("../patch-store");
  let reads = 0, writes = 0;
  assert.throws(() => applyPatch({ ops: [{ op: "setProject", set: { name: "Agent" } }] }, {
    read: () => seedProject({ revision: ++reads }), write: () => writes++,
  }), (e) => e.status === 409);
  assert.equal(writes, 0);
  assert.equal(reads, 8);
});
