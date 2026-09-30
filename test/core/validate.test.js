/* core/validate.js — the project.json validator.

   Pins what every fixture reports (zero errors, an exact warning list), shows
   each code firing on its own, and checks the machinery 1c builds on: paths
   by id, RFC 6901 pointers, deterministic order, newErrors, formatIssues and
   the subset interpreter's refusal to run schemas it doesn't understand. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const V = require("../../core/validate");
const { listFixtures, loadFixture, build } = require("../fixtures");
const { seedProject } = require("../helpers");
const { mediaTimeAt } = require("../../core/keyframes"); // what the editor plays back with
const { TIMING, skipTiming } = require("../support/timing");

const { CODES, validateProject, validateStructure, compileSchema, issueKey, newErrors, formatIssues } = V;

/* Every issue anywhere in this file must use a code from the CODES table. */
function check(doc) {
  const issues = validateProject(doc);
  for (const i of issues) assert.ok(CODES[i.code], `unlisted code ${i.code}`);
  return issues;
}
const brief = (issues) => issues.map((i) => [i.severity, i.code, i.path]);
const errorsOf = (issues) => issues.filter((i) => i.severity === "error");

/* Clean base: a 5 s video clip on V1 over 10 s media, plus an unused audio file. */
function base() {
  return build.project({
    media: [build.media("m_v", "video", 10), build.media("m_a", "audio", 10)],
    clips: [build.clip("c_v", { mediaId: "m_v" })],
  });
}
const clip = (d, id = "c_v") => d.clips.find((c) => c.id === id);
const mutated = (fn) => { const d = base(); fn(d); return d; };

test("the base project and the harness seed project are clean", () => {
  assert.deepEqual(check(base()), []);
  assert.deepEqual(check(seedProject()), []);
});

/* ── Fixtures ── */
/* Warnings each fixture is EXPECTED to raise, as issueKey()s. Changing one is a
   deliberate act: a new warning here means the validator (or a fixture) moved. */
const FIXTURE_WARNINGS = {
  "demo-reel": [],
  "keyframes-transitions": [],
  "keyframe-anchors": ["KEYFRAME_OUT_OF_RANGE clips[c_len].keyframes.opacity[3].t"], // the key beyond the anchor at 4 s
  "lanes-bin": [],
  legacy: [
    "LEGACY_LINKED_ID clips[c_ov].linkedId",
    "LEGACY_LINKED_ID clips[c_oa].linkedId",
    "IN_MISSING clips[c_bare].in",
    "TRACK_UNDECLARED clips[c_far].track",
  ],
  "linked-av": [],
  minimal: [],
  "speed-ramp": [],
};

test("every fixture has a pinned warning list", () => {
  assert.deepEqual(Object.keys(FIXTURE_WARNINGS).sort(), listFixtures());
});

for (const name of listFixtures()) {
  test(`fixture ${name}: zero errors, exactly the pinned warnings`, () => {
    const issues = check(loadFixture(name));
    assert.deepEqual(errorsOf(issues), []);
    assert.deepEqual(issues.map(issueKey), FIXTURE_WARNINGS[name] ?? []);
  });
}

test("validating any fixture takes well under 5 ms", { skip: skipTiming }, () => {
  for (const name of listFixtures()) {
    const doc = loadFixture(name);
    validateProject(doc); // warm up
    const runs = 20, t0 = performance.now();
    for (let i = 0; i < runs; i++) validateProject(doc);
    const per = (performance.now() - t0) / runs;
    assert.ok(per < 5, `${name}: ${per.toFixed(2)} ms per validation`);
  }
});

