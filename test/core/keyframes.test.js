/* core/keyframes.js — keyframe curves, the playhead helpers, speed-ramp time
   remapping and the pure mutator cores, called directly with explicit
   time / fps. test/keyframes.test.js runs the same cores through app.js's
   wrappers; this file pins the pure API, including the effects records the
   wrappers turn into inspPropGen / dirtyTimeline / audio-hold / font calls. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const K = require("../../core/keyframes");
const { DEFAULT_PROPS, EASE, SPEED_MIN, SPEED_MAX } = require("../../core/schema");
const { TIMING } = require("../support/timing");

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`);
const FPS = 50; // eps = 0.01 s
const at = (time, fps = FPS) => ({ time, fps });

/* Clip on [10, 15] with a linear scale ramp 1 → 3 over local t 2 → 4. */
function keyed(over = {}) {
  return {
    id: "c1", start: 10, duration: 5, in: 0,
    props: { ...DEFAULT_PROPS, scale: 0.8 },
    keyframes: { scale: [{ t: 2, v: 1 }, { t: 4, v: 3, ease: "linear" }] },
    ...over,
  };
}
/* The four flags + ok, as a compact tuple. */
const fx = (r) => [r.ok, r.touched, r.propChanged, r.timelineChanged, r.font];
const REFUSED = [false, false, false, false, null];
const VALUE = [true, true, true, false, null];
const KEYED = [true, true, true, true, null];

/* ── Clip timing ── */
test("clipEnd / clipSpeed: end, clamp to SPEED_MIN…SPEED_MAX, junk → 1", () => {
  assert.equal(K.clipEnd({ start: 2, duration: 3.5 }), 5.5);
  const sp = (speed) => K.clipSpeed({ props: { speed } });
  assert.equal(sp(2), 2);
  assert.equal(sp("3"), 3);            // numeric strings coerce
  assert.equal(sp(0.01), SPEED_MIN);
  assert.equal(sp(99), SPEED_MAX);
  assert.equal(sp(0), 1);              // 0 is "unset", not "stopped"
  assert.equal(sp(NaN), 1);
  assert.equal(sp("fast"), 1);
  assert.equal(K.clipSpeed({}), 1);    // no props at all
});

/* ── kfChannel ── */
test("kfChannel: fallback, holds, every ease, unknown/empty ease names", () => {
  const c = keyed();
  assert.equal(K.kfChannel(c, "rotation", 2, 0.5), 0.5);             // no channel
  assert.equal(K.kfChannel({ keyframes: { x: [] } }, "x", 1, 7), 7);  // empty channel
  assert.equal(K.kfChannel({ keyframes: { x: "junk" } }, "x", 1, 7), 7);
  assert.equal(K.kfChannel({}, "x", 1, 7), 7);                        // no keyframes map
  assert.equal(K.kfChannel(c, "scale", 0, 0), 1);                     // before first
  assert.equal(K.kfChannel(c, "scale", 2, 0), 1);                     // on first
  assert.equal(K.kfChannel(c, "scale", 99, 0), 3);                    // after last
  // on the last key: its own value, exactly (interpolating would give 0.09999999999999998)
  assert.equal(K.kfChannel({ keyframes: { o: [{ t: 0, v: 1 }, { t: 1, v: 0.1 }] } }, "o", 1, 0), 0.1);
  assert.equal(K.kfChannel(c, "scale", 3, 0), 2);                     // linear midpoint
  for (const ease of Object.keys(EASE)) {
    c.keyframes.scale[1].ease = ease;
    assert.equal(K.kfChannel(c, "scale", 2.5, 0), 1 + 2 * EASE[ease](0.25), ease);
  }
  c.keyframes.scale[1].ease = "bogus";
  assert.equal(K.kfChannel(c, "scale", 3, 0), 2, "unknown ease → linear");
  c.keyframes.scale[1].ease = "";
  assert.equal(K.kfChannel(c, "scale", 2.5, 0), 1 + 2 * EASE["ease-in-out"](0.25), "empty → the default ease-in-out");
  delete c.keyframes.scale[1].ease;
  assert.equal(K.kfChannel(c, "scale", 2.5, 0), 1 + 2 * EASE["ease-in-out"](0.25));
  assert.equal(K.kfChannel(c, "scale", NaN, "fb"), "fb", "no segment matches NaN");
  // three keys: the segment is picked by position, ease from its destination
  const three = { keyframes: { y: [{ t: 0, v: 0 }, { t: 1, v: 10, ease: "linear" }, { t: 2, v: 30, ease: "linear" }] } };
  assert.equal(K.kfChannel(three, "y", 1.5, 0), 20);
  // zero-length segment: the first key wins at its time, no division by zero
  const flat = { keyframes: { y: [{ t: 0, v: 0 }, { t: 1, v: 5 }, { t: 1, v: 9 }, { t: 2, v: 9 }] } };
  assert.equal(K.kfChannel(flat, "y", 1, 0), 5);
  assert.ok(Number.isFinite(K.kfChannel(flat, "y", 1.5, 0)));
});

/* ── Playhead helpers, explicit time/fps ── */
test("kfTimeEps is half a frame", () => {
  assert.equal(K.kfTimeEps(50), 0.01);
  assert.equal(K.kfTimeEps(25), 0.02);
});

