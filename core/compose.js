/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — what the compositor draws for a clip at time t: static
   props, overridden by keyframe curves, merged with the filter preset, then
   shaped by the in/out transition envelopes.

   Dual-mode classic script, loaded after core/schema.js and core/keyframes.js:
   a <script> tag exposes FableCore.compose, Node require()s it. Pure — the
   canvas size (W, H) comes in as arguments; app.js keeps evalProps(c, t) and
   transOffsetAt(c, t) as wrappers that pass the preview canvas size.

   evalProps runs per clip per frame: W/H stay positional, and it allocates
   nothing beyond the props copy it returns.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports)
    module.exports = factory(require("./schema.js"), require("./keyframes.js"));
  else {
    const core = root.FableCore || {};
    if (!core.schema) throw new Error("core/schema.js must load before core/compose.js");
    if (!core.keyframes) throw new Error("core/keyframes.js must load before core/compose.js");
    root.FableCore.compose = factory(core.schema, core.keyframes);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (S, K) {
  "use strict";
  const { EASE, FILTER_PRESETS } = S;
  const { kfChannel } = K;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)); // app.js clamp (same NaN behavior)

  /* Effective properties of clip c at timeline time t, on a W×H canvas. */
  function evalProps(c, t, W, H) {
    // c.props is always fully populated with DEFAULT_PROPS's keys already (on
    // load and at every clip-creation site), so a plain shallow clone suffices —
    // merging DEFAULT_PROPS in again here would just double the copy work.
    const p = { ...c.props };
    const local = t - c.start;
    if (c.keyframes) {
      // every channel present, animatable or not; no fallback, so a channel
      // with no matching segment (NaN local) leaves the static value alone
      for (const k of Object.keys(c.keyframes)) {
        const v = kfChannel(c, k, local);
        if (typeof v === "number" && !isNaN(v)) p[k] = v;
      }
    }
    applyFilterPreset(p);
    applyEnvelopes(p, c, local, W, H);
    return p;
  }
  /* In/out transition envelopes at clip-local time `local` — the one copy both
     the compositor (evalProps) and the drag probe (transOffsetAt) run. */
  function applyEnvelopes(p, c, local, W, H) {
    const tin = c.transitionIn, tout = c.transitionOut;
    if (tin && tin.duration > 0 && local < tin.duration)
      applyTransition(p, tin.type, 1 - EASE["ease-out"](clamp(local / tin.duration, 0, 1)), W, H, -1);
    if (tout && tout.duration > 0 && local > c.duration - tout.duration)
      applyTransition(p, tout.type,
        EASE["ease-in"](clamp((local - (c.duration - tout.duration)) / tout.duration, 0, 1)), W, H, 1);
  }
  /* Merge a named look into evaluated props: % props scale, additive props add. */
  function applyFilterPreset(p) {
    const fp = FILTER_PRESETS[p.filterPreset];
    if (!fp || p.filterPreset === "none") return;
    for (const [k, v] of Object.entries(fp)) {
      if (k === "brightness" || k === "contrast" || k === "saturation")
        p[k] = (+p[k] || 100) * v / 100;
      else if (k === "grayscale" || k === "sepia" || k === "vignette" || k === "invert")
        p[k] = clamp((+p[k] || 0) + v, 0, 100);
      else p[k] = (+p[k] || 0) + v;   // hue, temperature, tint, blur
    }
  }
  /* Overshoot ease (u 0→1 lands on 1 after peaking ~1.1) — "pop" and text anims. */
  const backOut = (u) => { const c1 = 1.70158, c3 = c1 + 1; const v = u - 1; return 1 + c3 * v * v * v + c1 * v * v; };
  /* k: 0 = fully visible … 1 = fully transitioned away; dir: -1 = in, +1 = out */
  function applyTransition(p, type, k, W, H, dir) {
    if (!(k > 0)) return;
    switch (type) {
      case "fade": case "dissolve":
        p.opacity *= 1 - k; p.volume *= 1 - k; break;
      case "slide-left": p.x = (+p.x || 0) - dir * k * W; break;
      case "slide-right": p.x = (+p.x || 0) + dir * k * W; break;
      case "slide-up": p.y = (+p.y || 0) - dir * k * H; break;
      case "slide-down": p.y = (+p.y || 0) + dir * k * H; break;
      case "zoom":
        p.scale = (+p.scale || 1) * (1 - 0.6 * k); p.opacity *= 1 - k; break;
      case "wipe": case "wipe-left": p._wipe = k; p._wipeDir = "left"; break;
      case "wipe-right": p._wipe = k; p._wipeDir = "right"; break;
      case "wipe-up": p._wipe = k; p._wipeDir = "up"; break;
      case "wipe-down": p._wipe = k; p._wipeDir = "down"; break;
      case "iris": p._iris = k; break;
      case "spin":
        p.rotation = (+p.rotation || 0) + dir * k * 200;
        p.scale = (+p.scale || 1) * (1 - 0.4 * k);
        p.opacity *= 1 - k; break;
      case "blur":
        p.blur = (+p.blur || 0) + k * 24;
        p.opacity *= 1 - k * k; p.volume *= 1 - k; break;
      case "whip":
        p.x = (+p.x || 0) - dir * EASE["ease-in"](k) * W * 1.4;
        p.blur = (+p.blur || 0) + k * 16; break;
      case "glitch": { // RGB split + horizontal jitter, deterministic
        const j = Math.sin(k * 61.7) * Math.sin(k * 23.3);
        p.rgbSplit = (+p.rgbSplit || 0) + k * 14;
        p.x = (+p.x || 0) + j * k * W * 0.06;
        p.opacity *= 1 - k * k;
        break;
      }
      case "pop": // overshoot scale (backOut) — sticker/caption entrance
        p.scale = (+p.scale || 1) * Math.max(0.001, backOut(1 - k));
        p.opacity *= Math.min(1, (1 - k) * 2.5);
        break;
    }
  }
  /* Translation the in/out transition envelopes add on top of the keyframed
     props at timeline time t — probed through applyTransition itself, so it
     can never disagree with the compositor. Canvas box drags write resting
     (envelope-free) geometry, so displayed-space results must have this
     subtracted back out. */
  function transOffsetAt(c, t, W, H) {
    const p = { x: 0, y: 0, scale: 1, opacity: 1, volume: 1, rotation: 0, blur: 0, rgbSplit: 0 };
    applyEnvelopes(p, c, t - c.start, W, H);
    return { x: +p.x || 0, y: +p.y || 0 };
  }

  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  return deepFreeze({ evalProps, applyFilterPreset, applyTransition, transOffsetAt, backOut });
});
