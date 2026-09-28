/* MCP tool semantics: the editing contract agents actually drive — patch ops,
   validation, and the optimistic-concurrency rules documented in CLAUDE.md.
   fablecut_status is deliberately not exercised: it spawns the editor server as
   a side effect, which is covered directly in rest-api.test.js instead. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDataDir, readProject, writeProject, seedProject, startMcp } = require("./helpers");

const boot = async (t, project) => {
  const dir = makeDataDir(t, project);
  const mcp = startMcp(t, dir);
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  return { dir, mcp };
};

test("fablecut_docs returns the manual, and can slice it by section", async (t) => {
  const { mcp } = await boot(t);
  const full = await mcp.callTool("fablecut_docs");
  assert.match(full.text, /# FableCut/);

  const section = await mcp.callTool("fablecut_docs", { section: "schema" });
  assert.ok(section.text.length < full.text.length, "a section must be smaller than the manual");
  assert.match(section.text, /^## /, "a section slice starts at its heading");
  assert.match(section.text, /props reference/i);

  // Every section name the manual advertises as an example must resolve —
  // only `## ` headings are searched, so a `###`-only example is a dead end.
  for (const name of ["schema", "Recipes", "Remake", "Export", "REST API"]) {
    const hit = await mcp.callTool("fablecut_docs", { section: name });
    assert.match(hit.text, /^## /, `the manual advertises section "${name}" but it matches nothing`);
  }

  // An unmatched section is a helpful listing, not an error or a crash.
  const miss = await mcp.callTool("fablecut_docs", { section: "no-such-section" });
  assert.equal(miss.isError, false);
  assert.match(miss.text, /No '## ' section matches/);
});

test("fablecut_get_project returns the document, and compact hides default props", async (t) => {
  const project = seedProject();
  // Defaults the UI persists on every clip; the compact view should drop them.
  project.clips[0].props = { scale: 1, opacity: 1, volume: 1, filterPreset: "noir" };
  const { mcp } = await boot(t, project);

  const full = JSON.parse((await mcp.callTool("fablecut_get_project")).text);
  assert.equal(full.revision, 1);
  assert.equal(full.clips[0].props.scale, 1, "the full document keeps every prop");

  const { text } = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.match(text, /c_a V1 0s\+5s video/, "compact lists the clip");
  assert.match(text, /filterPreset/, "a non-default prop must survive");
  assert.doesNotMatch(text, /"scale"/, "default-valued props must be hidden");
});

test("fablecut_patch_project applies a batch atomically and bumps the revision once", async (t) => {
  const { dir, mcp } = await boot(t);
  const { text, isError } = await mcp.callTool("fablecut_patch_project", {
    ops: [
      { op: "addMedia", media: { id: "m_b", kind: "audio", src: "/library/sfx/whoosh.mp3" } },
      { op: "addClip", clip: { id: "c_b", mediaId: "m_b", kind: "audio", track: "A1", start: 2, duration: 3 } },
      { op: "updateClip", id: "c_a", set: { props: { filterPreset: "noir" } } },
      { op: "setProject", set: { name: "Renamed" } },
    ],
  });
  assert.equal(isError, false, text);

  const doc = readProject(dir);
  assert.equal(doc.revision, 2, "one patch call is exactly one revision bump");
  assert.equal(doc.name, "Renamed");
  assert.equal(doc.media.length, 2);
  assert.equal(doc.clips.find((c) => c.id === "c_b").track, "A1");
  assert.equal(doc.clips.find((c) => c.id === "c_a").props.filterPreset, "noir");
  // addMedia fills in a name from the src when one is not supplied.
  assert.equal(doc.media.find((m) => m.id === "m_b").name, "whoosh.mp3");
});

test("fablecut_patch_project reports a Changes diff, and dryRun previews without saving", async (t) => {
  const { dir, mcp } = await boot(t);
  const ops = [{ op: "updateClip", id: "c_a", set: { start: 2, props: { filterPreset: "noir" } } }];
  const dry = await mcp.callTool("fablecut_patch_project", { ops, dryRun: true });
  assert.equal(dry.isError, false, dry.text);
  assert.equal(dry.text, 'DRY RUN — nothing saved.\nPatched (revision 2): ~c_a. Now 1 clip(s), 1 media.\n' +
    'Changes:\n  ~c_a start: 0→2, props.filterPreset: ∅→"noir"');
  assert.deepEqual(readProject(dir), seedProject(), "a dry run must not write");

  const refused = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "updateClip", id: "c_a", set: { start: null } }], dryRun: true });
  assert.ok(refused.isError, "a dry run of an invalid patch is refused like the real one");
  assert.match(refused.text, /REJECTED — nothing saved/);

  const wet = await mcp.callTool("fablecut_patch_project", { ops });
  assert.equal(wet.text, 'Patched (revision 2): ~c_a. Now 1 clip(s), 1 media. UI hot-reloaded.\n' +
    'Changes:\n  ~c_a start: 0→2, props.filterPreset: ∅→"noir"');
  assert.equal(readProject(dir).revision, 2);

  // the compact view on the wire is core/summary's text, byte for byte
  const { compactProject } = require("../core/summary");
  const compact = await mcp.callTool("fablecut_get_project", { compact: true });
  assert.equal(compact.text, compactProject(readProject(dir)));
});

test("updateClip merges into props, and null deletes a key", async (t) => {
  const project = seedProject();
  project.clips[0].props = { filterPreset: "noir", scale: 2 };
  const { dir, mcp } = await boot(t, project);

  await mcp.callTool("fablecut_patch_project", {
    ops: [{ op: "updateClip", id: "c_a", set: { props: { opacity: 0.5, filterPreset: null } } }],
  });
  const props = readProject(dir).clips[0].props;
  assert.equal(props.scale, 2, "untouched props survive a merge");
  assert.equal(props.opacity, 0.5, "new props are merged in");
  assert.ok(!("filterPreset" in props), "null removes a prop");
});

test("patch ops reject edits that would corrupt the timeline", async (t) => {
  const { dir, mcp } = await boot(t);
  const cases = [
    [{ op: "addClip", clip: { id: "c_x", mediaId: "m_nope", kind: "video", track: "V1", start: 0, duration: 1 } },
      /unknown mediaId/i],
    [{ op: "addClip", clip: { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, duration: 1 } },
      /duplicate clip id/i],
    [{ op: "addClip", clip: { id: "c_y", mediaId: "m_a", kind: "video", track: "V1" } },
      /addClip needs/i],
    [{ op: "updateClip", id: "c_missing", set: { start: 1 } }, /no clip/i],
    [{ op: "removeClip", id: "c_missing" }, /no clip/i],
    [{ op: "removeMedia", id: "m_a" }, /is used by clip c_a/i],
    [{ op: "setProject", set: { revision: 99 } }, /not settable/i],
    [{ op: "frobnicate" }, /Unknown op/i],
  ];
  for (const [op, expected] of cases) {
    const { text, isError } = await mcp.callTool("fablecut_patch_project", { ops: [op] });
    assert.ok(isError, `${op.op} should have been rejected, got: ${text}`);
    assert.match(text, expected);
  }
  const empty = await mcp.callTool("fablecut_patch_project", { ops: [] });
  assert.ok(empty.isError, "an empty op list is a mistake, not a no-op");

  // Nothing above may have touched the document.
  assert.deepEqual(readProject(dir), seedProject(), "rejected patches must not write");
});

test("splitClip over stdio: one op cuts a linked AV group, the file on disk holds the pieces", async (t) => {
  const { loadFixture } = require("./fixtures");
  const { validateProject } = require("../core/validate");
  const { dir, mcp } = await boot(t, loadFixture("linked-av"));
  const { text, isError } = await mcp.callTool("fablecut_patch_project", { ops: [{ op: "splitClip", id: "c_v", t: 4 }] });
  assert.equal(isError, false, text);
  const doc = readProject(dir);
  assert.equal(doc.revision, 4, "one patch, one revision bump");
  const pieces = doc.clips.slice(7); // the right pieces are appended, in clip order
  assert.deepEqual(pieces.map((c) => [c.track, c.start, c.in, c.duration]), [["V1", 4, 6, 4], ["A1", 4, 6, 4], ["A2", 4, 6, 4]]);
  const [v, l, r] = pieces.map((c) => c.id);
  assert.match(text, new RegExp(`^Patched \\(revision 4\\): split at 4s: c_v→\\+${v}, c_l→\\+${l}, c_r→\\+${r}\\. Now 10 clip\\(s\\), 2 media\\.`));
  const lg = pieces[0].linkGroup;
  assert.match(lg, /^lg_/);
  assert.ok(pieces.every((c) => c.linkGroup === lg), "the right pieces form one new link group");
  for (const id of ["c_v", "c_l", "c_r"]) assert.equal(doc.clips.find((c) => c.id === id).duration, 4, id);
  assert.match(text, new RegExp(`\\n  \\+${v} V1 4s\\+4s video\\(m_cam in:6\\) link:${lg} "cam"`), "the Changes diff shows the new piece and its group");
  assert.deepEqual(validateProject(doc).filter((i) => i.severity === "error"), []);
});

test("text and adjust clips need no media, unlike footage clips", async (t) => {
  const { dir, mcp } = await boot(t);
  const { isError, text } = await mcp.callTool("fablecut_patch_project", {
    ops: [
      { op: "addClip", clip: { id: "c_t", mediaId: null, kind: "text", track: "V2", start: 0, duration: 2, props: { text: "Hi" } } },
      { op: "addClip", clip: { id: "c_j", mediaId: null, kind: "adjust", track: "V3", start: 0, duration: 1, props: { shake: 18 } } },
    ],
  });
  assert.equal(isError, false, text);
  assert.equal(readProject(dir).clips.length, 3);
});

test("fablecut_set_project refuses to clobber an edit made behind its back", async (t) => {
  const { dir, mcp } = await boot(t);
  const doc = JSON.parse((await mcp.callTool("fablecut_get_project")).text);

  // The user drags a clip in the UI while the agent is thinking.
  writeProject(dir, { ...readProject(dir), revision: 7, name: "Edited in the UI" });

  doc.name = "Agent edit";
  const conflict = await mcp.callTool("fablecut_set_project", { project: doc });
  assert.ok(conflict.isError, "a stale save must be refused");
  assert.match(conflict.text, /CONFLICT/);
  assert.equal(readProject(dir).name, "Edited in the UI", "the user's work must survive");

  // force is the documented escape hatch.
  const forced = await mcp.callTool("fablecut_set_project", { project: doc, force: true });
  assert.equal(forced.isError, false, forced.text);
  const after = readProject(dir);
  assert.equal(after.name, "Agent edit");
  assert.ok(after.revision > 7, "a forced save still moves the revision forward");
});

test("fablecut_encode_profiles lists shipped presets and rejects an unknown id", async (t) => {
  const { mcp } = await boot(t);

  const listed = await mcp.request("tools/list");
  const names = listed.result.tools.map((x) => x.name);
  assert.ok(names.includes("fablecut_encode_profiles"), "tools/list must advertise the new tool");

  const summary = JSON.parse((await mcp.callTool("fablecut_encode_profiles")).text);
  assert.equal(summary.default, "delivery");
  assert.ok(summary.profiles.delivery, "the shipped delivery profile must be listed");
  assert.equal(summary.profiles.delivery.args, undefined, "the compact list omits the ffmpeg args array");
  assert.ok(summary.profiles.delivery.summary, "the compact list still has a summary string");

  const detailed = JSON.parse((await mcp.callTool("fablecut_encode_profiles", { detail: true })).text);
  assert.ok(Array.isArray(detailed.profiles.delivery.args), "detail:true includes the args array");
  assert.ok(detailed.profiles.delivery.args.includes("-c:v"), "shipped args look like ffmpeg flags");

  const one = JSON.parse((await mcp.callTool("fablecut_encode_profiles", { profile: "delivery" })).text);
  assert.equal(one.profile, "delivery");
  assert.equal(one.extension, ".mp4");
  assert.ok(Array.isArray(one.args) && one.args.length, "a known id returns its args");

  const miss = await mcp.callTool("fablecut_encode_profiles", { profile: "no-such-profile" });
  assert.ok(miss.isError, "an unknown profile id must be flagged isError");
  assert.match(miss.text, /Unknown encoding profile/i);
});

test("fablecut_set_project validates the document before writing it", async (t) => {
  const { dir, mcp } = await boot(t);
  const before = readProject(dir);
  const cases = [
    [{ project: "nope" }, /must be an object/i],
    [{ project: { clips: [] } }, /clips.*media/i],
    // per-clip checks are the validator's now: the message names the code and field
    [{ project: { media: [], clips: [{ track: "V1", start: 0, duration: 1 }] } }, /SCHEMA_REQUIRED clips\[0\]\.id/],
    [{ project: { media: [], clips: [{ id: "c", kind: "video", mediaId: "m_ghost", track: "V1", start: 0, duration: 1 }] } },
      /MEDIA_NOT_FOUND clips\[c\]\.mediaId/],
  ];
  for (const [args, expected] of cases) {
    const { text, isError } = await mcp.callTool("fablecut_set_project", args);
    assert.ok(isError, `should have been rejected: ${JSON.stringify(args)}`);
    assert.match(text, expected);
  }
  assert.deepEqual(readProject(dir), before, "an invalid save must leave the file untouched");
});

test("fablecut_import_media copies a local file and registers it", async (t) => {
  const { dir, mcp } = await boot(t);
  const src = path.join(dir, "take.mp4");
  fs.writeFileSync(src, "clip-bytes");
  const { text, isError } = await mcp.callTool("fablecut_import_media", { path: src });
  assert.equal(isError, false, text);
  const entry = JSON.parse(text.replace(/^Imported → /, "").split("\n")[0]);
  assert.equal(entry.kind, "video");
  assert.equal(entry.src, "/media/take.mp4");
  assert.ok(fs.existsSync(path.join(dir, "media", "take.mp4")));
  const doc = readProject(dir);
  assert.equal(doc.media.some((m) => m.id === entry.id && m.src === entry.src), true);
  assert.equal(doc.revision, 2);
});

test("fablecut_import_media rejects http and loopback https URLs", async (t) => {
  const { dir, mcp } = await boot(t);
  const http = await mcp.callTool("fablecut_import_media", { path: "http://example.com/a.mp4" });
  assert.ok(http.isError);
  assert.match(http.text, /https/i);
  const loop = await mcp.callTool("fablecut_import_media", { path: "https://127.0.0.1/a.mp4" });
  assert.ok(loop.isError);
  assert.match(loop.text, /blocked/i);
  assert.equal(readProject(dir).media.length, 1, "a rejected import must not add media");
});