test("playheadOverClip: inside, ±half-frame edges, outside, fps-dependent", () => {
  const c = keyed();
  assert.equal(K.playheadOverClip(c, 12, FPS), true);
  assert.equal(K.playheadOverClip(c, 10 - 0.009, FPS), true);
  assert.equal(K.playheadOverClip(c, 15 + 0.009, FPS), true);
  assert.equal(K.playheadOverClip(c, 10 - 0.011, FPS), false);
  assert.equal(K.playheadOverClip(c, 15 + 0.011, FPS), false);
  assert.equal(K.playheadOverClip(c, 10 - 0.011, 25), true, "a coarser frame widens the tolerance");
  assert.equal(K.playheadOverClip(c, undefined, FPS), false, "no playhead → never over");
});

test("playheadOverClip / kfAtPlayhead / ◆: exactly half a frame is inclusive for the clip, exclusive for a key", () => {
  const fps = 4; // half a frame = 0.125 s: exact in binary and at the 1 ms key grid
  const eps = K.kfTimeEps(fps);
  assert.equal(eps, 0.125);
  const c = { id: "h", start: 10, duration: 2, props: { ...DEFAULT_PROPS }, keyframes: { x: [{ t: 1, v: 5 }] } };
  assert.equal(K.playheadOverClip(c, 10 - eps, fps), true);
  assert.equal(K.playheadOverClip(c, 12 + eps, fps), true);
  assert.equal(K.kfAtPlayhead(c, "x", 11 + eps, fps), null, "a key half a frame away belongs to the neighboring frame");
  assert.equal(K.kfAtPlayhead(c, "x", 11 + eps / 2, fps), c.keyframes.x[0]);
  assert.deepEqual(fx(K.toggleKfAtPlayhead(c, "x", { time: 11 + eps, fps })), KEYED, "so ◆ there adds a key");
  assert.deepEqual(c.keyframes.x.map((k) => k.t), [1, 1.125]);
  const d = { id: "h2", start: 10, duration: 2, props: { ...DEFAULT_PROPS }, keyframes: { x: [{ t: 1, v: 5 }] } };
  assert.deepEqual(fx(K.setAnimProp(d, "x", 7, { time: 11 + eps, fps })), KEYED, "…and so does a value write");
  assert.deepEqual(d.keyframes.x.map((k) => [k.t, k.v]), [[1, 5], [1.125, 7]]);
  // just inside half a frame, the key at the playhead is the one written, even though
  // the playhead's local time rounds (to the ms) onto the half-frame mark
  const e = { id: "h3", start: 10, duration: 2, props: { ...DEFAULT_PROPS }, keyframes: { x: [{ t: 1, v: 5 }] } };
  assert.deepEqual(fx(K.setAnimProp(e, "x", 7, { time: 11.1247, fps })), VALUE);
  assert.deepEqual(e.keyframes.x, [{ t: 1, v: 7 }]);
});

test("kfAtPlayhead: the keyframe object at the playhead, never an off-clip clamp", () => {
  const c = keyed();
  assert.equal(K.kfAtPlayhead(c, "scale", 12.009, FPS), c.keyframes.scale[0]);
  assert.equal(K.kfAtPlayhead(c, "scale", 14, FPS), c.keyframes.scale[1]);
  assert.equal(K.kfAtPlayhead(c, "scale", 12.5, FPS), null);
  assert.equal(K.kfAtPlayhead(c, "scale", 0, FPS), null);
  assert.equal(K.kfAtPlayhead(c, "rotation", 12, FPS), null);
  assert.equal(K.kfAtPlayhead({ ...c, keyframes: { scale: [] } }, "scale", 12, FPS), null);
});

test("propsAtPlayhead: animatable keyed channels only, a fresh copy, NaN ignored", () => {
  const c = keyed({ keyframes: {
    scale: [{ t: 2, v: 1 }, { t: 4, v: 3, ease: "linear" }],
    fit: [{ t: 0, v: 5 }],               // not animatable → ignored here
    opacity: [{ t: 0, v: NaN }],         // non-finite result → static kept
    x: [],                               // empty channel → static kept
  } });
  c.props.x = 40;
  const p = K.propsAtPlayhead(c, 13);
  assert.notEqual(p, c.props);
  assert.equal(p.scale, 2);
  assert.equal(p.fit, "contain");
  assert.equal(p.opacity, 1);
  assert.equal(p.x, 40);
  assert.equal(c.props.scale, 0.8, "the clip is untouched");
  assert.equal(K.propsAtPlayhead(c, 0).scale, 1, "off-clip: nearest edge value, display only");
  const bare = keyed({ keyframes: undefined });
  assert.deepEqual(K.propsAtPlayhead(bare, 12), bare.props);
  // an empty channel adds nothing, not even the default of a prop the clip doesn't set
  assert.deepEqual(K.propsAtPlayhead({ start: 0, duration: 4, props: { opacity: 0.5 }, keyframes: { scale: [] } }, 1), { opacity: 0.5 });
  // a playhead no segment matches (NaN) reads the static value, else the default
  const lost = { start: 0, duration: 4, props: { opacity: 0.5 },
    keyframes: { opacity: [{ t: 0, v: 0 }, { t: 2, v: 1 }], x: [{ t: 0, v: 1 }, { t: 2, v: 3 }] } };
  assert.deepEqual(K.propsAtPlayhead(lost, NaN), { opacity: 0.5, x: DEFAULT_PROPS.x });
  const text = { start: 0, duration: 4, props: { x: 3 }, keyframes: { x: [{ t: 0, v: "5" }] } };
  assert.deepEqual(K.propsAtPlayhead(text, 1), { x: 3 }, "a non-number key value is ignored, even a numeric string");
  assert.notEqual(K.propsAtPlayhead(bare, 12), bare.props);
});

