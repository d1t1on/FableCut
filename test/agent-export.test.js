"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evalBlocks } = require("./support/slice");

function editor({ cancel = false, revision = 7, workArea = true, ...busy } = {}) {
  const requests = [], exports = [];
  const state = { connected: true, ...busy };
  const runtime = { saveTimer: null };
  const api = evalBlocks({
    blocks: ["let exportRangeForced = null, renderCancelled = false, exportAbort = null;",
      ["/* ── Agent-requested Fast export ── */", "/* ── WebCodecs export"]],
    stubs: { state, runtime, project: { revision, clips: [{}] }, location: { search: "?exportJob=x_1" },
      syncFromServer: async () => {}, fetchEncodeProfiles: async () => {}, probeMissingMeta: async () => {},
      hasWorkArea: () => workArea, exportRange: () => ({ frames: 10 }),
      fastExport: async (args) => exports.push({ ...args, range: api.range() }),
      fetch: async (url, opts) => {
        requests.push({ url, body: opts?.body && JSON.parse(opts.body) });
        return { ok: true, json: async () => url.endsWith("/ffmpeg") ? { available: true }
          : url.includes("/ticket") ? { id: "x_1", revision: 7, range: "entire", status: "pending" }
          : { cancel } };
      } },
    exports: "runExportJob, runExportJobFromUrl, range: () => exportRangeForced, active: () => activeExportJob",
  });
  return { ...api, requests, exports, runtime };
}

test("agent export uses the Fast engine with its requested profile and range, then resets the override", async () => {
  const e = editor();
  await e.runExportJob({ id: "x_1", revision: 7, range: "entire", profile: "draft" });
  assert.deepEqual(e.exports, [{ job: "x_1", profile: "draft", range: "entire" }]);
  assert.equal(e.range(), null);
  assert.equal(e.active(), null);
});

test("headless URL dispatch loads the ticket and runs it", async () => {
  const e = editor();
  await e.runExportJobFromUrl();
  assert.equal(e.exports.length, 1);
});

test("BUG-37: headless startup waits for its metadata save before claiming the job", async () => {
  const e = editor();
  e.runtime.saveTimer = setTimeout(() => {
    e.runtime.saveTimer = null;
    e.runtime.savePending = new Promise((resolve) => setTimeout(() => {
      e.runtime.savePending = null; resolve();
    }, 60));
  }, 0);
  await e.runExportJobFromUrl();
  assert.equal(e.exports.length, 1);
  assert.equal(e.runtime.savePending, null, "the PUT has finished before export starts");
});

test("agent export refuses a stale loaded revision or missing work area", async () => {
  for (const options of [{ revision: 6 }, { workArea: false }]) {
    const e = editor(options);
    await e.runExportJob({ id: "x_1", revision: 7, range: "in-out" });
    assert.equal(e.exports.length, 0);
    assert.ok(e.requests.some((r) => r.body?.status === "failed"));
  }
});

test("a cancellation during preflight prevents rendering; a busy editor never claims", async () => {
  const e = editor({ cancel: true });
  await e.runExportJob({ id: "x_1" });
  assert.equal(e.exports.length, 0);
  for (const busy of [{ exporting: true }, { gesture: {} }]) {
    const b = editor(busy);
    await b.runExportJob({ id: "x_1" });
    assert.equal(b.requests.length, 0);
  }
});
