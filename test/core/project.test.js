/* core/project.js — the data side of load (normalizeProject) and save
   (serializeProject), plus the field normalizers and lane-def handling app.js
   used to own. test/edit-ops.test.js runs load/save through app.js's
   applyProject / projectJSON wrappers; this file pins the pure API. Also the
   undo snapshots (snapshotContent / restoreContent, D3). */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const P = require("../../core/project");
const { DEFAULT_PROPS } = require("../../core/schema");
const { listFixtures, loadFixture, build } = require("../fixtures");
const { createEditDriver } = require("../drivers/edit");

const load = (doc, opts = {}) => P.normalizeProject(doc, opts);
/* load + save, the way a project.json round-trips through the editor */
const roundTrip = (doc) => {
  const n = load(doc);
  return JSON.parse(JSON.stringify(P.serializeProject(n.project, n.project.tracks)));
};
const ids = (list) => list.map((t) => t.id);
const find = (doc, id) => doc.clips.find((c) => c.id === id);

/* ── Load / save over every fixture ── */
for (const name of listFixtures()) {
  test(`normalizeProject(${name}): full props, finite in, sorted lanes that cover every clip`, () => {
    const doc = loadFixture(name);
    const { project: p } = load(doc);
    assert.equal(p.clips, doc.clips, "data.clips is adopted, not copied");
    assert.equal(p.panSchema, 1);
    assert.equal(ids(p.tracks).length, new Set(ids(p.tracks)).size, "unique lanes");
    assert.deepEqual(p.tracks, P.sortTrackDefs(p.tracks), "V-high → V1, then A1 → An");
    for (const c of p.clips) {
      assert.ok(Number.isFinite(c.in), `${c.id}.in`);
      for (const k of Object.keys(DEFAULT_PROPS)) assert.ok(k in c.props, `${c.id} props.${k}`);
      assert.ok(p.tracks.some((t) => t.id === c.track), `${c.id} lane ${c.track}`);
      assert.equal(c.linkedId, undefined, "legacy linkedId is replaced by linkGroup");
    }
    for (const id of p.disabledTracks) assert.ok(p.tracks.some((t) => t.id === id), `disabled ${id}`);
  });

  test(`serializeProject ∘ normalizeProject is idempotent on ${name}`, () => {
    const once = roundTrip(loadFixture(name));
    const twice = roundTrip(JSON.parse(JSON.stringify(once)));
    // byte-identical, key order included: a reload + save must not churn the file
    assert.equal(JSON.stringify(twice), JSON.stringify(once));
  });

  test(`${name}: the core round trip equals what app.js's applyProject + projectJSON save`, () => {
    const core = P.normalizeProject(loadFixture(name), { prevFps: 30 });
    const viaCore = JSON.parse(JSON.stringify(P.serializeProject(core.project)));
    assert.deepEqual(createEditDriver(loadFixture(name)).save(), viaCore);
  });
}

/* ── normalizeProject ── */
test("normalizeProject: project fields, defaults and a fresh copy of everything but clips", () => {
  const doc = loadFixture("lanes-bin");
  doc.markers = [{ t: 4 }, null, { t: "x" }, { t: 2, label: "b" }];
  doc.media[0].folderId = "f_gone";
  const { project: p } = load(doc);
  assert.deepEqual(
    [p.name, p.width, p.height, p.fps, p.background, p.revision, p.encodeProfile],
    ["Lanes and bin", 1280, 720, 25, "#101014", 5, "delivery"]);
  assert.deepEqual(p.markers, [{ t: 2, label: "b" }, { t: 4 }], "invalid markers dropped, sorted");
  assert.equal(p.media[0].folderId, null, "a media entry in a missing folder moves to the root");
  assert.equal(p.media[1].folderId, "f_gfx");
  assert.equal(p.media[2].folderId, null);
  assert.notEqual(p.media[1], doc.media[1], "media entries are copies");
  assert.deepEqual(p.exportFrame, { x: 438, y: 0, w: 404, h: 720 });
  assert.deepEqual(p.disabledTracks, ["A5"]);
  assert.deepEqual(ids(p.tracks), ["V4", "V3", "V2", "V1", "A1", "A2", "A3", "A4", "A5"]);
  assert.deepEqual(Object.keys(p), ["name", "width", "height", "fps", "background", "revision", "folders", "media",
    "clips", "markers", "inPoint", "outPoint", "exportFrame", "encodeProfile", "tracks", "disabledTracks", "panSchema"]);

  const bare = load({ clips: [] }, { prevFps: 24 }).project;
  assert.deepEqual(
    [bare.name, bare.width, bare.height, bare.fps, bare.background, bare.revision, bare.encodeProfile, bare.exportFrame],
    ["Untitled Project", 1280, 720, 24, "#000000", 0, null, null]);
  assert.deepEqual([bare.folders, bare.media, bare.markers, bare.disabledTracks], [[], [], [], []]);
  assert.deepEqual(ids(bare.tracks), ["V3", "V2", "V1", "A1", "A2", "A3", "A4"]);
  assert.deepEqual(load({}).project.clips, [], "no clips → a new empty array");
});