/* ── shiftKF ── */
test("shiftKF: rebases, rounds to 4 decimals, keeps the keys on [0, dur] ± 1 ms and one anchor per side (D4)", () => {
  assert.equal(K.shiftKF(undefined, 1, 5), undefined);
  assert.equal(K.shiftKF(null, 1, 5), undefined);
  const kfs = {
    x: [{ t: 0, v: 0 }, { t: 1.00005, v: 1, ease: "ease-in" }, { t: 3, v: 2 }, { t: 6.0009, v: 3 }],
    y: [{ t: 0.5, v: 9 }],
  };
  const before = JSON.stringify(kfs);
  const out = K.shiftKF(kfs, 1, 5);
  assert.deepEqual(out, {
    x: [{ t: -1, v: 0 }, { t: 0.0001, v: 1, ease: "ease-in" }, { t: 2, v: 2 }, { t: 5.0009, v: 3 }],
    y: [{ t: -0.5, v: 9 }],
  }, "the key before 0 stays as an anchor; y's only key holds its value");
  assert.equal(JSON.stringify(kfs), before, "input not mutated");
  assert.notEqual(out.x[1], kfs.x[1], "keyframes are copies");
  assert.deepEqual(K.shiftKF({ x: [{ t: 0.9995, v: 1 }] }, 1, 5), { x: [{ t: -0.0005, v: 1 }] }, "−0.5 ms is inside the tolerance");
  assert.deepEqual(K.shiftKF({ x: [{ t: 0, v: 0 }, { t: 5, v: 1 }] }, 0, 2), { x: [{ t: 0, v: 0 }, { t: 5, v: 1 }] }, "trim right keeps the key past the end");
  assert.deepEqual(K.shiftKF({ x: [{ t: 9, v: 1 }] }, 0, 2), { x: [{ t: 9, v: 1 }] }, "a lone key past the end is the anchor");
  const many = { x: [-3, -2, 1, 4, 6].map((t) => ({ t, v: t })) };
  assert.deepEqual(K.shiftKF(many, 0, 3).x.map((k) => k.t), [-2, 1, 4], "only the nearest key outside each edge survives");
  assert.deepEqual(K.shiftKF(many, 5, 0.5).x.map((k) => k.t), [-1, 1], "no key on the clip: the two anchors");
  assert.deepEqual(K.shiftKF({ x: [{ t: 3, v: 1 }, { t: 1, v: 0 }] }, 0, 2).x.map((k) => k.t), [1, 3], "sorted");
  assert.equal(K.shiftKF({}, 0, 2), undefined);
  assert.equal(K.shiftKF({ x: [] }, 0, 2), undefined, "an empty channel is dropped");
  assert.deepEqual(K.shiftKF({ x: [{ t: 0, v: 0 }, { t: 2.001, v: 1 }, { t: 3, v: 2 }, { t: 4, v: 3 }] }, 0, 2).x.map((k) => k.t), [0, 2.001, 3],
    "a key exactly 1 ms past the end is on the clip; the next one is its anchor");
  assert.deepEqual(K.shiftKF({ x: [{ t: -2, v: 0 }, { t: -1, v: 1 }, { t: -0.001, v: 2 }, { t: 1, v: 3 }] }, 0, 2).x.map((k) => k.t), [-1, -0.001, 1],
    "…and 1 ms before the start: on the clip, with the key before it as its anchor");
  assert.deepEqual(K.shiftKF({ x: [], y: [{ t: 1, v: 1 }] }, 0, 2), { y: [{ t: 1, v: 1 }] });
});

test("anchors keep a cut segment interpolating exactly, for every ease (D4)", () => {
  for (const ease of ["linear", "ease-in", "ease-out", "ease-in-out"]) {
    const c = { start: 0, duration: 4, keyframes: { opacity: [{ t: 0, v: 0 }, { t: 4, v: 1, ease }] } };
    const left = { start: 0, duration: 1.3, keyframes: K.shiftKF(c.keyframes, 0, 1.3) };
    const right = { start: 1.3, duration: 2.7, keyframes: K.shiftKF(c.keyframes, 1.3, 2.7) };
    for (const t of [0, 0.7, 1.3, 2, 3.9]) {
      const want = K.kfChannel(c, "opacity", t, 1);
      const piece = t <= 1.3 ? left : right;
      assert.ok(Math.abs(K.kfChannel(piece, "opacity", t - piece.start, 1) - want) < 1e-12, `${ease} at ${t}`);
    }
  }
});

