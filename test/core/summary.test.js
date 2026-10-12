/* core/summary.js: the compact view agents plan from, and the diff a patch
   reports. The compact text is pinned by summary.snapshot.json — captured
   from mcp-server.js BEFORE the formatter moved into core/, one entry per
   fixture plus edge docs (defaults, 3-digit hex, >12 markers, empty) — so
   the move was byte-identical; since then only the intended link:<group>
   (Phase 4b) was added. An intended format change regenerates it:
     FC_UPDATE_SNAPSHOT=1 node --test test/core/summary.test.js */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { compactClipLine, compactProject, diffProjects } = require("../../core/summary");
const { DEFAULT_PROPS } = require("../../core/schema");
const { loadFixture, listFixtures, build } = require("../fixtures");

const SNAP_FILE = path.join(__dirname, "summary.snapshot.json");
const SNAP = JSON.parse(fs.readFileSync(SNAP_FILE, "utf8"));
const REGEN = "FC_UPDATE_SNAPSHOT=1 node --test test/core/summary.test.js";

if (process.env.FC_UPDATE_SNAPSHOT === "1") {
  for (const entry of Object.values(SNAP)) entry.compact = compactProject(entry.doc);
  fs.writeFileSync(SNAP_FILE, JSON.stringify(SNAP, null, 2) + "\n");
}

test("compactProject prints exactly the pinned compact view", () => {
  assert.ok(Object.keys(SNAP).length >= 11);
  for (const [name, { doc, compact }] of Object.entries(SNAP))
    assert.equal(compactProject(doc), compact,
      `compact view of "${name}" drifted from test/core/summary.snapshot.json — fix core/summary.js, ` +
      `or if the new text is intended run: ${REGEN} (and review the snapshot diff)`);
});

test("the snapshot covers every fixture as it is today", () => {
  const missing = listFixtures().filter((n) => !SNAP[n]);
  assert.deepEqual(missing, [], `fixtures missing from test/core/summary.snapshot.json: add an entry {doc, compact} per fixture, then run: ${REGEN}`);
  for (const n of listFixtures())
    assert.deepEqual(SNAP[n].doc, loadFixture(n),
      `test/fixtures/${n}.json changed since the snapshot: copy it into the "${n}".doc entry of test/core/summary.snapshot.json, then run: ${REGEN}`);
});

test("compactClipLine hides props equal to the defaults it is given, and names the link group", () => {
  const c = build.clip("c_a", { mediaId: "m_a", inn: 2, props: { ...DEFAULT_PROPS, scale: 2 } });
  assert.equal(compactClipLine(c), 'c_a V1 0s+5s video(m_a in:2) {"scale":2}');
  assert.equal(compactClipLine({ ...c, linkGroup: "lg_a", name: "cam" }), 'c_a V1 0s+5s video(m_a in:2) link:lg_a "cam" {"scale":2}');
  assert.equal(compactClipLine(c, { ...DEFAULT_PROPS, scale: 2 }), "c_a V1 0s+5s video(m_a in:2)");
  // a malformed keyframe channel prints, it doesn't throw
  assert.equal(compactClipLine({ ...c, props: {}, keyframes: { x: null } }), "c_a V1 0s+5s video(m_a in:2) kf:x(0)");
});

const base = () => loadFixture("linked-av");
const edit = (fn) => { const d = base(); fn(d); return d; };
const clip = (d, id) => d.clips.find((c) => c.id === id);

test("diff: nothing changed, or only the revision, is an empty diff", () => {
  assert.deepEqual(diffProjects(base(), base()), []);
  assert.deepEqual(diffProjects(base(), edit((d) => { d.revision = 9; })), []);
  // key order inside props is not a change
  const a = base(), b = base();
  clip(b, "c_song").props = { ...clip(a, "c_song").props, pan: 0 };
  clip(a, "c_song").props = { pan: 0, ...clip(a, "c_song").props };
  assert.deepEqual(diffProjects(a, b), []);
});

