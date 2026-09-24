/* Meta-tests for the property-test generators (test/support/arb.js, ops.js).

   The invariant properties are only as good as the projects they run on: an
   invalid generated project would make "no NEW validation errors" vacuous,
   and a shape the generator never produces is a shape nothing checks. */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const A = require("../support/arb");
const O = require("../support/ops");
const { validateProject, formatIssues } = require("../../core/validate");
const { serializeProject } = require("../../core/project");
const { ANIMATABLE, TRANSITIONS, EASE } = require("../../core/schema");

const json = (x) => JSON.parse(JSON.stringify(x));
const errorsOf = (doc) => validateProject(json(doc)).filter((i) => i.severity === "error");

/* Zero errors is the contract; the raw project is held to zero warnings too,
   so the media bound (MEDIA_OVERRUN), keyframe and transition ranges and the
   lanes all hold before any op runs. */
propTest("GEN-01: every generated project validates with zero errors, raw and normalized (and raw with zero warnings)", (fc) => {
  fc.assert(fc.property(A.arbProject(), (raw) => {
    const e0 = validateProject(json(raw));
    assert.equal(e0.length, 0, "raw:\n" + formatIssues(e0));
    const doc = O.createSession(raw).doc;
    const e1 = errorsOf(doc);
    assert.equal(e1.length, 0, "normalized:\n" + formatIssues(e1));
    const e2 = errorsOf(serializeProject(doc));
    assert.equal(e2.length, 0, "saved:\n" + formatIssues(e2));
  }));
});

propTest("GEN-02: the generator reaches every shape the invariants talk about", (fc) => {
  const seen = new Set();
  const note = (k) => seen.add(k);
  for (const raw of fc.sample(A.arbProject(), { numRuns: 400, seed: 42 })) {
    note("fps " + raw.fps);
    note(raw.tracks ? "custom lanes" : "default lanes");
    if (raw.disabledTracks) note("disabled lanes");
    if (raw.inPoint != null) note("IN");
    if (raw.outPoint != null) note("OUT");
    if (raw.markers.length) note("markers");
    if (raw.exportFrame) note("exportFrame");
    if (raw.folders) note("folders");
    const groups = new Map();
    for (const c of raw.clips) {
      note("kind " + c.kind);
      if (c.linkGroup) groups.set(c.linkGroup, (groups.get(c.linkGroup) || 0) + 1);
      if (c.keyframes?.speed) note("speed ramp " + c.kind);
      if (c.props?.speed != null) note("static speed");
      if (c.in > 0) note("in > 0 " + c.kind);
      for (const [k, keys] of Object.entries(c.keyframes || {})) {
        note("kf " + k);
        for (const x of keys) if (x.ease) note("ease " + x.ease);
      }
      for (const side of ["transitionIn", "transitionOut"]) if (c[side]) note("transition " + c[side].type);
      if (c.props?.fontCutSet) note("array prop");
    }
    for (const n of groups.values()) note(`group of ${n - 1} stem${n > 2 ? "s" : ""}`);
    const byLane = new Map();
    for (const c of raw.clips) {
      const prev = byLane.get(c.track) || [];
      if (prev.some((p) => p.start < c.start + c.duration && c.start < p.start + p.duration)) note("same-lane overlap");
      byLane.set(c.track, [...prev, c]);
    }
  }
  const want = [
    "fps 24", "fps 25", "fps 30", "fps 50", "fps 60", "custom lanes", "default lanes", "disabled lanes",
    "IN", "OUT", "markers", "exportFrame", "folders", "same-lane overlap",
    ...["video", "audio", "image", "svg", "text", "adjust"].map((k) => "kind " + k),
    "group of 1 stem", "group of 2 stems", "group of 6 stems",
    "speed ramp video", "speed ramp audio", "speed ramp svg", "static speed", "in > 0 video", "in > 0 svg",
    ...ANIMATABLE.map((k) => "kf " + k), ...Object.keys(EASE).map((e) => "ease " + e),
    ...TRANSITIONS.filter((t) => t !== "none").map((t) => "transition " + t), "array prop",
  ];
  assert.deepEqual(want.filter((k) => !seen.has(k)), [], "shapes never generated");
});

propTest("GEN-03: op sequences resolve against any doc and every op kind goes ahead somewhere", (fc) => {
  const went = new Set();
  const all = [...O.F.ALL, "removeMedia", "setTiming"];
  for (const [raw, ops] of fc.sample(fc.tuple(A.arbProject(), O.arbOps(all, { maxLength: 10 })), { numRuns: 300, seed: 7 })) {
    const s = O.play(raw, ops, () => {});
    for (const l of s.log) if (/→ ok/.test(l)) went.add(l.replace(/^\d+\. (\S+).*/, "$1"));
  }
  const names = { trimL: "trim-l", trimR: "trim-r", move: "move" };
  assert.deepEqual(all.map((n) => names[n] || n).filter((n) => !went.has(n)), [], "op kinds that never went ahead");
});