/* ── One case per code ── */
/* [code, severity, path, mutate(base)] — each must yield EXACTLY that issue. */
const CASES = [
  // layer 1 (structural); severity from x-severity
  ["SCHEMA_TYPE", "error", "clips[c_v].start", (d) => { clip(d).start = "0"; }],
  ["NON_FINITE", "error", "clips[c_v].duration", (d) => { clip(d).duration = NaN; }],
  ["SCHEMA_ENUM", "error", "clips[c_v].props.textAnim", (d) => { clip(d).props.textAnim = "word-popp"; }],
  ["SCHEMA_MINIMUM", "error", "clips[c_v].start", (d) => { clip(d).start = -1; }],
  ["SCHEMA_MAXIMUM", "error", "clips[c_v].props.speed", (d) => { clip(d).props.speed = 9; clip(d).duration = 1; }],
  ["SCHEMA_EXCLUSIVE_MINIMUM", "error", "clips[c_v].duration", (d) => { clip(d).duration = 0; }],
  ["SCHEMA_REQUIRED", "error", "clips[c_v].track", (d) => { delete clip(d).track; }],
  ["SCHEMA_ADDITIONAL", "warning", "markers[0].lable", (d) => { d.markers = [{ t: 1, lable: "drop" }]; }],
  // layer 2 errors
  ["DUP_CLIP_ID", "error", "clips[c_v].id", (d) => { d.clips.push(build.clip("c_v", { mediaId: "m_v", start: 5 })); }],
  ["DUP_MEDIA_ID", "error", "media[m_v].id", (d) => { d.media.push(build.media("m_v", "video", 10)); }],
  ["MEDIA_REQUIRED", "error", "clips[c_v].mediaId", (d) => { clip(d).mediaId = null; }],
  ["MEDIA_NOT_FOUND", "error", "clips[c_v].mediaId", (d) => { clip(d).mediaId = "m_gone"; }],
  ["TRACK_ID_INVALID", "error", "clips[c_v].track", (d) => { clip(d).track = "Video1"; }],
  ["TRACK_ID_INVALID", "error", "tracks[B1].id", (d) => { d.tracks = [{ id: "V1", kind: "video" }, { id: "B1", kind: "audio" }]; }],
  ["TRACK_KIND_MISMATCH", "error", "clips[c_v].track", (d) => { clip(d).track = "A1"; }],
  ["TRACK_KIND_MISMATCH", "error", "tracks[A2].kind", (d) => { d.tracks = [{ id: "V1", kind: "video" }, { id: "A2", kind: "video" }]; }],
  ["DURATION_TOO_SHORT", "error", "clips[c_v].duration", (d) => { clip(d).duration = 0.02; }],
  // layer 2 warnings
  ["TRACK_UNDECLARED", "warning", "clips[c_v].track", (d) => { clip(d).track = "V9"; }],
  ["DUP_TRACK_ID", "warning", "tracks[V1].id", (d) => { d.tracks = [{ id: "V1", kind: "video" }, { id: "V1", kind: "video" }]; }],
  ["DISABLED_TRACK_UNKNOWN", "warning", "disabledTracks[0]", (d) => { d.disabledTracks = ["A9"]; }],
  ["IN_MISSING", "warning", "clips[c_v].in", (d) => { delete clip(d).in; }],
  ["MEDIA_KIND_MISMATCH", "warning", "clips[c_v].mediaId", (d) => { clip(d).mediaId = "m_a"; }],
  ["MEDIA_OVERRUN", "warning", "clips[c_v]", (d) => { clip(d).in = 6; }],
  ["LINK_DESYNC", "warning", "clips[c_l]", (d) => {
    clip(d).linkGroup = "lg";
    d.clips.push({ ...build.clip("c_l", { mediaId: "m_v", kind: "audio", track: "A1", start: 0.5 }), linkGroup: "lg" });
  }],
  ["LEGACY_LINKED_ID", "warning", "clips[c_v].linkedId", (d) => { clip(d).linkedId = "c_gone"; }],
  ["KEYFRAMES_UNSORTED", "warning", "clips[c_v].keyframes.opacity", (d) => { clip(d).keyframes = { opacity: [{ t: 2, v: 1 }, { t: 1, v: 0 }] }; }],
  ["KEYFRAME_OUT_OF_RANGE", "warning", "clips[c_v].keyframes.opacity[2].t", (d) => { clip(d).keyframes = { opacity: [{ t: 0, v: 0 }, { t: 6, v: 1 }, { t: 7, v: 0 }] }; }],
  ["KEYFRAME_OUT_OF_RANGE", "warning", "clips[c_v].keyframes.opacity[0].t", (d) => { clip(d).keyframes = { opacity: [{ t: -2, v: 0 }, { t: -1, v: 1 }, { t: 1, v: 0 }] }; }],
  ["KEYFRAME_NOT_ANIMATABLE", "warning", "clips[c_v].keyframes.fit", (d) => { clip(d).keyframes = { fit: [{ t: 0, v: 1 }] }; }],
  ["TRANSITION_TOO_LONG", "warning", "clips[c_v].transitionIn.duration", (d) => { clip(d).transitionIn = { type: "fade", duration: 6 }; }],
  ["TRANSITION_TOO_LONG", "warning", "clips[c_v].transitionOut.duration", (d) => {
    clip(d).transitionIn = { type: "fade", duration: 3 };
    clip(d).transitionOut = { type: "fade", duration: 3 };
  }],
  ["TRANSITION_ALIAS", "warning", "clips[c_v].transitionIn.type", (d) => { clip(d).transitionIn = { type: "dissolve", duration: 1 }; }],
  ["TRANSITION_ALIAS", "warning", "clips[c_v].transitionOut", (d) => { clip(d).transitionOut = { type: "none", duration: 1 }; }],
  ["UNKNOWN_PROP", "warning", "clips[c_v].props.opactiy", (d) => { clip(d).props.opactiy = 0.5; }],
  ["UNKNOWN_CLIP_FIELD", "warning", "clips[c_v].strat", (d) => { clip(d).strat = 1; }],
  ["FOLDER_NOT_FOUND", "warning", "media[m_v].folderId", (d) => { d.media[0].folderId = "f_gone"; }],
  ["FOLDER_NOT_FOUND", "warning", "folders[f_b].parentId", (d) => { d.folders = [{ id: "f_b", name: "B", parentId: "f_gone", open: true }]; }],
  ["WORK_AREA_INVALID", "warning", "outPoint", (d) => { d.inPoint = 5; d.outPoint = 2; }],
];

