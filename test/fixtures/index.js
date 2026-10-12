/* Fixture projects for timeline tests.

   Each *.json here is a project.json as an agent or an older build would have
   written it — sparse props, optional fields left out — so tests exercise the
   same load path real files take. `loadFixture` hands out a deep copy; tests
   may mutate it freely.

   minimal               one video clip (same shape as helpers.seedProject)
   linked-av             two picture+L/R stem groups with a gap, a music bed, IN/OUT
   speed-ramp            linked group with a speed-keyframe ramp; a static 2× clip
   keyframes-transitions keyframed clips, same-track crossfade overlap, a styled title
   keyframe-anchors      keys outside their clip as written before anchors (D4): a
                         length edit's keys past the end, an agent's mid-fade
                         start, a speed ramp with a key before 0
   lanes-bin             custom lanes, folders, disabled lane, exportFrame, image/svg/adjust/text
   demo-reel             the docs/demo playground project: a copy of DEMO in
                         docs/demo/static-shim.js (test/contract/demo-fixture.test.js)
   legacy                pairwise linkedId, no panSchema, a clip without `in`/props, an undeclared lane */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DIR = __dirname;

function listFixtures() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, name + ".json"), "utf8"));
}

/* Small builders for scenarios that don't warrant a fixture file. */
const build = {
  project(over = {}) {
    return { name: "Built", width: 1280, height: 720, fps: 30, revision: 1, panSchema: 1, media: [], clips: [], ...over };
  },
  media(id, kind = "video", duration = 20) {
    return { id, name: id + (kind === "audio" ? ".mp3" : ".mp4"), kind, src: `/media/${id}`, duration };
  },
  clip(id, { mediaId = null, kind = "video", track = "V1", start = 0, inn = 0, duration = 5, props = {}, ...rest } = {}) {
    return { id, mediaId, kind, track, start, in: inn, duration, props, ...rest };
  },
};

module.exports = { listFixtures, loadFixture, build };