test("normalizeProject: fps keeps prevFps (default 30) unless data.fps is > 0", () => {
  assert.equal(load({ fps: "50" }).project.fps, 50);
  assert.equal(load({ fps: 0 }, { prevFps: 25 }).project.fps, 25);
  assert.equal(load({ fps: "x" }).project.fps, 30);
});

test("normalizeProject: clips get in = 0 when missing, props merged over DEFAULT_PROPS, keyframes sorted", () => {
  const doc = build.project({
    clips: [
      { id: "t", kind: "text", track: "V2", start: 0, duration: 2 },
      build.clip("v", { inn: "1.5", props: { opacity: 0.5, custom: 1 }, keyframes: { x: [{ t: 2, v: 1 }, { t: 0, v: 0 }], bad: "no" } }),
    ],
  });
  const t0 = doc.clips[0];
  const { project: p } = load(doc);
  assert.equal(p.clips[0], t0, "clip objects are normalized in place");
  assert.equal(t0.in, 0);
  assert.deepEqual(t0.props, { ...DEFAULT_PROPS });
  const v = p.clips[1];
  assert.equal(v.in, 1.5, "numeric strings are coerced");
  assert.equal(v.props.opacity, 0.5);
  assert.equal(v.props.custom, 1, "unknown props are kept");
  assert.deepEqual(Object.keys(v.props), [...Object.keys(DEFAULT_PROPS), "custom"], "default key order first");
  assert.deepEqual(v.keyframes.x.map((k) => k.t), [0, 2]);
  assert.equal(v.keyframes.bad, "no", "non-array channels are left alone");
  assert.equal(load(build.project({ clips: [build.clip("n", { inn: NaN })] })).project.clips[0].in, 0);
});

test("normalizeProject: image/text/adjust clips load with in = 0; video/audio/svg keep theirs (D5)", () => {
  const kinds = ["video", "audio", "svg", "image", "text", "adjust"];
  const doc = build.project({
    clips: kinds.map((kind) => ({ id: kind, kind, mediaId: kind === "text" || kind === "adjust" ? null : "m",
      track: kind === "audio" ? "A1" : "V1", start: 0, in: 2.5, duration: 2 })),
  });
  const { project: p } = load(doc);
  assert.deepEqual(p.clips.map((c) => [c.kind, c.in]),
    [["video", 2.5], ["audio", 2.5], ["svg", 2.5], ["image", 0], ["text", 0], ["adjust", 0]]);
});

test("normalizeProject: fonts lists each text clip's family once, in clip order", () => {
  const text = (id, font) => build.clip(id, { kind: "text", track: "V2", props: font === undefined ? {} : { font } });
  const { fonts } = load(build.project({
    clips: [text("a", "Anton"), build.clip("v", { props: { font: "Nope" } }), text("b", "Cinzel"), text("c", "Anton"), text("d", ""), text("e")],
  }));
  assert.deepEqual(fonts, ["Anton", "Cinzel", DEFAULT_PROPS.font]);
});