for (const [code, severity, at, mutate] of CASES) {
  test(`${code} fires alone: ${at}`, () => {
    assert.deepEqual(brief(check(mutated(mutate))), [[severity, code, at]]);
    if (CODES[code].severity !== "schema") assert.equal(CODES[code].severity, severity, "CODES table severity");
  });
}

test("CODES: every code has a case above, a severity and a meaning", () => {
  const covered = new Set(CASES.map(([code]) => code));
  covered.add("SCHEMA_CONST"); // PROJECT_SCHEMA has no const — see the compileSchema test
  assert.deepEqual([...covered].sort(), Object.keys(CODES).sort());
  for (const [k, c] of Object.entries(CODES)) {
    assert.ok(["error", "warning", "schema"].includes(c.severity), `${k}: severity`);
    assert.equal(c.severity === "schema", c.layer === "structural", `${k}: only structural codes take the schema's severity`);
    assert.ok(c.meaning.length > 10, `${k}: meaning`);
  }
});

test("hints: typos get a did-you-mean, misplaced fields say where they belong", () => {
  const hint = (fn) => check(mutated(fn))[0].hint;
  assert.equal(hint((d) => { clip(d).props.textAnim = "word-popp"; }), 'did you mean "word-pop"?');
  assert.equal(hint((d) => { clip(d).props.opactiy = 1; }), 'did you mean "opacity"?');
  assert.equal(hint((d) => { clip(d).strat = 1; }), 'did you mean "start"?');
  assert.equal(hint((d) => { d.markers = [{ t: 1, lable: "x" }]; }), 'did you mean "label"?');
  assert.equal(hint((d) => { clip(d).props.start = 1; }), '"start" is a clip field, not a prop — move it out of props');
  assert.equal(hint((d) => { clip(d).opacity = 1; }), '"opacity" is a prop — move it into props');
  assert.equal(hint((d) => { clip(d).track = "v7"; }), 'use "V7"');
  assert.equal(hint((d) => { clip(d).transitionIn = { type: "wipe-left", duration: 1 }; }), 'use "wipe"');
  assert.equal(hint((d) => { clip(d).in = 6; }), "at in 6 the clip can last 4 s");
  // no length fits (in past the media end), or a ramp (no single length to name)
  assert.equal(hint((d) => { clip(d).in = 12; }), "lower in or shorten the clip");
  assert.equal(hint((d) => { clip(d).in = 6; clip(d).keyframes = { speed: [{ t: 0, v: 1 }] }; }), "lower in or shorten the clip");
  assert.equal(hint((d) => { clip(d).props.zzzzzz = 1; }), undefined);
});

/* D4: one key per side outside the clip is an anchor — legal, no issue; only
   the keys beyond it are KEYFRAME_OUT_OF_RANGE (whatever their order). */