test("keysOnClip / kfAtPlayhead: anchors are not on the clip, so never at the playhead (D4)", () => {
  const c = { start: 10, duration: 2, keyframes: { x: [{ t: -0.01, v: 0 }, { t: 0, v: 1 }, { t: 2.0005, v: 2 }, { t: 2.01, v: 3 }] } };
  assert.deepEqual(K.keysOnClip(c, "x").map((k) => k.t), [0, 2.0005]);
  assert.deepEqual(K.keysOnClip(c, "y"), []);
  assert.deepEqual(K.keysOnClip({ duration: 2 }, "x"), [], "no keyframes at all");
  const edge = { duration: 2, keyframes: { x: [{ t: -K.KF_EPS, v: 0 }, { t: 2 + K.KF_EPS, v: 1 }] } };
  assert.deepEqual(K.keysOnClip(edge, "x").map((k) => k.v), [0, 1], "exactly KF_EPS outside an edge is still on it");
  assert.equal(K.kfAtPlayhead(c, "x", 9.99, 30), c.keyframes.x[1], "0.01 s off: the key at 0, not the anchor");
  assert.equal(K.kfAtPlayhead({ ...c, keyframes: { x: [c.keyframes.x[0]] } }, "x", 9.99, 30), null);
  assert.equal(K.kfAtPlayhead({ ...c, keyframes: { x: [c.keyframes.x[3]] } }, "x", 12.01, 30), null);
});

test("setAnimProp / toggleKfAtPlayhead: never write an anchor; the last key on the clip takes the channel with it (D4)", () => {
  const mk = () => ({ id: "a", start: 10, duration: 2, props: { ...DEFAULT_PROPS }, keyframes: { x: [{ t: -0.01, v: 0 }, { t: 1, v: 5 }, { t: 3, v: 9 }] } });
  let c = mk();
  assert.deepEqual(fx(K.setAnimProp(c, "x", 7, at(10))), KEYED, "a new key at 0, beside the anchor 0.01 s away");
  assert.deepEqual(c.keyframes.x.map((k) => [k.t, k.v]), [[-0.01, 0], [0, 7], [1, 5], [3, 9]]);
  c = mk();
  assert.deepEqual(fx(K.toggleKfAtPlayhead(c, "x", at(10))), KEYED);
  assert.deepEqual(c.keyframes.x.map((k) => k.t), [-0.01, 0, 1, 3], "added at 0; the anchor is untouched");
  c = mk();
  assert.deepEqual(fx(K.toggleKfAtPlayhead(c, "x", at(11))), KEYED);
  assert.equal(c.keyframes, undefined, "no key left on the clip: the channel (anchors too) goes");
  assert.equal(c.props.x, 5, "its value survives as the static prop");
});

/* ── Speed ramps ── */
test("hasSpeedRamp: a non-empty speed channel", () => {
  assert.equal(K.hasSpeedRamp({}), false);
  assert.equal(K.hasSpeedRamp({ keyframes: {} }), false);
  assert.equal(K.hasSpeedRamp({ keyframes: { speed: [] } }), false);
  assert.equal(K.hasSpeedRamp({ keyframes: { speed: "x" } }), false);
  assert.equal(K.hasSpeedRamp({ keyframes: { speed: [{ t: 0, v: 2 }] } }), true);
});

test("mediaTimeAt static: in + local × speed, clamped to the clip", () => {
  const c = { id: "s", start: 10, in: 2, duration: 4, props: { speed: 1.5 } };
  assert.equal(K.mediaTimeAt(c, 12), 2 + 2 * 1.5);
  assert.equal(K.mediaTimeAt(c, 0), 2, "before the clip → its first frame");
  assert.equal(K.mediaTimeAt(c, 99), 2 + 4 * 1.5, "after → its last");
  assert.equal(K.mediaTimeAt({ ...c, props: { speed: 20 } }, 11), 2 + SPEED_MAX, "speed clamps");
});

test("mediaTimeAt ramp: trapezoid integral of the speed curve", () => {
  K.clearSpeedCache();
  // 1 → 3 linear over 2 s, then 3: ∫ = 4 + 3·(t − 2)
  const c = { id: "r", start: 0, in: 1, duration: 6, props: {},
    keyframes: { speed: [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }, { t: 6, v: 3, ease: "linear" }] } };
  near(K.mediaTimeAt(c, 0), 1, 1e-9, "start");
  near(K.mediaTimeAt(c, 1), 1 + 1.5, 1e-3, "∫₀¹ (1 + t) dt");
  near(K.mediaTimeAt(c, 2), 1 + 4, 1e-3);
  near(K.mediaTimeAt(c, 6), 1 + 4 + 12, 1e-3, "end");
  near(K.mediaTimeAt(c, 60), 1 + 4 + 12, 1e-3, "clamped past the end");
  near(K.mediaTimeAt({ ...c, start: 10, id: "r2" }, 12), 1 + 4, 1e-3, "timeline offset");
  // keys outside SPEED_MIN…SPEED_MAX are clamped per sample
  const wild = { id: "w", start: 0, in: 0, duration: 2, props: {}, keyframes: { speed: [{ t: 0, v: 50 }] } };
  near(K.mediaTimeAt(wild, 2), 2 * SPEED_MAX, 1e-3);
  const slow = { id: "w2", start: 0, in: 0, duration: 2, props: {}, keyframes: { speed: [{ t: 0, v: 0 }] } };
  near(K.mediaTimeAt(slow, 2), 2 * SPEED_MIN, 1e-3);
  // A final grid cell shorter than 1/120 s is interpolated over its real
  // length (BUG-26: it used to be read as a full step, 0.006 here)
  const tiny = { id: "t", start: 0, in: 0, duration: 0.005, props: {}, keyframes: { speed: [{ t: 0, v: 2 }] } };
  near(K.mediaTimeAt(tiny, 0.005), 0.01, 1e-12, "exact ∫");
  near(K.mediaTimeAt(tiny, 0.0025), 0.005, 1e-12, "halfway through the partial step");
  const tail = { id: "t2", start: 0, in: 0, duration: 0.501, props: {}, keyframes: { speed: [{ t: 0, v: 1 }, { t: 0.501, v: 3, ease: "linear" }] } };
  near(K.mediaTimeAt(tail, 0.501), 0.501 * 2, 1e-9, "a linear ramp integrates exactly, last partial step included");
});