test("normalizeProject: pan migration runs once, only for docs without panSchema", () => {
  const first = load(loadFixture("legacy"));
  assert.equal(first.migrated, true, "the app must save once to persist it");
  const clip = (id) => find(first.project, id);
  assert.deepEqual([clip("c_oa").props.pan, clip("c_ob").props.pan], [-1, 1], "stems hard-panned by channel");
  assert.equal(clip("c_ov").props.pan, 0, "no audioChannel → default pan");

  const saved = JSON.parse(JSON.stringify(P.serializeProject(first.project)));
  assert.equal(saved.panSchema, 1);
  const second = load(saved);
  assert.equal(second.migrated, false);
  assert.deepEqual([find(second.project, "c_oa").props.pan, find(second.project, "c_ob").props.pan], [-1, 1]);

  // a deliberately centered stem in a pan-aware doc stays centered
  const centered = loadFixture("linked-av");
  delete find(centered, "c_l").props.pan;
  const r = load(centered);
  assert.equal(r.migrated, false);
  assert.equal(find(r.project, "c_l").props.pan, 0);

  // explicit pan and non-integer / negative channels are left alone by the migration
  const old = build.project({
    panSchema: undefined,
    clips: [
      build.clip("x", { kind: "audio", track: "A1", props: { audioChannel: 1, pan: 0.25 } }),
      build.clip("y", { kind: "audio", track: "A2", props: { audioChannel: 1.5 } }),
      build.clip("z", { kind: "audio", track: "A3", props: { audioChannel: -1 } }),
      build.clip("w", { kind: "audio", track: "A4", props: { audioChannel: 2 } }),
    ],
  });
  assert.deepEqual(load(old).project.clips.map((c) => c.props.pan), [0.25, 0, 0, 0]);
});

test("normalizeProject: relinks video + stems by media and timing; legacy linkedId becomes a linkGroup (lg_<video id>)", () => {
  const { project: p } = load(loadFixture("legacy"));
  const g = find(p, "c_ov").linkGroup;
  assert.equal(g, "lg_c_ov");
  assert.deepEqual(["c_oa", "c_ob"].map((id) => find(p, id).linkGroup), [g, g]);
  assert.equal(find(p, "c_far").linkGroup, undefined, "different timing → not linked");
  assert.doesNotThrow(() => P.normalizeProject(loadFixture("legacy"), {}), "no id factory needed");
});

test("normalizeProject: linkGroup ids on disk are kept (D1, BUG-11a)", () => {
  const { project: p } = load(loadFixture("linked-av"));
  assert.deepEqual(["c_v", "c_l", "c_r"].map((id) => find(p, id).linkGroup), ["lg_cam", "lg_cam", "lg_cam"]);
  assert.deepEqual(["c_v2", "c_l2", "c_r2"].map((id) => find(p, id).linkGroup), ["lg_cam2", "lg_cam2", "lg_cam2"]);
});

test("normalizeProject: a stem whose timing drifted stays linked — the validator flags it (D1, BUG-11b)", () => {
  const doc = loadFixture("linked-av");
  find(doc, "c_r").start = 0.5;
  const { project: p } = load(doc);
  assert.equal(find(p, "c_r").linkGroup, "lg_cam");
  assert.equal(find(p, "c_l").linkGroup, "lg_cam");
});

test("normalizeProject: lanes — clips on undeclared lanes add them, disabled lanes must exist", () => {
  const doc = build.project({
    tracks: [{ id: "V1", kind: "video" }, { id: "A1", kind: "audio" }],
    disabledTracks: ["A1", "V9", "A1", "A2"],
    clips: [build.clip("a", { track: "A2", kind: "audio" }), build.clip("b", { track: "V3" }), build.clip("c", { track: "V3" })],
  });
  const { project: p } = load(doc);
  assert.deepEqual(ids(p.tracks), ["V3", "V1", "A1", "A2"]);
  assert.deepEqual(p.disabledTracks, ["A1", "A2"], "unknown dropped, deduped, sorted; covered lanes count");
});