test("anchors: one key before 0 and one past the end per channel draw no issue (D4)", () => {
  const dur = clip(base()).duration;
  const ok = mutated((d) => {
    clip(d).keyframes = {
      opacity: [{ t: -1, v: 0 }, { t: 1, v: 1 }, { t: dur + 2, v: 0 }],
      x: [{ t: -0.5, v: 3 }],
      speed: [{ t: -3, v: 1 }, { t: dur + 1, v: 2 }],
    };
  });
  assert.deepEqual(check(ok).filter((i) => i.path.includes("keyframes")), []);
  const extra = mutated((d) => {
    clip(d).keyframes = { opacity: [{ t: dur + 3, v: 0 }, { t: -1, v: 0 }, { t: dur + 1, v: 2 }, { t: -4, v: 1 }] };
  });
  assert.deepEqual(check(extra).map(issueKey), [
    "KEYFRAMES_UNSORTED clips[c_v].keyframes.opacity",
    "KEYFRAME_OUT_OF_RANGE clips[c_v].keyframes.opacity[0].t",
    "KEYFRAME_OUT_OF_RANGE clips[c_v].keyframes.opacity[3].t",
  ], "the nearest key outside each edge is the anchor, even unsorted");
  const msg = check(extra).find((i) => i.path.endsWith("[3].t")).message;
  assert.match(msg, /before the clip start, beyond the anchor at -1 s/);
});

/* ── Severity comes from the schema's x-severity ── */
const SEVERITY = [
  // [why, severity, code, path, mutate]
  ["opacity out of range is cosmetic", "warning", "SCHEMA_MAXIMUM", "clips[c_v].props.opacity", (d) => { clip(d).props.opacity = 2; }],
  ["speed > 8 is clamped: timing changes", "error", "SCHEMA_MAXIMUM", "clips[c_v].props.speed", (d) => { clip(d).props.speed = 9; clip(d).duration = 1; }],
  ["speed < 0.1 likewise", "error", "SCHEMA_MINIMUM", "clips[c_v].props.speed", (d) => { clip(d).props.speed = 0.05; }],
  ["speed-ramp keyframe values too", "error", "SCHEMA_MAXIMUM", "clips[c_v].keyframes.speed[1].v", (d) => {
    clip(d).duration = 1;
    clip(d).keyframes = { speed: [{ t: 0, v: 1 }, { t: 1, v: 9 }] };
  }],
  ["other keyframe values are cosmetic", "warning", "SCHEMA_TYPE", "clips[c_v].keyframes.opacity[0].v", (d) => { clip(d).keyframes = { opacity: [{ t: 0, v: "1" }] }; }],
  ["a null keyframe crashes the load-time sort", "error", "SCHEMA_TYPE", "clips[c_v].keyframes.opacity[0]", (d) => { clip(d).keyframes = { opacity: [null] }; }],
  ["a keyframe without v", "error", "SCHEMA_REQUIRED", "clips[c_v].keyframes.opacity[0].v", (d) => { clip(d).keyframes = { opacity: [{ t: 0 }] }; }],
  ["an unknown keyframe key", "warning", "SCHEMA_ADDITIONAL", "clips[c_v].keyframes.opacity[0].easing", (d) => { clip(d).keyframes = { opacity: [{ t: 0, v: 1, easing: "linear" }] }; }],
  ["an unknown ease", "error", "SCHEMA_ENUM", "clips[c_v].keyframes.opacity[0].ease", (d) => { clip(d).keyframes = { opacity: [{ t: 0, v: 1, ease: "bounce" }] }; }],
  ["keyframes of the wrong type", "warning", "SCHEMA_TYPE", "clips[c_v].keyframes", (d) => { clip(d).keyframes = []; }],
  ["an unknown filterPreset", "warning", "SCHEMA_ENUM", "clips[c_v].props.filterPreset", (d) => { clip(d).props.filterPreset = "sepia"; }],
  ["an unknown blend", "error", "SCHEMA_ENUM", "clips[c_v].props.blend", (d) => { clip(d).props.blend = "add"; }],
  ["an unknown fit", "error", "SCHEMA_ENUM", "clips[c_v].props.fit", (d) => { clip(d).props.fit = "fill"; }],
  ["an unknown transition", "error", "SCHEMA_ENUM", "clips[c_v].transitionIn.type", (d) => { clip(d).transitionIn = { type: "crossfade", duration: 1 }; }],
  ["a transition without duration", "error", "SCHEMA_REQUIRED", "clips[c_v].transitionIn.duration", (d) => { clip(d).transitionIn = { type: "fade" }; }],
  ["an unknown transition key", "warning", "SCHEMA_ADDITIONAL", "clips[c_v].transitionIn.ease", (d) => { clip(d).transitionIn = { type: "fade", duration: 1, ease: "linear" }; }],
  ["an unknown clip kind", "error", "SCHEMA_ENUM", "clips[c_v].kind", (d) => { clip(d).kind = "vid"; }],
  ["an unknown media kind", "error", "SCHEMA_ENUM", "media[m_a].kind", (d) => { d.media[1].kind = "sound"; }],
  ["media without a name (the bin sort crashes)", "error", "SCHEMA_REQUIRED", "media[m_a].name", (d) => { delete d.media[1].name; }],
  ["a negative media duration", "warning", "SCHEMA_MINIMUM", "media[m_a].duration", (d) => { d.media[1].duration = -1; }],
  ["a negative in", "error", "SCHEMA_MINIMUM", "clips[c_v].in", (d) => { clip(d).in = -1; }],
  ["a numeric clip name", "warning", "SCHEMA_TYPE", "clips[c_v].name", (d) => { clip(d).name = 5; }],
  ["clips not an array", "error", "SCHEMA_TYPE", "clips", (d) => { d.clips = {}; }],
  ["fps 0", "error", "SCHEMA_EXCLUSIVE_MINIMUM", "fps", (d) => { d.fps = 0; }],
  ["width as a string", "error", "SCHEMA_TYPE", "width", (d) => { d.width = "1280"; }],
  ["panSchema out of range", "warning", "SCHEMA_MAXIMUM", "panSchema", (d) => { d.panSchema = 2; }],
  ["marker t < 0", "warning", "SCHEMA_MINIMUM", "markers[0].t", (d) => { d.markers = [{ t: -1 }]; }],
  ["an unknown lane kind", "warning", "SCHEMA_ENUM", "tracks[A1].kind", (d) => { d.tracks = [{ id: "V1", kind: "video" }, { id: "A1", kind: "midi" }]; }],
  ["an exportFrame too small", "warning", "SCHEMA_MINIMUM", "exportFrame.w", (d) => { d.exportFrame = { x: 0, y: 0, w: 4, h: 720 }; }],
];

