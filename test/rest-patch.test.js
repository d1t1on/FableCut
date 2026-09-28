/* POST /api/patch: the REST face of core/patch.js — the same ops, validation
   gate and diff as MCP fablecut_patch_project, behind the same Host/Origin
   guard as every route. Refusals and dry runs must leave project.json
   byte-for-byte as it was. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { makeDataDir, readProject, seedProject, startServer } = require("./helpers");
const { OPS } = require("../core/patch");
const { validateProject } = require("../core/validate");
const { loadFixture } = require("./fixtures");

const boot = async (t, project) => {
  const dir = makeDataDir(t, project);
  const { base, port } = await startServer(t, dir);
  const raw = () => fs.readFileSync(path.join(dir, "project.json"), "utf8");
  return { dir, base, port, raw };
};
const post = async (base, body) => {
  const res = await fetch(base + "/api/patch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
/* fetch() can't set Host; the guard tests need a raw request */
const rawPost = (port, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/patch", headers }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { text += c; });
    res.on("end", () => resolve({ status: res.statusCode, body: text }));
  });
  req.on("error", reject);
  req.end(body);
});

test("POST /api/patch applies the ops, bumps the revision once, and returns notes + diff", async (t) => {
  const { dir, base } = await boot(t);
  const { status, body } = await post(base, { ops: [
    { op: "addMedia", media: { id: "m_b", kind: "audio", src: "/library/sfx/whoosh.mp3", duration: 1 } },
    { op: "addClip", clip: { id: "c_b", mediaId: "m_b", kind: "audio", track: "A1", start: 2, duration: 1 } },
    { op: "updateClip", id: "c_a", set: { props: { filterPreset: "noir" } } },
    { op: "setProject", set: { name: "Renamed" } },
  ] });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    ok: true, revision: 2,
    notes: ["+m_b", "+c_b", "~c_a", "~project"],
    diff: [
      'project name: "Test Project"→"Renamed"',
      '+m_b audio "whoosh.mp3" 1s',
      '~c_a props.filterPreset: ∅→"noir"',
      "+c_b A1 2s+1s audio(m_b)",
    ],
    warnings: [],
  });
  const doc = readProject(dir);
  assert.equal(doc.revision, 2, "one request is exactly one revision bump");
  assert.equal(doc.name, "Renamed");
  assert.equal(doc.clips.find((c) => c.id === "c_b").in, 0, "a missing `in` defaults to 0");
  assert.equal(doc.media.find((m) => m.id === "m_b").name, "whoosh.mp3");

  // generated ids come from the server; a warning-only patch still saves and reports it
  const next = await post(base, { ops: [
    { op: "addClip", clip: { kind: "text", track: "V2", start: 0, duration: 1, props: { txet: "typo" } } },
  ] });
  assert.equal(next.status, 200);
  assert.equal(next.body.revision, 3);
  assert.match(next.body.notes[0], /^\+c_[a-z0-9]+$/);
  assert.deepEqual(next.body.warnings.map((w) => [w.code, w.path]), [["UNKNOWN_PROP", `clips[${next.body.notes[0].slice(1)}].props.txet`]]);
});

test("POST /api/patch refuses a new validation error with 422 and writes nothing", async (t) => {
  const project = seedProject();
  project.clips.push({ id: "c_short", mediaId: "m_a", kind: "video", track: "V2", start: 0, in: 0, duration: 0.01 });
  const { base, raw } = await boot(t, project);
  const before = raw();
  const { status, body } = await post(base, { ops: [
    { op: "setProject", set: { name: "Half done" } },
    { op: "updateClip", id: "c_a", set: { props: { speed: 20 } } },
  ] });
  assert.equal(status, 422);
  assert.match(body.error, /would add 1 validation error/);
  assert.deepEqual(body.issues.map((i) => [i.severity, i.code, i.path]), [["error", "SCHEMA_MAXIMUM", "clips[c_a].props.speed"]],
    "only the new error is listed, not the one already on disk");
  assert.equal(raw(), before, "a refused patch must not write — not even the valid op before the bad one");

  // the error already on disk never blocks an unrelated edit
  const renamed = await post(base, { ops: [{ op: "setProject", set: { name: "Still editable" } }] });
  assert.equal(renamed.status, 200);
});

