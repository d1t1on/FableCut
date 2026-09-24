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
  assert.notEqual(K.propsAtPlayhead(bare, 12), bare.props);
});

/* ── shiftKF ── */
test("shiftKF: rebases, rounds to 4 decimals, drops outside [0, dur] ± 1 ms", () => {
  assert.equal(K.shiftKF(undefined, 1, 5), undefined);
  assert.equal(K.shiftKF(null, 1, 5), undefined);
  const kfs = {
    x: [{ t: 0, v: 0 }, { t: 1.00005, v: 1, ease: "ease-in" }, { t: 3, v: 2 }, { t: 6.0009, v: 3 }],
    y: [{ t: 0.5, v: 9 }],
  };
  const before = JSON.stringify(kfs);
  const out = K.shiftKF(kfs, 1, 5);
  assert.deepEqual(out, { x: [{ t: 0.0001, v: 1, ease: "ease-in" }, { t: 2, v: 2 }, { t: 5.0009, v: 3 }] },
    "y lost its only key (t −0.5) and the channel went with it");
  assert.equal(JSON.stringify(kfs), before, "input not mutated");
  assert.notEqual(out.x[0], kfs.x[1], "keyframes are copies");
  assert.deepEqual(K.shiftKF({ x: [{ t: 0.9995, v: 1 }] }, 1, 5), { x: [{ t: -0.0005, v: 1 }] }, "−0.5 ms is inside the tolerance");
  assert.deepEqual(K.shiftKF({ x: [{ t: 0, v: 0 }, { t: 5, v: 1 }] }, 0, 2), { x: [{ t: 0, v: 0 }] }, "trim right drops the tail");
  assert.equal(K.shiftKF({ x: [{ t: 9, v: 1 }] }, 0, 2), undefined, "nothing left → undefined, not {}");
  assert.equal(K.shiftKF({}, 0, 2), undefined);
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
  // A final grid cell shorter than 1/120 s is read as if it were a full step,
  // so the end of such a clip comes up short by up to one step of speed. Existing
  // behavior (the validator's MEDIA_OVERRUN verdict matches it) — pinned, not endorsed.
  const tiny = { id: "t", start: 0, in: 0, duration: 0.005, props: {}, keyframes: { speed: [{ t: 0, v: 2 }] } };
  near(K.mediaTimeAt(tiny, 0.005), 0.006, 1e-6, "exact ∫ would be 0.01");
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
  assert.deepEqual(Object.keys(K).sort(), [
    "clearSpeedCache", "clipEnd", "clipSpeed", "hasSpeedRamp", "kfAtPlayhead", "kfChannel", "kfTimeEps",
    "mediaTimeAt", "playheadOverClip", "propsAtPlayhead", "resetPropAtPlayhead", "resetPropChannel",
    "setAnimProp", "shiftKF", "toggleKfAtPlayhead",
  ]);
});

/* Known bug (fix in Phase 3): the ease lookup is a plain property read on
   EASE, so an ease named after an Object.prototype member resolves to it —
   "__proto__" is not a function and throws inside the render loop. The
   validator already reports such an ease as an error; the curve itself should
   still fall back to linear like any other unknown ease. */
test("BUG-18: given an ease named like an Object.prototype member, when evaluated, then it falls back to linear",
  { todo: "BUG-18 EASE lookup is not own-property safe (\"__proto__\" throws)" }, () => {
    const c = keyed();
    c.keyframes.scale[1].ease = "__proto__";
    assert.equal(K.kfChannel(c, "scale", 3, 0), 2);
  });
