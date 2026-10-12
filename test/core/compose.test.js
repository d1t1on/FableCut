/* core/compose.js — what the compositor draws for a clip at time t: static
   props → keyframe curves → filter preset → in/out transition envelopes, on
   an explicit W×H canvas. test/keyframes.test.js cross-checks transOffsetAt
   against evalProps through app.js's wrappers; this pins the pure pieces. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const C = require("../../core/compose");
const { DEFAULT_PROPS, EASE, FILTER_PRESETS, TRANSITIONS } = require("../../core/schema");

const W = 1000, H = 500;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b}`);
/* Clip on [10, 14]. */
const clip = (over = {}) => ({ id: "c", start: 10, duration: 4, in: 0, props: { ...DEFAULT_PROPS }, ...over });
/* The props applyTransition reads, all non-default so every term shows. */
const base = () => ({ x: 10, y: -20, scale: 2, opacity: 0.8, volume: 0.5, rotation: 30, blur: 1, rgbSplit: 2 });

/* ── evalProps ── */
test("evalProps: a fresh copy of the static props when nothing animates", () => {
  const c = clip();
  c.props.x = 42;
  const p = C.evalProps(c, 11, W, H);
  assert.notEqual(p, c.props);
  assert.deepEqual(p, c.props);
  assert.equal(C.evalProps(c, 11, W, H).x, 42);
});

test("evalProps: every keyframed channel overrides its static value", () => {
  const c = clip({ keyframes: {
    scale: [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }],
    x: [{ t: 1, v: 100 }],
    fit: [{ t: 0, v: 7 }],              // not animatable — evalProps still applies every channel present
    opacity: [{ t: 0, v: NaN }],        // non-number result → static kept
    rotation: [{ t: 0, v: "12" }],      // strings too
    y: [],                              // empty channel → static kept
  } });
  c.props.y = -5;
  const p = C.evalProps(c, 11, W, H);   // local 1
  assert.equal(p.scale, 2);
  assert.equal(p.x, 100);
  assert.equal(p.fit, 7);
  assert.equal(p.opacity, 1);
  assert.equal(p.rotation, 0);
  assert.equal(p.y, -5);
  assert.equal(C.evalProps(c, 99, W, H).scale, 3, "holds after the last key");
  assert.equal(C.evalProps(c, NaN, W, H).scale, 1, "NaN time: no segment, static value");
  assert.equal(c.props.scale, 1, "the clip is untouched");
});

test("evalProps: keyframes → preset → transition, in that order", () => {
  const c = clip({
    props: { ...DEFAULT_PROPS, filterPreset: "noir", brightness: 80 },
    keyframes: { brightness: [{ t: 0, v: 50 }] },
  });
  // the preset multiplies the KEYFRAMED value (50), not the static 80
  assert.equal(C.evalProps(c, 12, W, H).brightness, 50 * FILTER_PRESETS.noir.brightness / 100);
  // blur: keyframe 2 → dreamy +0.6 → blur transition + k·24 (in window, local 0.5 of 1 s)
  const d = clip({
    props: { ...DEFAULT_PROPS, filterPreset: "dreamy" },
    keyframes: { blur: [{ t: 0, v: 2 }] },
    transitionIn: { type: "blur", duration: 1 },
  });
  const k = 1 - EASE["ease-out"](0.5);
  near(C.evalProps(d, 10.5, W, H).blur, 2 + FILTER_PRESETS.dreamy.blur + k * 24, 1e-12);
});