for (const [why, severity, code, at, mutate] of SEVERITY) {
  test(`severity from x-severity — ${why}: ${severity}`, () => {
    assert.deepEqual(brief(check(mutated(mutate))), [[severity, code, at]]);
  });
}

/* ── Paths, pointers, order ── */
test("paths use ids, pointers use indices — nested, missing, closed and escaped keys", () => {
  const d = base();
  d.clips.unshift(build.clip("c_x", { mediaId: "m_v", start: 5 }), build.clip("c_y", { mediaId: "m_v", start: 10 }));
  delete clip(d, "c_x").start;
  clip(d, "c_y").props = { "a/b~c": 1 };
  clip(d).keyframes = { opacity: [{ t: 0, v: 0 }, { t: 1, v: "1" }] };
  d.markers = [{ t: 1 }, { t: 2 }, { t: -1 }];
  d.tracks = [{ id: "V1", kind: "video" }, { id: "V4", kind: "video", h: 3 }];
  assert.deepEqual(check(d).map((i) => [i.pointer, i.path, i.code]), [
    ["/clips/0/start", "clips[c_x].start", "SCHEMA_REQUIRED"],
    ["/clips/1/props/a~1b~0c", 'clips[c_y].props["a/b~c"]', "UNKNOWN_PROP"],
    ["/clips/2/keyframes/opacity/1/v", "clips[c_v].keyframes.opacity[1].v", "SCHEMA_TYPE"],
    ["/markers/2/t", "markers[2].t", "SCHEMA_MINIMUM"],
    ["/tracks/1/h", "tracks[V4].h", "SCHEMA_ADDITIONAL"],
  ]);
});

test("a non-object document is one root issue (path \"\", pointer \"\")", () => {
  for (const doc of [null, [], "project", 7]) {
    const issues = check(doc);
    assert.deepEqual(issues.map((i) => [i.severity, i.code, i.path, i.pointer]), [["error", "SCHEMA_TYPE", "", ""]]);
  }
  assert.deepEqual(brief(check({})), [["error", "SCHEMA_REQUIRED", "clips"], ["error", "SCHEMA_REQUIRED", "media"]]);
});

