/* MCP validation gate: patch/set refuse edits that ADD a validation error
   (core/validate.js), a problem already on disk never blocks an unrelated edit,
   new warnings are reported, and fablecut_validate / fablecut_status expose the
   same verdict. Same harness as mcp-tools.test.js. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeDataDir, readProject, seedProject, startMcp, startServer } = require("./helpers");
const { DEFAULT_PROPS, PATCHABLE_PROJECT_FIELDS } = require("../core/schema");

const boot = async (t, project, env) => {
  const dir = makeDataDir(t, project);
  const mcp = startMcp(t, dir, env);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  return { dir, mcp };
};
const patch = (mcp, ...ops) => mcp.callTool("fablecut_patch_project", { ops });
/* seedProject() plus a clip that is already an error on disk */
const brokenOnDisk = () => {
  const p = seedProject();
  p.clips.push({ id: "c_short", mediaId: "m_a", kind: "video", track: "V2", start: 0, in: 0, duration: 0.01 });
  return p;
};

test("a patch that would add an error is refused with its code, and nothing is written", async (t) => {
  const { dir, mcp } = await boot(t);
  const cases = [
    [[{ op: "addClip", clip: { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 6, duration: 1 } }], /DUP_CLIP_ID/],
    [[{ op: "updateClip", id: "c_a", set: { start: null } }], /SCHEMA_REQUIRED clips\[c_a\]\.start/],
    [[{ op: "updateClip", id: "c_a", set: { props: { speed: 20 } } }], /SCHEMA_MAXIMUM clips\[c_a\]\.props\.speed/],
    [[{ op: "updateClip", id: "c_a", set: { track: "A1" } }], /TRACK_KIND_MISMATCH/],
    [[{ op: "addMedia", media: { id: "m_a", kind: "audio", src: "/media/x.mp3" } }], /DUP_MEDIA_ID/],
    // all-or-nothing: a valid op before the bad one is not applied either
    [[{ op: "setProject", set: { name: "Half done" } }, { op: "updateClip", id: "c_a", set: { duration: 0 } }],
      /SCHEMA_EXCLUSIVE_MINIMUM clips\[c_a\]\.duration/],
  ];
  for (const [ops, expected] of cases) {
    const { text, isError } = await patch(mcp, ...ops);
    assert.ok(isError, `should have been refused: ${JSON.stringify(ops)} → ${text}`);
    assert.match(text, expected);
  }
  const gated = await patch(mcp, { op: "updateClip", id: "c_a", set: { start: null } });
  assert.match(gated.text, /REJECTED — nothing saved/);
  assert.match(gated.text, /resend the whole patch/, "the refusal says how to recover");
  assert.deepEqual(readProject(dir), seedProject(), "refused patches must not write");
});

test("updateClip cannot change a clip's id", async (t) => {
  const { dir, mcp } = await boot(t);
  const renamed = await patch(mcp, { op: "updateClip", id: "c_a", set: { id: "c_x" } });
  assert.ok(renamed.isError);
  assert.match(renamed.text, /ids are immutable/);
  assert.deepEqual(readProject(dir), seedProject());

  // echoing the clip's own id back (a whole-clip `set`) is not a rename
  const same = await patch(mcp, { op: "updateClip", id: "c_a", set: { id: "c_a", name: "Same" } });
  assert.equal(same.isError, false, same.text);
  assert.equal(readProject(dir).clips[0].name, "Same");
});

test("addClip and set_project default a missing `in` to 0 and say so", async (t) => {
  const { dir, mcp } = await boot(t);
  const added = await patch(mcp,
    { op: "addClip", clip: { id: "c_t", mediaId: null, kind: "text", track: "V2", start: 0, duration: 2 } });
  assert.equal(added.isError, false, added.text);
  assert.match(added.text, /Defaulted in:0 on 1 clip\b/);
  assert.equal(readProject(dir).clips.find((c) => c.id === "c_t").in, 0);

  const doc = JSON.parse((await mcp.callTool("fablecut_get_project")).text);
  for (const c of doc.clips) delete c.in;
  const saved = await mcp.callTool("fablecut_set_project", { project: doc });
  assert.equal(saved.isError, false, saved.text);
  assert.match(saved.text, /Defaulted in:0 on 2 clips/);
  assert.deepEqual(readProject(dir).clips.map((c) => c.in), [0, 0]);
});