test("evalProps: in window [0, dur), out window (D − dur, D], empty/negative durations ignored", () => {
  const fadeIn = clip({ transitionIn: { type: "fade", duration: 1 } });
  near(C.evalProps(fadeIn, 10, W, H).opacity, 0, 1e-12, "fully transparent at the head");
  near(C.evalProps(fadeIn, 10.5, W, H).opacity, EASE["ease-out"](0.5), 1e-12);
  assert.equal(C.evalProps(fadeIn, 11, W, H).opacity, 1, "window ends at dur");
  const fadeOut = clip({ transitionOut: { type: "fade", duration: 1 } });
  assert.equal(C.evalProps(fadeOut, 13, W, H).opacity, 1, "window starts after D − dur");
  near(C.evalProps(fadeOut, 13.5, W, H).opacity, 1 - EASE["ease-in"](0.5), 1e-12);
  near(C.evalProps(fadeOut, 14, W, H).opacity, 0, 1e-12, "gone at the tail");
  for (const duration of [0, -1, undefined])
    assert.equal(C.evalProps(clip({ transitionIn: { type: "fade", duration } }), 10.2, W, H).opacity, 1, String(duration));
  // both envelopes on a clip shorter than their sum stack
  const both = clip({ duration: 1, transitionIn: { type: "fade", duration: 1 }, transitionOut: { type: "fade", duration: 1 } });
  near(C.evalProps(both, 10.5, W, H).opacity, EASE["ease-out"](0.5) * (1 - EASE["ease-in"](0.5)), 1e-12);
});

/* ── applyFilterPreset ── */
test("applyFilterPreset: % props scale, 0–100 props clamp-add, the rest add", () => {
  for (const [name, fp] of Object.entries(FILTER_PRESETS)) {
    const p = { ...DEFAULT_PROPS, filterPreset: name, grayscale: 90 };
    C.applyFilterPreset(p);
    for (const [k, v] of Object.entries(fp)) {
      const was = k === "grayscale" ? 90 : DEFAULT_PROPS[k];
      const want = ["brightness", "contrast", "saturation"].includes(k) ? was * v / 100
        : ["grayscale", "sepia", "vignette", "invert"].includes(k) ? Math.min(100, Math.max(0, was + v))
          : was + v;
      assert.equal(p[k], want, `${name}.${k}`);
    }
  }
  const junk = { filterPreset: "noir", brightness: "x", grayscale: undefined };
  C.applyFilterPreset(junk);
  assert.equal(junk.brightness, FILTER_PRESETS.noir.brightness, "non-numeric % prop counts as 100");
  assert.equal(junk.grayscale, 100, "non-numeric additive prop counts as 0");
  for (const filterPreset of ["none", "bogus", undefined]) {
    const p = { filterPreset, brightness: 70 };
    C.applyFilterPreset(p);
    assert.deepEqual(p, { filterPreset, brightness: 70 }, String(filterPreset));
  }
});

/* ── applyTransition ── */
test("applyTransition: k ≤ 0 (or NaN) and unknown types are no-ops", () => {
  for (const type of TRANSITIONS)
    for (const k of [0, -0.5, NaN]) {
      const p = base();
      C.applyTransition(p, type, k, W, H, 1);
      assert.deepEqual(p, base(), `${type} @ ${k}`);
    }
  const p = base();
  C.applyTransition(p, "bogus", 0.5, W, H, 1);
  assert.deepEqual(p, base());
});

test("applyTransition: each type at k = 0.5, both directions", () => {
  const k = 0.5;
  const run = (type, dir, p = base()) => { C.applyTransition(p, type, k, W, H, dir); return p; };
  const b = base();
  for (const dir of [-1, 1]) {
    assert.deepEqual(run("fade", dir), { ...b, opacity: 0.4, volume: 0.25 });
    assert.deepEqual(run("dissolve", dir), run("fade", dir), "legacy alias");
    assert.equal(run("slide-left", dir).x, 10 - dir * k * W);
    assert.equal(run("slide-right", dir).x, 10 + dir * k * W);
    assert.equal(run("slide-up", dir).y, -20 - dir * k * H);
    assert.equal(run("slide-down", dir).y, -20 + dir * k * H);
    assert.deepEqual(run("zoom", dir), { ...b, scale: 2 * 0.7, opacity: 0.4 });
    assert.deepEqual(run("spin", dir), { ...b, rotation: 30 + dir * 100, scale: 2 * 0.8, opacity: 0.4 });
    assert.deepEqual(run("blur", dir), { ...b, blur: 13, opacity: 0.8 * 0.75, volume: 0.25 });
    assert.deepEqual(run("whip", dir), { ...b, x: 10 - dir * EASE["ease-in"](k) * W * 1.4, blur: 9 });
    const j = Math.sin(k * 61.7) * Math.sin(k * 23.3);
    assert.deepEqual(run("glitch", dir), { ...b, rgbSplit: 9, x: 10 + j * k * W * 0.06, opacity: 0.8 * 0.75 });
    assert.deepEqual(run("pop", dir), { ...b, scale: 2 * C.backOut(0.5), opacity: 0.8 });
  }
  assert.deepEqual(run("wipe", 1), { ...b, _wipe: k, _wipeDir: "left" });
  assert.deepEqual(run("wipe-left", 1), run("wipe", 1), "legacy alias");
  assert.deepEqual(run("wipe-right", -1), { ...b, _wipe: k, _wipeDir: "right" });
  assert.deepEqual(run("wipe-up", 1), { ...b, _wipe: k, _wipeDir: "up" });
  assert.deepEqual(run("wipe-down", 1), { ...b, _wipe: k, _wipeDir: "down" });
  assert.deepEqual(run("iris", 1), { ...b, _iris: k });
  // missing geometry falls back to identity values
  const bare = { opacity: 1, volume: 1 };
  C.applyTransition(bare, "spin", 1, W, H, 1);
  assert.deepEqual(bare, { opacity: 0, volume: 1, rotation: 200, scale: 0.6 });
  const zoom = { opacity: 1 };
  C.applyTransition(zoom, "zoom", 0.5, W, H, 1);
  assert.deepEqual(zoom, { opacity: 0.5, scale: 0.7 });
  const pop = { opacity: 1 };
  C.applyTransition(pop, "pop", 1, W, H, -1);
  assert.equal(pop.scale, 0.001, "pop never collapses to 0");
  assert.equal(pop.opacity, 0);
});