test("headRamp: the speed curve before 0 — an anchor's segment, then the first key held (D4)", () => {
  const flat = K.headRamp({ start: 0, in: 0, duration: 4, props: { speed: 2 } });
  assert.deepEqual([flat.back(1.5), flat.reach(3), flat.reach(0), flat.reach(-1)], [3, 1.5, 0, 0], "static speed: exact");
  const late = K.headRamp({ start: 0, in: 0, duration: 4, props: {}, keyframes: { speed: [{ t: 0.5, v: 3 }, { t: 2, v: 1 }] } });
  assert.deepEqual([late.back(2), late.reach(3)], [6, 1], "no key before 0: the first value held, exactly");
  // an anchor at −2 (1×) and a key at 2 (3×), linear: speed = 2 + t/2 on [−2, 2], then 1× before −2
  const c = { start: 0, in: 0, duration: 4, props: {}, keyframes: { speed: [{ t: -2, v: 1 }, { t: 2, v: 3, ease: "linear" }] } };
  const h = K.headRamp(c);
  near(h.back(1), 2 - 1 / 4, 1e-4, "∫₋₁⁰ (2 + t/2) dt");
  near(h.back(2), 3, 1e-4);
  near(h.back(4), 5, 1e-4, "1× held before the anchor");
  near(h.reach(1.75), 1, 1e-4);
  near(h.reach(5), 4, 1e-4);
  for (const e of [0, 0.3, 1.9, 2, 3.7]) near(h.back(h.reach(h.back(e))), h.back(e), 1e-12, `reach inverts back at ${e}`);
});

test("headRamp: exact between grid points and inside a partial last step", () => {
  // an anchor at −1.004 s (1×) and a key at 1 s (3×), linear; the span is not a whole number of 1/120 s steps
  const t0 = -1.004, v0 = 1, t1 = 1, v1 = 3, span = -t0;
  const speed = (t) => v0 + ((v1 - v0) / (t1 - t0)) * (t - t0);
  const back = (e) => (e <= span ? ((speed(-e) + speed(0)) / 2) * e : ((speed(t0) + speed(0)) / 2) * span + (e - span) * v0);
  const h = K.headRamp({ start: 0, in: 0, duration: 4, props: {}, keyframes: { speed: [{ t: t0, v: v0 }, { t: t1, v: v1, ease: "linear" }] } });
  // off the grid, back() interpolates a quadratic linearly: ≤ STEP²/8 × slope ≈ 9e-6 off
  for (const e of [0.004, 0.5003, 1.0001, 1.003, span, 1.5]) near(h.back(e), back(e), 2e-5, `back(${e})`);
  for (const e of [0.004, 0.5003, 1.0001, 1.003, 1.5]) near(h.reach(back(e)), e, 2e-5, `reach(back(${e}))`);
});

test("durationUntil: the longest duration whose source window ends on a media time (BUG-23)", () => {
  K.clearSpeedCache();
  near(K.durationUntil({ in: 2, props: { speed: 1.5 } }, 8), 4, 1e-12, "static: (end − in) / speed");
  assert.ok(K.durationUntil({ in: 9, props: {} }, 8) < 0, "static, in past the end");
  const ramp = (keys, over = {}) => ({ id: "du", start: 0, in: 0, duration: 2, props: {}, keyframes: { speed: keys }, ...over });
  assert.equal(K.durationUntil(ramp([{ t: 0, v: 2 }], { in: 9 }), 8), 0, "ramp, in past the end");
  near(K.durationUntil(ramp([{ t: 0, v: 2 }]), 10), 5, 1e-9, "constant ramp");
  // 1× → 3× over 2 s (∫ = t + t²/2), then 3× held
  const lin = [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }];
  near(K.durationUntil(ramp(lin), 7), 3, 1e-9, "past the last key: 4 + 3 × 1");
  near(K.durationUntil(ramp(lin), 2), Math.sqrt(5) - 1, 1e-9, "inside the ramp: t + t²/2 = 2");
  const t0 = performance.now();
  near(K.durationUntil(ramp([{ t: 0, v: 2 }, { t: 1e7, v: 2 }]), 10), 5, 1e-9, "a stray far key");
  if (TIMING) assert.ok(performance.now() - t0 < 100, "…is not integrated up to");
  // an eased ramp: a clip of the solved length ends on the media time, on mediaTimeAt's grid
  const eased = [{ t: 0, v: 0.5 }, { t: 1.3, v: 4, ease: "ease-in-out" }, { t: 2.7, v: 1, ease: "ease-in" }];
  for (const end of [0.4, 1.234, 3.1, 5, 9.99]) {
    const d = K.durationUntil(ramp(eased), end);
    const got = K.mediaTimeAt(ramp(eased, { id: "du" + end, duration: d }), d);
    assert.ok(got <= end + 1e-9 && got >= end - 1e-6, `end ${end}: duration ${d} plays to ${got}`);
    const longer = K.mediaTimeAt(ramp(eased, { id: "du+" + end, duration: d + 1e-6 }), d + 1e-6);
    assert.ok(longer > end, `end ${end}: 1 µs longer overruns (${longer})`);
  }
});