test("issues are sorted by pointer (indices numerically), then code", () => {
  const d = base();
  for (let i = 1; i <= 10; i++) d.clips.push(build.clip("c_" + i, { mediaId: "m_v", start: i * 5 }));
  d.clips[10].start = -1;
  d.clips[2].track = "A9"; // a video clip on an undeclared audio lane: two codes, one pointer
  assert.deepEqual(check(d).map((i) => [i.pointer, i.code]), [
    ["/clips/2/track", "TRACK_KIND_MISMATCH"],
    ["/clips/2/track", "TRACK_UNDECLARED"],
    ["/clips/10/start", "SCHEMA_MINIMUM"],
  ]);
  assert.deepEqual(validateProject(d), validateProject(structuredClone(d)), "deterministic");
});

test("validateStructure is layer 1 alone", () => {
  assert.deepEqual(validateStructure(loadFixture("legacy")), []);
  const d = mutated((x) => { clip(x).props.speed = 9; clip(x).duration = 1; clip(x).strat = 1; });
  assert.deepEqual(brief(validateStructure(d)), [["error", "SCHEMA_MAXIMUM", "clips[c_v].props.speed"]]);
});

test("MEDIA_OVERRUN integrates speed ramps exactly like the editor's mediaTimeAt", () => {
  // the validator runs it on a sorted probe clip; the editor calls it on the clip itself
  const ramps = [
    { in: 1, duration: 6, props: {}, keyframes: { speed: [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }, { t: 6, v: 3, ease: "linear" }] } },
    { in: 0.5, duration: 5.013, props: { speed: 2 }, keyframes: { speed: [{ t: 0.3, v: 0.5 }, { t: 2, v: 4, ease: "ease-in" }, { t: 4.1, v: 1.5 }] } },
    { in: 0, duration: 3, props: {}, keyframes: { speed: [{ t: 0, v: 0.25 }, { t: 3, v: 8, ease: "ease-out" }] } },
    { in: 2, duration: 4, props: { speed: 1.5 } }, // static
  ];
  ramps.forEach((r, n) => {
    const c = { id: "c_r" + n, mediaId: "m_v", kind: "video", track: "V1", start: 0, ...r };
    const end = mediaTimeAt(c, c.start + c.duration);
    const project = (mediaDur) => build.project({ media: [build.media("m_v", "video", mediaDur)], clips: [structuredClone(c)] });
    assert.deepEqual(check(project(end)), [], `ramp ${n}: fits exactly at ${end}`);
    const over = check(project(end - 0.002));
    assert.deepEqual(over.map((i) => i.code), ["MEDIA_OVERRUN"], `ramp ${n}: 2 ms short`);
    const shown = +/–([\d.]+) s runs past/.exec(over[0].message)[1];
    assert.ok(Math.abs(shown - end) < 1e-4, `ramp ${n}: reported end ${shown} vs app ${end}`);
  });
  // the fixture's linked ramp ends at 1 + 16 s: one warning per member when the file is shorter
  const d = loadFixture("speed-ramp");
  d.media[0].duration = 16.9;
  assert.deepEqual(check(d).map(issueKey), ["MEDIA_OVERRUN clips[c_ramp]", "MEDIA_OVERRUN clips[c_ramp_l]", "MEDIA_OVERRUN clips[c_ramp_r]"]);
});

test("MEDIA_OVERRUN needs a numeric in: a string or NaN in is SCHEMA_TYPE / NON_FINITE alone, never an overrun guess", () => {
  assert.deepEqual(check(mutated((d) => { clip(d).in = "12"; })).map(issueKey), ["SCHEMA_TYPE clips[c_v].in"]);
  assert.deepEqual(check(mutated((d) => { clip(d).in = NaN; })).map(issueKey), ["NON_FINITE clips[c_v].in"]);
});

test("a pathological clip (huge duration, long ramp) doesn't stall the validator", () => {
  const d = base();
  clip(d).duration = 1e6;
  clip(d).keyframes = { speed: Array.from({ length: 50 }, (_, i) => ({ t: i * 1000, v: 1 + (i % 3) })) };
  const t0 = performance.now();
  const issues = check(d);
  if (TIMING) assert.ok(performance.now() - t0 < 200, "validation took too long");
  assert.deepEqual(issues.map(issueKey), [], "a ramp too long to integrate is 'can't tell', not an overrun");
  delete clip(d).keyframes; // a static clip is one multiplication
  assert.deepEqual(check(d).map(issueKey), ["MEDIA_OVERRUN clips[c_v]"]);
});