test("diff: project fields, with ∅ for absent and long arrays as a count", () => {
  const after = edit((d) => {
    d.name = "Renamed";
    d.background = "#000000";
    delete d.inPoint;
    d.markers = Array.from({ length: 30 }, (_, i) => ({ t: i }));
  });
  assert.deepEqual(diffProjects(base(), after), [
    'project background: ∅→"#000000"',
    "project inPoint: 1→∅",
    'project markers: [{"t":2},{"t":6,"label":"drop"}]→[30 items]',
    'project name: "Linked AV"→"Renamed"',
  ]);
});

test("diff: added, removed and changed clips", () => {
  const after = edit((d) => {
    d.clips = d.clips.filter((c) => c.id !== "c_r2");
    Object.assign(clip(d, "c_v"), { start: 1 / 3, duration: 7.6666, track: "V2", transitionIn: { type: "fade", duration: 0.5 } });
    clip(d, "c_song").props = { volume: 0.5, filterPreset: "noir" };
    clip(d, "c_song").keyframes = { volume: [{ t: 0, v: 0 }, { t: 1, v: 1 }] };
    clip(d, "c_l").styleName = "impact";
    d.clips.push(build.clip("c_t", { kind: "text", track: "V2", start: 2, duration: 1, props: { text: "Hi" } }));
  });
  assert.deepEqual(diffProjects(base(), after), [
    "-c_r2", // removals first, then changes and additions in document order
    "~c_v track: \"V1\"→\"V2\", start: 0→0.333, duration: 8→7.667, transitionIn: ∅→fade/0.5",
    "~c_l styleName: ∅→\"impact\"",
    '~c_song props.filterPreset: ∅→"noir", props.volume: 0.3→0.5, kf.volume: ∅→2',
    '+c_t V2 2s+1s text {"text":"Hi"}',
  ]);
});

test("diff: media lines come before clip lines", () => {
  const after = edit((d) => {
    d.media.push(build.media("m_new", "audio", 3));
    d.media.find((m) => m.id === "m_song").duration = 31;
    d.media.find((m) => m.id === "m_song").folderId = "f_music";
    d.clips.find((c) => c.id === "c_song").mediaId = "m_new";
  });
  after.media = after.media.filter((m) => m.id !== "m_cam").concat(); // gone; its clips still point at it
  assert.deepEqual(diffProjects(base(), after), [
    "-m_cam",
    '~m_song duration: 30→31, folderId: ∅→"f_music"',
    '+m_new audio "m_new.mp3" 3s',
    '~c_song mediaId: "m_song"→"m_new"',
  ]);
});

test("diff: a keyframe edit that keeps the count, and malformed maps, still show", () => {
  const a = loadFixture("speed-ramp");
  const b = loadFixture("speed-ramp");
  clip(b, "c_ramp").keyframes.speed[1].v = 0.2;
  clip(b, "c_fast").props = 3;
  assert.deepEqual(diffProjects(a, b), ["~c_ramp kf.speed: 3→3", "~c_fast props: {\"speed\":2}→3"]);
});

test("diff: past the limit the rest collapse into one line", () => {
  const after = edit((d) => { for (const c of d.clips) c.start += 1; });
  const lines = diffProjects(base(), after, { limit: 3 });
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "… +4 more");
  assert.equal(diffProjects(base(), after).length, 7, "default limit is 20");
});

test("diff: repeated ids stay apart, and junk input never throws", () => {
  const a = build.project({ clips: [build.clip("c_d"), build.clip("c_d", { start: 5 })] });
  const b = build.project({ clips: [build.clip("c_d"), build.clip("c_d", { start: 6 })] });
  assert.deepEqual(diffProjects(a, b), ["~c_d#1 start: 5→6"]);
  assert.deepEqual(diffProjects(undefined, { clips: "nope", media: null }), []);
  assert.deepEqual(diffProjects({ clips: [null] }, { clips: [] }), ["-undefined"]);
  const long = { note: "x".repeat(80) };
  assert.match(diffProjects({}, { exportFrame: long })[0], /^project exportFrame: ∅→\{"note":"x+…$/);
});