test("mediaTimeAt: a clip whose end falls on a grid point in float (2.075 s) ends on the exact integral, not 0 / 0", () => {
  K.clearSpeedCache();
  const c = { id: "g", start: 0, in: 0, duration: 2.075, props: {}, keyframes: { speed: [{ t: 0, v: 2 }] } };
  near(K.mediaTimeAt(c, 2.075), 4.15, 1e-9, "the last step has zero length here");
});

test("mediaTimeAt cache: per clip id, invalidated by curve / duration / base speed", () => {
  K.clearSpeedCache();
  const c = { id: "cache", start: 0, in: 0, duration: 4, props: {},
    keyframes: { speed: [{ t: 0, v: 1 }, { t: 4, v: 1, ease: "linear" }] } };
  near(K.mediaTimeAt(c, 4), 4, 1e-4);
  c.keyframes.speed[1].v = 3;                       // curve edit
  near(K.mediaTimeAt(c, 4), 8, 1e-3, "curve change re-integrates");
  c.duration = 2;                                   // trim (curve now ends past the clip)
  near(K.mediaTimeAt(c, 2), 3, 1e-3, "duration change re-integrates");
  const flat = { id: "cache", start: 0, in: 0, duration: 2, props: { speed: 2 }, keyframes: { speed: [{ t: 5, v: 7 }] } };
  near(K.mediaTimeAt(flat, 2), 14, 1e-3, "same id, other curve: the key tells them apart");
});

test("mediaTimeAt cache: hits skip the integral; clearSpeedCache() / (id) drop entries", () => {
  K.clearSpeedCache();
  let reads = 0;
  const kf = (t, v) => ({ t, get v() { reads++; return v; } });
  const mk = (id) => ({ id, start: 0, in: 0, duration: 3, props: {}, keyframes: { speed: [kf(0, 1), kf(3, 2)] } });
  const a = mk("a"), b = mk("b");
  const count = (fn) => { reads = 0; fn(); return reads; };
  const miss = count(() => K.mediaTimeAt(a, 1));
  assert.ok(miss > 100, `first call integrates (${miss} reads)`);
  assert.equal(count(() => K.mediaTimeAt(a, 2)), 2, "hit: only the cache key reads the curve");
  K.mediaTimeAt(b, 1);
  K.clearSpeedCache("a");
  assert.ok(count(() => K.mediaTimeAt(a, 1)) > 100, "clearSpeedCache(id) drops that clip");
  assert.equal(count(() => K.mediaTimeAt(b, 1)), 2, "…and only that clip");
  K.clearSpeedCache();
  assert.ok(count(() => K.mediaTimeAt(b, 1)) > 100, "clearSpeedCache() drops everything");
});

/* ── Mutators: effects records ── */
test("setAnimProp: static write, keyed update, auto-key insert, eps duplicate", () => {
  let c = keyed();
  assert.deepEqual(fx(K.setAnimProp(c, "rotation", 45, at(0))), VALUE, "unkeyed: static, playhead-independent");
  assert.equal(c.props.rotation, 45);
  assert.deepEqual(fx(K.setAnimProp(c, "rotation", 5)), VALUE, "no playhead needed for a static write");

  assert.deepEqual(fx(K.setAnimProp(c, "scale", 2.5, at(12))), VALUE, "parked on a keyframe: value only");
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[2, 2.5], [4, 3]]);

  assert.deepEqual(fx(K.setAnimProp(c, "scale", 9, at(13))), KEYED, "between keys: auto-key");
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[2, 2.5], [3, 9], [4, 3]]);

  // playhead just past the end: no key at the playhead, but the local time clamps
  // to 3, within eps of the key at 2.995 → that key is updated, none inserted
  c = keyed({ duration: 3, keyframes: { scale: [{ t: 1, v: 1 }, { t: 2.995, v: 2 }] } });
  assert.deepEqual(fx(K.setAnimProp(c, "scale", 7, at(13.009))), VALUE, "clamped local time hits a near duplicate");
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[1, 1], [2.995, 7]]);
});