/* ── serializeProject ── */
test("serializeProject: allowlists, key order, transient media and optional fields", () => {
  const { project: p } = load(loadFixture("lanes-bin"));
  p.media.push({ id: "m_tmp", name: "rec.webm", kind: "video", src: "blob:x", transient: true, extra: 1 });
  p.clips[0].extra = "dropped";
  p.clips[0].linkedId = "c_svg";
  const out = P.serializeProject(p, p.tracks);
  assert.deepEqual(Object.keys(out), ["name", "width", "height", "fps", "background", "revision", "panSchema", "folders",
    "tracks", "media", "clips", "markers", "inPoint", "outPoint", "disabledTracks", "exportFrame", "encodeProfile"]);
  assert.deepEqual(out.media.map((m) => m.id), ["m_img", "m_svg", "m_hit"], "transient media are not saved");
  assert.deepEqual(Object.keys(out.media[0]), ["id", "name", "kind", "src", "duration", "width", "height", "folderId"]);
  assert.deepEqual(Object.keys(out.clips[0]), ["id", "mediaId", "kind", "track", "start", "in", "duration", "name", "props",
    "keyframes", "transitionIn", "transitionOut", "linkedId"]);
  assert.equal(out.clips[0].props, p.clips[0].props, "props are shared, not copied");
  assert.equal(find(out, "c_title").styleName, "luxury");
  assert.equal("styleName" in find(out, "c_svg"), false);
  assert.deepEqual(out.tracks[0], { id: "V4", kind: "video" });

  const plain = P.serializeProject({ ...p, exportFrame: { x: 0, y: 0, w: 1280, h: 720 }, encodeProfile: null, disabledTracks: ["A5", "Z"] }, p.tracks);
  assert.equal("exportFrame" in plain, false, "a full-canvas frame is no frame");
  assert.equal("encodeProfile" in plain, false);
  assert.deepEqual(plain.disabledTracks, ["A5"]);
  assert.deepEqual(P.serializeProject(p, [{ id: "V1", kind: "video", h: 58, color: "#fff" }]).disabledTracks, [],
    "lanes come from trackDefs (the app passes TRACKS)");
  assert.deepEqual(P.serializeProject(p, [{ id: "V1", kind: "video", h: 58 }]).tracks, [{ id: "V1", kind: "video" }]);
});

test("serializeProject: trackDefs default to project.tracks, then to the default lanes", () => {
  const { project: p } = load(loadFixture("minimal"));
  assert.deepEqual(P.serializeProject(p).tracks, p.tracks);
  assert.deepEqual(ids(P.serializeProject({ ...p, tracks: null }).tracks), ids(P.DEFAULT_TRACK_DEFS));
  const out = P.serializeProject({ ...p, folders: undefined, markers: undefined, inPoint: undefined, outPoint: 3,
    disabledTracks: undefined });
  assert.deepEqual([out.folders, out.markers, out.inPoint, out.outPoint, out.disabledTracks], [[], [], null, 3, []]);
});

/* ── Field normalizers ── */
test("normalizeWorkArea: finite, not before t0; OUT at or before IN clears both", () => {
  assert.deepEqual(P.normalizeWorkArea(1, 5), { inPoint: 1, outPoint: 5 });
  assert.deepEqual(P.normalizeWorkArea("1.5", null), { inPoint: 1.5, outPoint: null });
  assert.deepEqual(P.normalizeWorkArea(-2, undefined), { inPoint: 0, outPoint: null });
  assert.deepEqual(P.normalizeWorkArea(NaN, Infinity), { inPoint: null, outPoint: null });
  assert.deepEqual(P.normalizeWorkArea(5, 5), { inPoint: null, outPoint: null });
  assert.deepEqual(P.normalizeWorkArea(5, 2), { inPoint: null, outPoint: null });
  assert.deepEqual(P.normalizeWorkArea(1, 2, 3), { inPoint: null, outPoint: null }, "both clamp to t0 = 3");
  assert.equal(P.TIMELINE_START_TIME, 0);
});

test("normalizeFolders: first id wins, names default, dangling parents go to the root", () => {
  assert.deepEqual(P.normalizeFolders(null), []);
  assert.deepEqual(P.normalizeFolders({ id: "f" }), []);
  assert.deepEqual(P.normalizeFolders([
    null, { name: "no id" },
    { id: 7, name: "  ", parentId: "f_b" },
    { id: "f_b", parentId: "gone", open: false },
    { id: "f_b", name: "dup" },
    { id: "f_c", name: " Clips ", parentId: "7", extra: 1 },
  ]), [
    { id: "7", name: "Folder", parentId: "f_b", open: true },
    { id: "f_b", name: "Folder", parentId: null, open: false },
    { id: "f_c", name: "Clips", parentId: null, open: true }, // "7" ≠ the numeric id 7 seen
  ]);
});

