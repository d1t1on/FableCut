/* Shared pieces of the invariant properties (test/props/*.test.js).

   checkOps(fc, names, check, opts) is the common shape: a generated project,
   a sequence of ops drawn from `names` (test/support/ops.js families), and
   `check(step)` after every op. The step carries the op, its result, the doc
   before (a JSON copy, clips by id) and after, and the session; lineage(doc)
   maps each pre-op clip id to the pieces that descend from it. */
"use strict";
const assert = require("node:assert/strict");
const { NUM_RUNS } = require("./fc");
const A = require("./arb");
const O = require("./ops");
const K = require("../../core/keyframes");
const { evalProps } = require("../../core/compose");
const { ANIMATABLE, MIN_DUR } = require("../../core/schema");

const TIMED = new Set(["video", "audio", "svg"]); // D5: `in` is meaningful (media / animation time)
const INERT = new Set(["image", "text", "adjust"]); // D5: `in` is always 0
const EPS = 1e-9;     // float noise on edges and tiling
const EPS_MEDIA = 1e-3; // media-time agreement (the ramp integral runs on a 1/120 s trapezoid grid)
const KF_EPS = 1e-3;  // keyframe t slack (shiftKF keeps ±1e-3)

/* scale: run this property scale × FC_NUM_RUNS times (for a rare shape). */
function checkOps(fc, names, check, { gen, maxOps = 8, scale = 1 } = {}) {
  fc.assert(fc.property(A.arbProject(gen), O.arbOps(names, { maxLength: maxOps }), (raw, ops) => {
    O.play(raw, ops, check);
  }), scale !== 1 ? { numRuns: Math.round(NUM_RUNS * scale) } : undefined);
}

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (Δ ${Math.abs(a - b)})`);
const hasRamp = (c) => K.hasSpeedRamp(c);
const end = (c) => c.start + c.duration;
/* n evenly spaced times across [t0, t1] (both ends included). */
function samples(t0, t1, n = 5) {
  if (!(t1 > t0)) return [t0];
  return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
}

/* mediaTimeAt through a probe id per role, so a pre-op clone and its post-op
   piece (same clip id) don't evict each other's cached ramp integral. */
const PROBES = { before: Symbol("before"), after: Symbol("after") };
const mediaAt = (c, t, role = "after") => K.mediaTimeAt({ ...c, id: PROBES[role] }, t);

/* What the compositor draws for c at t, transitions left out. */
function animAt(c, t, W = 1280, H = 720) {
  return evalProps({ ...c, transitionIn: undefined, transitionOut: undefined }, t, W, H);
}
/* Rendered-props agreement: equal up to float noise, or explained by
   shiftKF's rounding of keyframe times to 0.1 ms (the value lies between the
   original's values 0.1 ms either side). */
function sameAnim(piece, orig, t, msg) {
  const p = animAt(piece, t), o = animAt(orig, t);
  const lo = animAt(orig, t - 1e-4), hi = animAt(orig, t + 1e-4);
  for (const k of ANIMATABLE) {
    const a = p[k], b = o[k];
    if (typeof a !== "number" || typeof b !== "number") { assert.equal(a, b, `${msg}: ${k}`); continue; }
    if (Math.abs(a - b) <= 1e-6 * (1 + Math.abs(b))) continue;
    const [l, h] = [Math.min(lo[k], hi[k], b), Math.max(lo[k], hi[k], b)];
    assert.ok(a >= l - 1e-6 && a <= h + 1e-6, `${msg}: ${k} at t=${t} is ${a}, was ${b}`);
  }
}

/* linkGroup → members (groups of ≥ 2 only). */
function groups(clips) {
  const m = new Map();
  for (const c of clips) if (c.linkGroup) (m.get(c.linkGroup) || m.set(c.linkGroup, []).get(c.linkGroup)).push(c);
  for (const [k, v] of m) if (v.length < 2) m.delete(k);
  return m;
}
const speedKeys = (c) => (c.keyframes?.speed?.length ? c.keyframes.speed : null);
const mediaOf = (doc, c) => doc.media.find((m) => m.id === c.mediaId);
/* in + ∫speed dt ≤ media.duration (+1e-3), for clips whose media has a duration. */
function withinMedia(doc, c, role) {
  const m = mediaOf(doc, c);
  if (!m || !(m.duration > 0)) return true;
  return c.in >= -EPS && mediaAt(c, end(c), role) <= m.duration + EPS_MEDIA;
}
const json = (x) => JSON.parse(JSON.stringify(x));

module.exports = {
  TIMED, INERT, EPS, EPS_MEDIA, KF_EPS, MIN_DUR,
  checkOps, near, hasRamp, end, samples, mediaAt, animAt, sameAnim, groups, speedKeys, mediaOf, withinMedia, json,
};