test("setAnimProp: refusals change nothing and report nothing", () => {
  const c = keyed();
  const before = JSON.stringify(c);
  assert.deepEqual(fx(K.setAnimProp(c, "scale", 9, at(0))), REFUSED, "keyed, playhead off the clip");
  assert.deepEqual(fx(K.setAnimProp(c, "scale", 9)), REFUSED, "keyed, no playhead at all");
  assert.deepEqual(fx(K.setAnimProp(c, "scale", NaN, at(12))), REFUSED);
  assert.deepEqual(fx(K.setAnimProp(c, "scale", "2", at(12))), REFUSED);
  assert.deepEqual(fx(K.setAnimProp(c, "fit", 1, at(12))), REFUSED, "not animatable");
  assert.deepEqual(fx(K.setAnimProp(null, "scale", 1, at(12))), REFUSED);
  assert.equal(JSON.stringify(c), before);
});

test("toggleKfAtPlayhead: add, eps-duplicate, remove, last-key promotion, refusals", () => {
  const c = keyed();
  assert.deepEqual(fx(K.toggleKfAtPlayhead(c, "rotation", at(13))), KEYED, "add holds the playhead value");
  assert.deepEqual(c.keyframes.rotation, [{ t: 3, v: 0 }]);
  assert.deepEqual(fx(K.toggleKfAtPlayhead(c, "scale", at(13))), KEYED, "add on a keyed channel");
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[2, 1], [3, 2], [4, 3]]);

  assert.deepEqual(fx(K.toggleKfAtPlayhead(c, "scale", at(12))), KEYED, "remove the one under the playhead");
  assert.deepEqual(c.keyframes.scale.map((k) => k.t), [3, 4]);

  const one = keyed({ keyframes: { scale: [{ t: 2, v: 1.7 }] } });
  assert.deepEqual(fx(K.toggleKfAtPlayhead(one, "scale", at(12))), KEYED);
  assert.equal(one.keyframes, undefined, "last channel gone → no keyframes map");
  assert.equal(one.props.scale, 1.7, "its value becomes the static prop");
  const two = keyed({ keyframes: { scale: [{ t: 2, v: 1.7 }], x: [{ t: 0, v: 3 }] } });
  K.toggleKfAtPlayhead(two, "scale", at(12));
  assert.deepEqual(Object.keys(two.keyframes), ["x"], "other channels stay");

  // same clamp case as setAnimProp: the near-duplicate key is refreshed, not doubled
  const past = keyed({ duration: 3, keyframes: { x: [{ t: 2.995, v: 2 }] } });
  assert.deepEqual(fx(K.toggleKfAtPlayhead(past, "x", at(13.009))), VALUE);
  assert.deepEqual(past.keyframes.x, [{ t: 2.995, v: 2 }]);

  const off = keyed({ keyframes: undefined });
  assert.deepEqual(fx(K.toggleKfAtPlayhead(off, "scale", at(0))), REFUSED, "off-clip");
  assert.equal(off.keyframes, undefined);
  assert.deepEqual(fx(K.toggleKfAtPlayhead(off, "fit", at(12))), REFUSED, "not animatable");
  assert.deepEqual(fx(K.toggleKfAtPlayhead(null, "x", at(12))), REFUSED);
  const junk = keyed({ keyframes: { x: [{ t: 0, v: "a" }] } });
  assert.deepEqual(fx(K.toggleKfAtPlayhead(junk, "x", at(13))), REFUSED, "a non-number value can't be keyed");
  assert.deepEqual(junk.keyframes, { x: [{ t: 0, v: "a" }] });
  for (const v of ["5", NaN]) {
    const bad = keyed({ keyframes: { x: [{ t: 0, v }] } });
    assert.deepEqual(fx(K.toggleKfAtPlayhead(bad, "x", at(13))), REFUSED, `${v}: not a number either`);
  }
  // an unkeyed channel keys its static value, else the default; no keyframes (or props) object is needed
  const bare = { id: "b", start: 10, duration: 5, props: { x: 40 } };
  assert.deepEqual(fx(K.toggleKfAtPlayhead(bare, "x", at(12))), KEYED);
  assert.deepEqual(bare.keyframes, { x: [{ t: 2, v: 40 }] });
  K.toggleKfAtPlayhead(bare, "scale", at(12));
  assert.deepEqual(bare.keyframes.scale, [{ t: 2, v: DEFAULT_PROPS.scale }]);
  const none = { id: "n", start: 10, duration: 5 };
  assert.deepEqual(fx(K.toggleKfAtPlayhead(none, "opacity", at(12))), KEYED);
  assert.deepEqual(none.keyframes, { opacity: [{ t: 2, v: DEFAULT_PROPS.opacity }] });
});