test("normalizeMediaEntry: a copy with folderId defaulted; non-objects pass through", () => {
  const m = { id: "m", folderId: "" };
  const out = P.normalizeMediaEntry(m);
  assert.deepEqual(out, { id: "m", folderId: null });
  assert.notEqual(out, m);
  assert.equal(P.normalizeMediaEntry(null), null);
  assert.equal(P.normalizeMediaEntry("x"), "x");
});

test("evenFloor / normalizeExportFrame: even sizes ≥ 8 inside the canvas; full canvas = null", () => {
  assert.deepEqual([P.evenFloor(405), P.evenFloor(404), P.evenFloor(3), P.evenFloor(-1)], [404, 404, 8, 8]);
  const nf = P.normalizeExportFrame;
  assert.equal(nf(null, 1280, 720), null);
  assert.equal(nf("x", 1280, 720), null);
  assert.equal(nf({ w: 7, h: 100 }, 1280, 720), null);
  assert.equal(nf({ w: 100 }, 1280, 720), null);
  assert.equal(nf({ x: 5, y: 5, w: 2000, h: 900 }, 1280, 720), null, "clamped to the full canvas");
  assert.deepEqual(nf({ x: 438.4, y: -3, w: 405, h: 720 }, 1280, 720), { x: 438, y: 0, w: 404, h: 720 });
  assert.deepEqual(nf({ x: 5000, y: 5000, w: 100, h: 100 }, 1280, 720), { x: 1180, y: 620, w: 100, h: 100 });
  assert.deepEqual(nf({ x: "a", w: "100", h: 101 }, 1280, 720), { x: 0, y: 0, w: 100, h: 100 });
});

test("normalizeDisabledTracks: known lanes only, unique, sorted; lane ids as a Set or array", () => {
  assert.deepEqual(P.normalizeDisabledTracks(null, ["V1"]), []);
  assert.deepEqual(P.normalizeDisabledTracks("V1", ["V1"]), []);
  assert.deepEqual(P.normalizeDisabledTracks(["V2", "A1", "V2", "V9"], ["V2", "A1"]), ["A1", "V2"]);
  assert.deepEqual(P.normalizeDisabledTracks(["V2", "A1"], new Set(["A1"])), ["A1"]);
});

/* ── Lanes ── */
test("normalizeTrackDefs: defaults when absent or empty; drops invalid entries; first id wins; sorted", () => {
  const def = P.normalizeTrackDefs(undefined);
  assert.deepEqual(def, P.DEFAULT_TRACK_DEFS);
  assert.notEqual(def[0], P.DEFAULT_TRACK_DEFS[0], "fresh objects, not the frozen defaults");
  assert.deepEqual(P.normalizeTrackDefs([]), def);
  assert.deepEqual(P.normalizeTrackDefs("V1"), def);
  assert.deepEqual(P.normalizeTrackDefs([
    { id: "A2", kind: "audio", h: 9 }, null, { id: "V1", kind: "video" }, { id: "V10", kind: "video" },
    { id: "V2", kind: "text" }, { kind: "video" }, { id: "A2", kind: "video" }, { id: "A1", kind: "audio" },
  ]), [
    { id: "V10", kind: "video" }, { id: "V1", kind: "video" },
    { id: "A1", kind: "audio" }, { id: "A2", kind: "audio" },
  ]);
  assert.deepEqual(P.normalizeTrackDefs([{ id: "V1", kind: "nope" }]), [], "all invalid → no lanes (clips add theirs)");
});

test("sortTrackDefs: V-high → V1, then A1 → An, same objects; unnumbered ids sort as 0", () => {
  const list = [{ id: "A3", kind: "audio" }, { id: "V1", kind: "video" }, { id: "Vx", kind: "video" },
    { id: "A1", kind: "audio" }, { id: "V2", kind: "video" }];
  const out = P.sortTrackDefs(list);
  assert.deepEqual(ids(out), ["V2", "V1", "Vx", "A1", "A3"]);
  assert.equal(out[0], list[4]);
  assert.notEqual(out, list);
});