test("setProject takes every patchable field (tracks, folders, IN/OUT, exportFrame) and nothing else", async (t) => {
  const { dir, mcp } = await boot(t);
  const listed = await mcp.request("tools/list");
  const desc = listed.result.tools.find((x) => x.name === "fablecut_patch_project").description;
  for (const k of PATCHABLE_PROJECT_FIELDS) assert.match(desc, new RegExp(`\\b${k}\\b`), `the description must document ${k}`);

  const set = {
    tracks: [{ id: "V2", kind: "video" }, { id: "V1", kind: "video" }, { id: "A1", kind: "audio" }],
    folders: [{ id: "f_b", name: "B-roll", parentId: null, open: true }],
    inPoint: 1, outPoint: 4, exportFrame: { x: 438, y: 0, w: 404, h: 720 },
  };
  const ok = await patch(mcp, { op: "setProject", set });
  assert.equal(ok.isError, false, ok.text);
  const doc = readProject(dir);
  for (const [k, v] of Object.entries(set)) assert.deepEqual(doc[k], v, `${k} was not saved`);

  for (const bad of [{ revision: 99 }, { clips: [] }, { bogus: 1 }]) {
    const res = await patch(mcp, { op: "setProject", set: bad });
    assert.ok(res.isError, `${Object.keys(bad)[0]} must not be settable`);
    assert.match(res.text, /not settable \(allowed: .*tracks/);
  }
});

test("fablecut_set_project refuses duplicate ids", async (t) => {
  const { dir, mcp } = await boot(t);
  const before = readProject(dir);
  const doc = JSON.parse((await mcp.callTool("fablecut_get_project")).text);
  const dupClip = structuredClone(doc);
  dupClip.clips.push({ ...dupClip.clips[0], start: 6 });
  const dupMedia = structuredClone(doc);
  dupMedia.media.push({ ...dupMedia.media[0], name: "b.mp4" });
  for (const [project, code] of [[dupClip, /DUP_CLIP_ID clips\[c_a\]\.id/], [dupMedia, /DUP_MEDIA_ID/]]) {
    const res = await mcp.callTool("fablecut_set_project", { project });
    assert.ok(res.isError, res.text);
    assert.match(res.text, code);
    assert.match(res.text, /resend the complete document/);
  }
  assert.deepEqual(readProject(dir), before);
});

test("a problem already on disk never blocks an unrelated edit, but a second one is new", async (t) => {
  const { dir, mcp } = await boot(t, brokenOnDisk());
  const renamed = await patch(mcp, { op: "setProject", set: { name: "Still editable" } });
  assert.equal(renamed.isError, false, renamed.text);
  assert.equal(readProject(dir).name, "Still editable");

  const doc = JSON.parse((await mcp.callTool("fablecut_get_project")).text);
  doc.name = "Whole doc";
  const saved = await mcp.callTool("fablecut_set_project", { project: doc });
  assert.equal(saved.isError, false, saved.text);

  const second = await patch(mcp,
    { op: "addClip", clip: { id: "c_b", mediaId: "m_a", kind: "video", track: "V3", start: 0, in: 0, duration: 0.02 } });
  assert.ok(second.isError, "the same kind of error on another clip is new");
  assert.match(second.text, /DURATION_TOO_SHORT clips\[c_b\]\.duration/);
  assert.doesNotMatch(second.text, /c_short/, "only new errors are listed");
});

test("the patch result lists new warnings, not the ones already on disk", async (t) => {
  const project = seedProject();
  project.clips[0].props = { oldTypo: 1 };
  const { dir, mcp } = await boot(t, project);
  const res = await patch(mcp, { op: "updateClip", id: "c_a", set: { props: { speedd: 2 } } });
  assert.equal(res.isError, false, "warnings never block");
  assert.match(res.text, /New warnings \(1\)/);
  assert.match(res.text, /UNKNOWN_PROP clips\[c_a\]\.props\.speedd: .* — did you mean "speed"\?/);
  assert.doesNotMatch(res.text, /oldTypo/);
  assert.equal(readProject(dir).clips[0].props.speedd, 2, "the warned edit is still saved");

  const quiet = await patch(mcp, { op: "setProject", set: { name: "No news" } });
  assert.doesNotMatch(quiet.text, /New warnings/);
});

test("fablecut_validate checks project.json, or a candidate without saving it", async (t) => {
  const { dir, mcp } = await boot(t, brokenOnDisk());
  const disk = await mcp.callTool("fablecut_validate");
  assert.equal(disk.isError, false);
  assert.match(disk.text, /^project\.json \(revision 1\): 1 error, 0 warnings\./);
  assert.match(disk.text, /error DURATION_TOO_SHORT clips\[c_short\]\.duration/);
  assert.match(disk.text, /schema[\\/]project\.schema\.json/);
  assert.match(disk.text, /fablecut_docs \{section:"Validation"\}/);

  const clean = await mcp.callTool("fablecut_validate", { project: seedProject() });
  assert.match(clean.text, /^Candidate project \(not saved\): 0 errors, 0 warnings\.\nNo problems found\./);

  const fast = seedProject();
  Object.assign(fast.clips[0], { duration: 1, props: { speed: 9 } }); // 1 s at the clamped 8× still fits the media
  delete fast.clips[0].in;
  const bad = await mcp.callTool("fablecut_validate", { project: fast });
  assert.match(bad.text, /1 error, 1 warning/);
  assert.match(bad.text, /error SCHEMA_MAXIMUM clips\[c_a\]\.props\.speed[^\n]*\nwarning IN_MISSING/, "errors are listed first");

  const notObj = await mcp.callTool("fablecut_validate", { project: "nope" });
  assert.ok(notObj.isError);
  assert.deepEqual(readProject(dir), brokenOnDisk(), "validate never writes");
});

test("fablecut_status includes the validation summary", async (t) => {
  const dir = makeDataDir(t, brokenOnDisk());
  // a running editor on a private port, so status finds it instead of spawning one
  // (PORT too: a server it did spawn would inherit it rather than take 7777)
  const { port } = await startServer(t, dir);
  const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port), PORT: String(port) });
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const { text, isError } = await mcp.callTool("fablecut_status");
  assert.equal(isError, false, text);
  assert.match(text, /Editor server: RUNNING/);
  assert.match(text, /^Validation: 1 error, 0 warnings — fablecut_validate lists them$/m);
});

test("compact view hides every default the UI persists, text-box props included", async (t) => {
  const project = seedProject();
  project.clips = [
    { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, in: 0, duration: 5,
      props: { ...DEFAULT_PROPS, filterPreset: "noir" } },
    { id: "c_t", mediaId: null, kind: "text", track: "V2", start: 0, in: 0, duration: 2,
      props: { ...DEFAULT_PROPS, text: "Hello", font: "Anton" } },
    // a linked stem: pan 0 is meaningful there and must stay visible
    { id: "c_l", mediaId: "m_a", kind: "audio", track: "A1", start: 0, in: 0, duration: 5,
      props: { ...DEFAULT_PROPS, audioChannel: 0, pan: 0 } },
  ];
  const { mcp } = await boot(t, project);
  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  const line = (id) => text.split("\n").find((l) => l.includes(` ${id} `));
  assert.match(line("c_a"), / \{"filterPreset":"noir"\}$/);
  assert.match(line("c_t"), / \{"text":"Hello","font":"Anton"\}$/);
  assert.match(line("c_l"), / \{"pan":0,"audioChannel":0\}$/);
  assert.doesNotMatch(text, /direction|boxW|boxH|boxFit|vAlign|strokeColor|bgColor/);
});
