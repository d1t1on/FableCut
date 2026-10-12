"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createExportJobs } = require("../export-jobs");

function jobs(t) {
  const events = [], ended = [];
  const api = createExportJobs({ editors: () => 1, broadcast: (...a) => events.push(a),
    url: () => "unused", onEnd: (id) => ended.push(id) });
  t.after(() => api.shutdown());
  return { api, events, ended };
}

test("export jobs claim once, clamp progress, end once and preserve results", (t) => {
  const { api, events, ended } = jobs(t);
  const j = api.request({ range: "in-out", profile: "draft", revision: 9 });
  assert.equal(j.via, "tab");
  assert.deepEqual(JSON.parse(events[0][1]), { id: j.id, range: "in-out", profile: "draft", revision: 9, status: "pending" });
  assert.equal(api.claim(j.id), true);
  assert.equal(api.claim(j.id), false);
  api.report(j.id, { progress: 4 });
  assert.equal(api.get(j.id).progress, 1);
  api.report(j.id, { status: "done", src: "/exports/test.mp4" });
  api.cancel(j.id);
  api.report(j.id, { status: "failed", error: "late" });
  assert.equal(api.get(j.id).status, "done");
  assert.equal(api.get(j.id).src, "/exports/test.mp4");
  assert.deepEqual(ended, [j.id]);
  assert.equal(api.get("missing"), null);
});

test("unclaimed jobs expire; stalled jobs fail; finished jobs expire after an hour", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const { api, ended } = jobs(t);
  const pending = api.request({});
  t.mock.timers.tick(21_000);
  assert.equal(api.get(pending.id).status, "failed");
  const running = api.request({});
  api.claim(running.id);
  t.mock.timers.tick(100_000);
  api.report(running.id, { progress: 0.2 });
  t.mock.timers.tick(100_000);
  assert.equal(api.get(running.id).status, "running", "heartbeat renews the lease");
  t.mock.timers.tick(21_000);
  assert.equal(api.get(running.id).status, "failed");
  assert.equal(ended.length, 2);
  t.mock.timers.tick(3_600_001);
  assert.equal(api.get(running.id), null);
  assert.equal(api.ticket(pending.id), null);
});

test("shutdown cancels jobs and cancellation tells a running tab to stop", (t) => {
  const { api, ended } = jobs(t);
  const j = api.request({});
  api.claim(j.id);
  api.shutdown();
  assert.equal(api.get(j.id).status, "cancelled");
  assert.deepEqual(api.report(j.id, { progress: 0.5 }), { cancel: true });
  api.shutdown();
  assert.deepEqual(ended, [j.id]);
});