test("ensureLanesCoverClips: adds each missing lane once, kind from the clip or the id; same array when complete", () => {
  const defs = P.normalizeTrackDefs(undefined);
  assert.equal(P.ensureLanesCoverClips(defs, [{ track: "V1" }, { track: "" }, {}]), defs);
  const out = P.ensureLanesCoverClips(defs, [
    { kind: "video", track: "V5" }, { kind: "video", track: "V5" },
    { kind: "audio", track: "X1" }, { kind: "video", track: "a7" }, { kind: "text", track: "T1" },
  ]);
  assert.deepEqual(out.filter((t) => !defs.some((d) => d.id === t.id)),
    [{ id: "V5", kind: "video" }, { id: "T1", kind: "video" }, { id: "X1", kind: "audio" }, { id: "a7", kind: "audio" }]);
  assert.deepEqual(ids(out), ["V5", "V3", "V2", "V1", "T1", "A1", "X1", "A2", "A3", "A4", "a7"]);
  assert.deepEqual(P.serializeTracks([{ id: "V1", kind: "video", h: 1, color: "#f00" }]), [{ id: "V1", kind: "video" }]);
});

/* ── Undo snapshots (D3) ── */
test("snapshotContent: clips, media and folders — not markers, IN/OUT or lanes", () => {
  const { project: p } = load(loadFixture("lanes-bin"));
  const snap = JSON.parse(P.snapshotContent(p));
  assert.deepEqual(Object.keys(snap), ["clips", "media", "folders"]);
  assert.deepEqual(snap, JSON.parse(JSON.stringify({ clips: p.clips, media: p.media, folders: p.folders })));
});

test("restoreContent: swaps clips, media and folders back; markers, IN/OUT and lanes stay as they are now", () => {
  const { project: p } = load(loadFixture("linked-av"));
  const snap = P.snapshotContent(p);
  const before = JSON.parse(JSON.stringify(p));
  p.clips = p.clips.filter((c) => c.mediaId !== "m_song");
  p.media = p.media.filter((m) => m.id !== "m_song");
  p.folders.push({ id: "f_new", name: "New", parentId: null, open: true });
  p.markers.push({ t: 7 });
  p.inPoint = 3;
  p.disabledTracks = ["A2"];
  assert.deepEqual(P.restoreContent(p, snap), [], "no lanes added");
  const now = JSON.parse(JSON.stringify(p));
  assert.deepEqual([now.clips, now.media, now.folders], [before.clips, before.media, before.folders]);
  assert.deepEqual([now.markers.length, now.inPoint, now.disabledTracks, now.tracks], [3, 3, ["A2"], before.tracks]);
});

test("restoreContent: probed media facts and a folder's open state are not undone", () => {
  const { project: p } = load(loadFixture("lanes-bin"));
  const m = p.media[0];
  delete m.duration;
  const f = p.folders.find((x) => x.open === false);
  const snap = P.snapshotContent(p);
  Object.assign(m, { duration: 12.5, width: 640, height: 360, channels: 6 }); // the probe landed later
  f.open = true;
  P.restoreContent(p, snap);
  assert.deepEqual([p.media[0].duration, p.media[0].width, p.media[0].height, p.media[0].channels], [12.5, 640, 360, 6]);
  assert.equal(p.folders.find((x) => x.id === f.id).open, true);
});

test("restoreContent: a lane removed after its clips were deleted comes back with them (sorted defs)", () => {
  const { project: p } = load(loadFixture("linked-av"));
  const snap = P.snapshotContent(p);
  p.clips = p.clips.filter((c) => c.track !== "A3");
  p.tracks = p.tracks.filter((t) => t.id !== "A3");
  const defs = p.tracks;
  assert.deepEqual(P.restoreContent(p, snap), [{ id: "A3", kind: "audio" }]);
  assert.deepEqual(ids(p.tracks), ["V3", "V2", "V1", "A1", "A2", "A3", "A4"]);
  assert.notEqual(p.tracks, defs);
  const live = [{ id: "V1", kind: "video", h: 58 }, { id: "A1", kind: "audio", h: 42 }]; // the app passes its lanes
  assert.deepEqual(P.restoreContent(p, snap, live).map((d) => d.id), ["A2", "A3"]);
  assert.deepEqual(ids(p.tracks), ["V1", "A1", "A2", "A3"]);
});