test("resetPropChannel: default + channel wiped; transitions; labels; fonts", () => {
  const c = keyed({ transitionIn: { type: "fade", duration: 1 } });
  c.props.scale = 2.2;
  assert.deepEqual(fx(K.resetPropChannel(c, "scale")), [true, false, true, true, null], "keyframes deleted → timeline");
  assert.equal(c.props.scale, 1);
  assert.equal(c.keyframes, undefined);
  assert.deepEqual(fx(K.resetPropChannel(c, "rotation")), [true, false, true, false, null], "static only");
  assert.deepEqual(fx(K.resetPropChannel(c, "transIn")), [true, false, false, true, null]);
  assert.equal(c.transitionIn, undefined);
  c.transitionOut = { type: "zoom", duration: 1 };
  K.resetPropChannel(c, "transOut");
  assert.equal(c.transitionOut, undefined);
  c.props.text = "Hi";
  assert.deepEqual(fx(K.resetPropChannel(c, "text")), [true, false, true, true, null], "label redraw");
  assert.equal(c.props.text, DEFAULT_PROPS.text);
  c.props.font = "Anton";
  assert.deepEqual(fx(K.resetPropChannel(c, "font")), [true, false, true, true, String(DEFAULT_PROPS.font)]);
  assert.equal(c.props.font, DEFAULT_PROPS.font);
  const two = keyed({ keyframes: { x: [{ t: 0, v: 1 }], y: [{ t: 0, v: 2 }] } });
  K.resetPropChannel(two, "x");
  assert.deepEqual(two.keyframes, { y: [{ t: 0, v: 2 }] }, "the other channels stay");
  const empty = keyed({ keyframes: { x: [] } });
  assert.deepEqual(fx(K.resetPropChannel(empty, "x")), [true, false, true, true, null], "an empty channel is still wiped");
  assert.equal(empty.keyframes, undefined);
  for (const [cc, k] of [[c, "bogus"], [c, ""], [c, undefined], [null, "x"]])
    assert.deepEqual(fx(K.resetPropChannel(cc, k)), REFUSED, String(k));
});

test("resetPropAtPlayhead: parked → remove, keyed → auto-key default, unkeyed → static", () => {
  let c = keyed();
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "scale", at(12))), KEYED, "parked: toggle removes it");
  assert.deepEqual(c.keyframes.scale.map((k) => k.t), [4]);

  c = keyed();
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "scale", at(13))), KEYED, "between keys: default auto-keyed");
  assert.deepEqual(c.keyframes.scale.map((k) => [k.t, k.v]), [[2, 1], [3, 1], [4, 3]]);

  c = keyed();
  const before = JSON.stringify(c);
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "scale", at(0))), REFUSED, "keyed, off-clip");
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "scale")), REFUSED, "keyed, no playhead");
  assert.equal(JSON.stringify(c), before);

  c.props.rotation = 77;
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "rotation", at(0))), [true, false, true, false, null],
    "unkeyed: static default, no generation bump (the caller re-renders)");
  assert.equal(c.props.rotation, 0);
  c.props.fit = "cover";
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "fit", at(0))), [true, false, true, false, null], "non-animatable");
  assert.equal(c.props.fit, "contain");
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "text", at(0))), [true, false, true, true, null]);
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "font", at(0))), [true, false, true, true, String(DEFAULT_PROPS.font)]);
  c.transitionIn = { type: "fade", duration: 1 };
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "transIn", at(0))), [true, false, false, true, null]);
  assert.equal(c.transitionIn, undefined);
  c.transitionOut = { type: "fade", duration: 1 };
  assert.deepEqual(fx(K.resetPropAtPlayhead(c, "transOut", at(0))), [true, false, false, true, null]);
  assert.equal(c.transitionOut, undefined);
  const plain = { start: 10, duration: 5, props: { x: 9 } }; // no keyframes object at all
  assert.deepEqual(fx(K.resetPropAtPlayhead(plain, "x", at(12))), [true, false, true, false, null]);
  assert.equal(plain.props.x, DEFAULT_PROPS.x);
  for (const [cc, k] of [[c, "bogus"], [c, ""], [null, "x"]])
    assert.deepEqual(fx(K.resetPropAtPlayhead(cc, k, at(12))), REFUSED, String(k));
});

test("effects records are frozen", () => {
  const c = keyed();
  for (const r of [K.setAnimProp(c, "x", 1, at(12)), K.setAnimProp(null, "x", 1), K.resetPropChannel(c, "font")])
    assert.ok(Object.isFrozen(r));
});

test("module surface is frozen and pure", () => {
  assert.ok(Object.isFrozen(K));
  for (const [name, v] of Object.entries(K)) if (typeof v === "function") assert.ok(Object.isFrozen(v), `${name} is frozen too`);
  assert.deepEqual(Object.keys(K).sort(), [
    "KF_EPS", "clearSpeedCache", "clipEnd", "clipSpeed", "durationUntil", "hasSpeedRamp", "headRamp", "keysOnClip",
    "kfAtPlayhead", "kfChannel", "kfTimeEps",
    "mediaTimeAt", "playheadOverClip", "propsAtPlayhead", "resetPropAtPlayhead", "resetPropChannel",
    "setAnimProp", "shiftKF", "toggleKfAtPlayhead",
  ]);
});

/* The ease lookup is own-property safe (D7): an ease named after an
   Object.prototype member used to resolve to it — "__proto__" is not a
   function and threw inside the render loop. The validator reports such an
   ease as an error; the curve falls back to linear like any unknown ease. */
test("BUG-18: given an ease named like an Object.prototype member, when evaluated, then it falls back to linear",
  () => {
    for (const ease of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const c = keyed();
      c.keyframes.scale[1].ease = ease;
      assert.equal(K.kfChannel(c, "scale", 3, 0), 2, ease);
    }
  });