test("MEDIA_OVERRUN on a ramp: keys sorted like the editor, odd eases are 'can't tell', the UI's cache untouched", () => {
  const ramp = [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }, { t: 6, v: 3, ease: "linear" }]; // ends at in + 16
  const doc = (keys, mediaDur = 15) => {
    const d = base();
    d.media[0].duration = mediaDur;
    Object.assign(clip(d), { duration: 6, keyframes: { speed: keys } });
    return d;
  };
  assert.deepEqual(check(doc(ramp)).map(issueKey), ["MEDIA_OVERRUN clips[c_v]"]);
  assert.deepEqual(check(doc(ramp, 16.1)), [], "it fits in 16.1 s");
  const shuffled = [ramp[2], ramp[0], ramp[1]];
  assert.deepEqual(check(doc(shuffled)).map(issueKey), ["MEDIA_OVERRUN clips[c_v]", "KEYFRAMES_UNSORTED clips[c_v].keyframes.speed"]);
  assert.deepEqual(check(doc(shuffled, 16.1)).map((i) => i.code), ["KEYFRAMES_UNSORTED"], "same verdict unsorted");
  // kfChannel would run Object.prototype members as curves (and "__proto__" throws):
  // the enum error is the schema layer's; the overrun check stands aside
  for (const ease of ["constructor", "toString", "__proto__"]) {
    const issues = check(doc([ramp[0], { ...ramp[1], ease }, ramp[2]]));
    assert.deepEqual(issues.map((i) => i.code), ["SCHEMA_ENUM"], ease);
  }
  // the validator probes with its own cache id: the editor's entry for c_v survives
  const c = { id: "c_v", start: 0, in: 0, duration: 6, props: {}, keyframes: { speed: ramp } };
  const before = mediaTimeAt(c, 3);
  check(doc([{ t: 0, v: 8 }]));
  assert.equal(mediaTimeAt(c, 3), before);
});

/* ── newErrors / issueKey / formatIssues ── */
test("newErrors: pre-existing errors never block; new ones (and new duplicates) do", () => {
  const dup = mutated((d) => { d.clips.push(build.clip("c_v", { mediaId: "m_v", start: 5 })); });
  const before = check(dup);
  assert.deepEqual(before.map(issueKey), ["DUP_CLIP_ID clips[c_v].id"]);

  // unrelated edit + reorder: the old duplicate keeps its key, only the new error counts
  const after = structuredClone(dup);
  after.clips.reverse();
  after.clips.push(build.clip("c_new", { mediaId: "m_v", start: -2 }));
  after.clips.push(build.clip("c_warn", { mediaId: "m_v", start: 20, inn: 9 })); // MEDIA_OVERRUN: a warning
  const fresh = newErrors(before, check(after));
  assert.deepEqual(fresh.map(issueKey), ["SCHEMA_MINIMUM clips[c_new].start"]);

  // a second duplicate of the same id has the same key, but the count went up
  const third = structuredClone(dup);
  third.clips.push(build.clip("c_v", { mediaId: "m_v", start: 10 }));
  assert.deepEqual(newErrors(before, check(third)).map(issueKey), ["DUP_CLIP_ID clips[c_v].id"]);

  assert.deepEqual(newErrors(before, before), []);
  assert.deepEqual(newErrors([], check(loadFixture("legacy"))), [], "warnings are never 'new errors'");
  assert.equal(issueKey(before[0]), "DUP_CLIP_ID clips[c_v].id");
});

test("formatIssues: one line per issue, errors first, capped at limit", () => {
  const d = base();
  clip(d).duration = 1;
  for (let i = 0; i < 11; i++) clip(d).props["zz" + i] = 1; // 11 UNKNOWN_PROP warnings
  clip(d).props.speed = 9; // 1 error
  const issues = check(d);
  assert.equal(issues.length, 12);
  const lines = formatIssues(issues).split("\n");
  assert.equal(lines.length, 11);
  assert.equal(lines[0], "error SCHEMA_MAXIMUM clips[c_v].props.speed: 9 is above the maximum 8");
  assert.match(lines[1], /^warning UNKNOWN_PROP clips\[c_v\]\.props\.zz\d+: /);
  assert.equal(lines[10], "… +2 more");
  assert.equal(formatIssues(issues, { limit: 3 }).split("\n").at(-1), "… +9 more");
  assert.equal(formatIssues(issues, { limit: 100 }).split("\n").length, 12);
  assert.equal(formatIssues([]), "");
  const typo = check(mutated((x) => { clip(x).props.textAnim = "word-popp"; }));
  assert.equal(formatIssues(typo),
    'error SCHEMA_ENUM clips[c_v].props.textAnim: string "word-popp" is not one of: none, typewriter, word-pop, word-slide, karaoke, letter-pop, wave, bounce, … — did you mean "word-pop"?');
  assert.equal(formatIssues(check(null)), "error SCHEMA_TYPE (root): expected object, got null");
});