test("POST /api/patch answers 400 for bad JSON, a bad body and ops that fail", async (t) => {
  const { base, raw } = await boot(t);
  const before = raw();
  const cases = [
    ["{not json", /body must be JSON/],
    [[{ op: "setProject" }], /body must be a JSON object/],
    [{}, /`ops` must be a non-empty array/],
    [{ ops: [] }, /`ops` must be a non-empty array/],
    [{ ops: [{ op: "frobnicate" }] }, new RegExp(`^Unknown op: frobnicate \\(${OPS.map((o) => o.name).join("\\|")}\\)$`)],
    [{ ops: [{ op: "trimClip", id: "c_a", side: "in", t: 9 }] }, /^trimClip: nothing to trim at 9s — c_a spans 0s–5s/],
    [{ ops: [{ op: "setProject", set: { name: "x" } }, { op: "removeClip", id: "c_missing" }] }, /^removeClip: no clip c_missing$/],
    [{ ops: [{ op: "setProject", set: { revision: 99 } }] }, /not settable/],
    [{ ops: [{ op: "setProject", set: { encodeProfile: "no-such-profile" } }] }, /Unknown encoding profile "no-such-profile"/],
  ];
  for (const [body, re] of cases) {
    const res = await post(base, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, re);
  }
  assert.equal(raw(), before, "a failed patch must not write");
});

test("POST /api/patch runs the timeline ops: one trimClip trims the whole link group on disk", async (t) => {
  const { dir, base } = await boot(t, loadFixture("linked-av"));
  const { status, body } = await post(base, { ops: [{ op: "trimClip", id: "c_l", side: "in", t: 3 }] });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    ok: true, revision: 4,
    notes: ["trimmed c_l in to 3s: ~c_l ~c_v ~c_r"],
    diff: ["~c_v start: 0→3, duration: 8→5, in: 2→5", "~c_l start: 0→3, duration: 8→5, in: 2→5", "~c_r start: 0→3, duration: 8→5, in: 2→5"],
    warnings: [],
  });
  const doc = readProject(dir);
  assert.equal(doc.revision, 4);
  for (const id of ["c_v", "c_l", "c_r"]) {
    const c = doc.clips.find((x) => x.id === id);
    assert.deepEqual([c.start, c.in, c.duration], [3, 5, 5], id);
  }
  assert.deepEqual(validateProject(doc).filter((i) => i.severity === "error"), []);
});

test("POST /api/patch dryRun returns the would-be result and writes nothing", async (t) => {
  const { base, raw } = await boot(t);
  const before = raw();
  const ops = [{ op: "updateClip", id: "c_a", set: { start: 2 } }];
  const dry = await post(base, { ops, dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body, { ok: true, dryRun: true, revision: 2, notes: ["~c_a"], diff: ["~c_a start: 0→2"], warnings: [] });
  assert.equal(raw(), before, "a dry run must not write");

  const bad = await post(base, { ops: [{ op: "updateClip", id: "c_a", set: { start: null } }], dryRun: true });
  assert.equal(bad.status, 422);
  assert.equal(raw(), before);

  // the real thing then lands exactly as previewed
  const wet = await post(base, { ops });
  assert.deepEqual({ ...wet.body }, { ok: true, revision: 2, notes: ["~c_a"], diff: ["~c_a start: 0→2"], warnings: [] });
});

test("POST /api/patch sits behind the Host/Origin guard", async (t) => {
  const { port, raw } = await boot(t);
  const before = raw();
  const body = JSON.stringify({ ops: [{ op: "setProject", set: { name: "Pwned" } }] });
  const json = { "Content-Type": "application/json" };
  const byHost = await rawPost(port, { ...json, Host: "evil.example" }, body);
  assert.equal(byHost.status, 403);
  assert.match(byHost.body, /forbidden/);
  const byOrigin = await rawPost(port, { ...json, Host: `127.0.0.1:${port}`, Origin: "http://evil.example" }, body);
  assert.equal(byOrigin.status, 403);
  assert.equal(raw(), before, "a refused cross-origin patch must not write");

  const legit = await rawPost(port, { ...json, Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, body);
  assert.equal(legit.status, 200, legit.body);
});

test("a saved patch reaches the open UI through the SSE change event", {
  skip: process.platform === "win32" && "fs.watch on a temp data dir is unreliable on Windows (see rest-api.test.js)",
}, async (t) => {
  const { base } = await boot(t);
  const ac = new AbortController();
  t.after(() => ac.abort());
  const events = await fetch(base + "/api/events", { signal: ac.signal });
  const reader = events.body.getReader();
  const changed = (async () => {
    let seen = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      seen += Buffer.from(value).toString("utf8");
      if (/event: change/.test(seen)) return true;
    }
  })();
  const res = await post(base, { ops: [{ op: "setProject", set: { name: "Live" } }] });
  assert.equal(res.status, 200);
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000).unref());
  assert.equal(await Promise.race([changed, timeout]), true, "no SSE change event within 5 s of the patch");
});