test("backOut: 0 → 0, 1 → 1, overshoots in between", () => {
  near(C.backOut(0), 0, 1e-12);
  assert.equal(C.backOut(1), 1);
  let peak = 0;
  for (let u = 0; u <= 1; u += 0.01) peak = Math.max(peak, C.backOut(u));
  assert.ok(peak > 1.09 && peak < 1.11, `peak ${peak}`);
});

/* ── transOffsetAt ── */
test("transOffsetAt: the x/y the envelopes add, zero outside their windows", () => {
  const c = clip({ transitionIn: { type: "slide-left", duration: 1 }, transitionOut: { type: "slide-down", duration: 1 } });
  assert.deepEqual(C.transOffsetAt(c, 12, W, H), { x: 0, y: 0 });
  const kIn = 1 - EASE["ease-out"](0.5);
  assert.deepEqual(C.transOffsetAt(c, 10.5, W, H), { x: kIn * W, y: 0 }, "in: dir −1, so slide-left starts right");
  const kOut = EASE["ease-in"](0.5);
  assert.deepEqual(C.transOffsetAt(c, 13.5, W, H), { x: 0, y: kOut * H });
  assert.deepEqual(C.transOffsetAt(c, 10.5, 2 * W, H), { x: 2 * kIn * W, y: 0 }, "scales with the canvas");
  assert.deepEqual(C.transOffsetAt(clip({ transitionIn: { type: "fade", duration: 1 } }), 10.5, W, H), { x: 0, y: 0 });
});

test("transOffsetAt: equals evalProps' x/y delta for every type, both sides", () => {
  const still = clip({ props: { ...DEFAULT_PROPS, x: 37, y: -12, scale: 1.6 }, keyframes: { x: [{ t: 0, v: 100 }, { t: 4, v: -100 }] } });
  for (const type of TRANSITIONS) {
    for (const side of ["transitionIn", "transitionOut"]) {
      const c = { ...still, [side]: { type, duration: 0.8 } };
      for (const f of [0.1, 0.5, 0.9]) {
        const t = side === "transitionIn" ? 10 + f * 0.8 : 14 - f * 0.8;
        const env = C.transOffsetAt(c, t, W, H);
        near(C.evalProps(c, t, W, H).x - C.evalProps(still, t, W, H).x, env.x, 1e-9, `${type} ${side} x`);
        near(C.evalProps(c, t, W, H).y - C.evalProps(still, t, W, H).y, env.y, 1e-9, `${type} ${side} y`);
      }
    }
  }
});

test("module surface is frozen", () => {
  assert.ok(Object.isFrozen(C));
  assert.deepEqual(Object.keys(C).sort(), ["applyFilterPreset", "applyTransition", "backOut", "evalProps", "transOffsetAt"]);
});