/* ── The subset interpreter ── */
test("compileSchema refuses keywords outside the subset, dangling/circular $refs and bad x-severity", () => {
  assert.throws(() => compileSchema({ oneOf: [{ type: "string" }] }), /keyword "oneOf" is outside the supported subset/);
  assert.throws(() => compileSchema({ properties: { a: { type: "string", pattern: "^x" } } }), /at #\/properties\/a: keyword "pattern"/);
  assert.throws(() => compileSchema({ $ref: "#/$defs/nope", $defs: {} }), /\$ref "#\/\$defs\/nope" does not resolve/);
  assert.throws(() => compileSchema({ $ref: "other.json#/x" }), /does not resolve/);
  assert.throws(() => compileSchema({ $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }), /circular \$ref/);
  assert.throws(() => compileSchema({ items: [{ type: "string" }] }), /must be an object/);
  assert.throws(() => compileSchema({ type: "float" }), /bad type/);
  assert.throws(() => compileSchema({ enum: [] }), /enum must be a non-empty array/);
  assert.throws(() => compileSchema({ minimum: "0" }), /minimum must be a number/);
  assert.throws(() => compileSchema({ properties: [{ type: "string" }] }), /properties must be an object/);
  assert.throws(() => compileSchema({ "x-severity": "fatal" }), /x-severity/);
  assert.throws(() => compileSchema({ "x-severity": { pattern: "warning" } }), /x-severity/);
  // unused $defs are checked too — a bad rule can't hide in a def nobody references yet
  assert.throws(() => compileSchema({ $defs: { later: { anyOf: [] } } }), /"anyOf"/);
  // other x- annotations are free-form
  assert.doesNotThrow(() => compileSchema({ type: "object", "x-anything": { nested: [1] } }));
});

test("compileSchema: const, integer, $ref, items, and x-severity string (inherited) vs map (this node only)", () => {
  const s = compileSchema({
    type: "object",
    "x-severity": { required: "warning" },
    required: ["a"],
    properties: {
      k: { const: "v1" },
      n: { type: "integer", minimum: 0 },
      list: { type: "array", items: { $ref: "#/$defs/item" } },
      w: {
        type: "object", "x-severity": "warning", additionalProperties: false,
        properties: { m: { type: "number", maximum: 3 }, e: { enum: [1, 2], "x-severity": "error" } },
      },
    },
    $defs: { item: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
  });
  assert.deepEqual(s.validate({ a: 1, k: "v1", n: 2, list: [{ id: "x" }], w: { m: 1, e: 2 } }), []);
  const got = s.validate({ k: "v2", n: 1.5, list: [{ id: "x" }, { id: 7 }, {}], w: { m: 4, e: 3, z: 0 } });
  assert.deepEqual(got.map((i) => [i.severity, i.code, i.pointer, i.path]), [
    ["warning", "SCHEMA_REQUIRED", "/a", "a"], // map: this node's `required` only
    ["error", "SCHEMA_CONST", "/k", "k"],
    ["error", "SCHEMA_TYPE", "/list/1/id", "list[1].id"], // id 7 isn't a string id → index
    ["error", "SCHEMA_REQUIRED", "/list/2/id", "list[2].id"],
    ["error", "SCHEMA_TYPE", "/n", "n"],
    ["error", "SCHEMA_ENUM", "/w/e", "w.e"], // string "error" overrides the inherited "warning"
    ["warning", "SCHEMA_MAXIMUM", "/w/m", "w.m"], // inherited from w
    ["warning", "SCHEMA_ADDITIONAL", "/w/z", "w.z"],
  ]);
  assert.equal(got.find((i) => i.code === "SCHEMA_CONST").message, 'must be "v1"');
});

test("browser mode: validate.js refuses to load before schema.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "core", "validate.js"), "utf8");
  assert.throws(() => vm.runInContext(src, vm.createContext({})), /core\/schema\.js must load before core\/validate\.js/);
});
