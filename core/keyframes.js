/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — keyframe curves, speed-ramp time remapping and the pure
   cores of the keyframe mutators.

   Dual-mode classic script like core/schema.js, and loaded after it: a
   <script> tag exposes FableCore.keyframes, Node require()s it. Pure — no DOM,
   no app state: the playhead time and the project fps come in as arguments.
   app.js keeps its old names and signatures as thin wrappers that pass
   state.time / projectFps() and own the UI side effects.

   Keyframe times are seconds RELATIVE TO CLIP START; `ease` sits on the
   destination keyframe of each segment (unknown name → linear).

   Speed ramps: `speed` is keyframable, so media time = in + ∫ speed(t) dt over
   the clip. The integral is sampled once per unique speed curve on a 1/120 s
   trapezoid grid (Float32Array) and cached per clip id. The cache is private;
   clearSpeedCache() empties it (tests), clearSpeedCache(id) drops one entry
   (callers that probe with a throwaway id).

   Mutators (setAnimProp, toggleKfAtPlayhead, resetPropChannel,
   resetPropAtPlayhead) change the clip in place and return an effects record
   that tells the app which of its own side effects the old code ran:
     ok              the app function's boolean — false = refused, and then
                     nothing was changed and every flag below is off
     touched         a playhead-aware write landed: bump the inspector's prop
                     generation (these callers don't re-render the inspector)
     propChanged     a prop value or curve was written: re-cut audio hold (the
                     app only cares when the key is volume / pan / speed)
     timelineChanged a keyframe diamond, transition or clip label changed: the
                     timeline must redraw (value-only writes skip it)
     font            family to (re)load after a font reset, else null
   Records are frozen and shared between calls — read them, never mutate.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports) module.exports = factory(require("./schema.js"));
  else {
    const schema = root.FableCore && root.FableCore.schema;
    if (!schema) throw new Error("core/schema.js must load before core/keyframes.js");
    root.FableCore.keyframes = factory(schema);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (S) {
  "use strict";
  const { DEFAULT_PROPS, ANIMATABLE, EASE, SPEED_MIN, SPEED_MAX } = S;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)); // app.js clamp (same NaN behavior)

  /* ── Clip timing ── */
  const clipEnd = (c) => c.start + c.duration;
  const clipSpeed = (c) => clamp(+(c.props?.speed) || 1, SPEED_MIN, SPEED_MAX);

  /* ── Curves ── */
  /* Value of channel `key` at clip-local time `local`: holds before the first
     and after the last keyframe; `fallback` when the channel is absent (or no
     segment matches, e.g. local is NaN). */
  function kfChannel(c, key, local, fallback) {
    const kfs = c.keyframes?.[key];
    if (!Array.isArray(kfs) || !kfs.length) return fallback;
    if (local <= kfs[0].t) return kfs[0].v;
    if (local >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v;
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i], b = kfs[i + 1];
      if (local >= a.t && local <= b.t) {
        const u = (local - a.t) / Math.max(1e-6, b.t - a.t);
        const ez = EASE[b.ease || "ease-in-out"] || EASE.linear;
        return a.v + (b.v - a.v) * ez(u);
      }
    }
    return fallback;
  }
  /* Rebase clip-local keyframe times by -offset, dropping ones outside [0, dur] */
  function shiftKF(kfs, offset, dur) {
    if (!kfs) return undefined;
    const out = {};
    for (const [k, arr] of Object.entries(kfs)) {
      const a = arr.map((kf) => ({ ...kf, t: +(kf.t - offset).toFixed(4) }))
        .filter((kf) => kf.t >= -1e-3 && kf.t <= dur + 1e-3);
      if (a.length) out[k] = a;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /* ── The playhead ── */
  const kfTimeEps = (fps) => 0.5 / fps; // half a frame
  /* Is `time` over the clip (± half a frame)? Keyframe edits are only
     meaningful then — off-clip writes would land clamped on the clip's edge. */
  function playheadOverClip(c, time, fps) {
    const eps = kfTimeEps(fps);
    return time >= c.start - eps && time <= c.start + c.duration + eps;
  }
  /* Keyframe on this channel whose absolute time matches `time`. */
  function kfAtPlayhead(c, k, time, fps) {
    const arr = c.keyframes?.[k];
    if (!Array.isArray(arr) || !arr.length) return null;
    const eps = kfTimeEps(fps);
    return arr.find((kf) => Math.abs(c.start + kf.t - time) < eps) || null;
  }
  /* Static props with keyed channels replaced by their value at `time`
     (no transition envelopes — those would fake a keyframe in the inspector). */
  function propsAtPlayhead(c, time) {
    const p = { ...c.props };
    if (!c.keyframes) return p;
    const local = time - c.start;
    for (const k of ANIMATABLE) {
      const kfs = c.keyframes[k];
      if (!Array.isArray(kfs) || !kfs.length) continue;
      const v = kfChannel(c, k, local, +(p[k] ?? DEFAULT_PROPS[k] ?? 0));
      if (typeof v === "number" && !isNaN(v)) p[k] = v;
    }
    return p;
  }

  /* ── Speed ramps (time remapping) ── */
  const speedIntCache = new Map(); // clipId -> {key, cum: Float32Array, step}
  function hasSpeedRamp(c) {
    return Array.isArray(c.keyframes?.speed) && c.keyframes.speed.length > 0;
  }
  /* Source-media time shown at timeline time t (clamped to the clip). */
  function mediaTimeAt(c, t) {
    const base = clipSpeed(c);
    const local = clamp(t - c.start, 0, c.duration);
    if (!hasSpeedRamp(c)) return c.in + local * base;
    const key = JSON.stringify(c.keyframes.speed) + "|" + c.duration.toFixed(4) + "|" + base;
    let e = speedIntCache.get(c.id);
    if (!e || e.key !== key) {
      const step = 1 / 120;
      const n = Math.max(2, Math.ceil(c.duration / step) + 1);
      const cum = new Float32Array(n);
      let prev = clamp(kfChannel(c, "speed", 0, base), SPEED_MIN, SPEED_MAX);
      for (let i = 1; i < n; i++) {
        const lt = Math.min(c.duration, i * step);
        const cur = clamp(kfChannel(c, "speed", lt, base), SPEED_MIN, SPEED_MAX);
        cum[i] = cum[i - 1] + ((prev + cur) / 2) * (lt - (i - 1) * step);
        prev = cur;
      }
      e = { key, cum, step };
      speedIntCache.set(c.id, e);
    }
    const idx = Math.min(e.cum.length - 1, local / e.step);
    const i0 = Math.floor(idx), frac = idx - i0;
    const v = i0 >= e.cum.length - 1 ? e.cum[e.cum.length - 1]
      : e.cum[i0] + (e.cum[i0 + 1] - e.cum[i0]) * frac;
    return c.in + v;
  }
  /* No argument: forget every cached integral. With an id: just that clip's. */
  function clearSpeedCache(id) {
    if (arguments.length) speedIntCache.delete(id);
    else speedIntCache.clear();
  }

  /* ── Mutators ──
     `at` = { time, fps }: the playhead and the project frame rate. */
  const effects = (ok, touched, propChanged, timelineChanged, font = null) =>
    Object.freeze({ ok, touched, propChanged, timelineChanged, font });
  const REFUSED = effects(false, false, false, false);
  const VALUE = effects(true, true, true, false);  // value-only write: no marker moved
  const KEYED = effects(true, true, true, true);   // a keyframe appeared or disappeared
  const TRANS_CLEARED = effects(true, false, false, true);
  const fontFx = (k, v) => (k === "font" ? String(v) : null);

  /* Write an animatable prop: static if the channel has no keyframes;
     otherwise update the keyframe under the playhead or insert one (auto-key).
     Refused when the channel is keyed and the playhead is off the clip — the
     write would corrupt the edge keyframe. */
  function setAnimProp(c, k, v, { time, fps } = {}) {
    if (!c || !ANIMATABLE.includes(k) || typeof v !== "number" || isNaN(v)) return REFUSED;
    const arr = c.keyframes?.[k];
    const keyed = Array.isArray(arr) && arr.length;
    if (keyed && !playheadOverClip(c, time, fps)) return REFUSED;
    if (!keyed) { c.props[k] = v; return VALUE; }
    const near = kfAtPlayhead(c, k, time, fps);
    if (near) { near.v = v; return VALUE; }
    const lt = +clamp(time - c.start, 0, c.duration).toFixed(3);
    const eps = kfTimeEps(fps);
    const dup = arr.find((kf) => Math.abs(kf.t - lt) < eps);
    if (dup) { dup.v = v; return VALUE; }
    arr.push({ t: lt, v });
    arr.sort((a, b) => a.t - b.t);
    return KEYED;
  }
  /* ◆ : add a keyframe at the playhead, or remove the one already there.
     Refused when the playhead is off the clip — there is no "at the playhead"
     then, and clamping would plant a keyframe on the clip's edge. */
  function toggleKfAtPlayhead(c, k, { time, fps } = {}) {
    if (!c || !ANIMATABLE.includes(k) || !playheadOverClip(c, time, fps)) return REFUSED;
    const near = kfAtPlayhead(c, k, time, fps);
    if (near) {
      const rest = c.keyframes[k].filter((kf) => kf !== near);
      if (rest.length) c.keyframes[k] = rest;
      else { // the last one: its value survives as the static prop
        c.props[k] = near.v;
        delete c.keyframes[k];
        if (!Object.keys(c.keyframes).length) c.keyframes = undefined;
      }
      return KEYED;
    }
    const fallback = +(c.props?.[k] ?? DEFAULT_PROPS[k] ?? 0);
    const v = kfChannel(c, k, time - c.start, fallback);
    if (typeof v !== "number" || isNaN(v)) return REFUSED;
    if (!c.keyframes) c.keyframes = {};
    const arr = (c.keyframes[k] = c.keyframes[k] || []);
    const lt = +clamp(time - c.start, 0, c.duration).toFixed(3);
    const eps = kfTimeEps(fps);
    const dup = arr.find((kf) => Math.abs(kf.t - lt) < eps);
    if (dup) { dup.v = v; return VALUE; }
    arr.push({ t: lt, v });
    arr.sort((a, b) => a.t - b.t);
    return KEYED;
  }
  /* Wipe a property: factory default + delete that channel's keyframes.
     "transIn" / "transOut" clear the clip's transition instead. */
  function resetPropChannel(c, k) {
    if (!c || !k) return REFUSED;
    if (k === "transIn" || k === "transOut") {
      c[k === "transIn" ? "transitionIn" : "transitionOut"] = undefined;
      return TRANS_CLEARED;
    }
    if (!Object.hasOwn(DEFAULT_PROPS, k)) return REFUSED;
    c.props[k] = DEFAULT_PROPS[k];
    let timeline = k === "text" || k === "font"; // the clip's timeline label
    if (c.keyframes?.[k]) {
      delete c.keyframes[k];
      if (!Object.keys(c.keyframes).length) c.keyframes = undefined;
      timeline = true;
    }
    return effects(true, false, true, timeline, fontFx(k, DEFAULT_PROPS[k]));
  }
  /* Playhead-local reset: remove the keyframe under the playhead, else set the
     value at the playhead to the property default (auto-keys if already
     keyed). Refused on a keyed channel with the playhead off the clip. */
  function resetPropAtPlayhead(c, k, at = {}) {
    if (!c || !k) return REFUSED;
    if (k === "transIn" || k === "transOut") return resetPropChannel(c, k);
    if (!Object.hasOwn(DEFAULT_PROPS, k)) return REFUSED;
    const anim = ANIMATABLE.includes(k);
    if (anim && kfAtPlayhead(c, k, at.time, at.fps)) return toggleKfAtPlayhead(c, k, at);
    const def = DEFAULT_PROPS[k];
    // animatable → never "text"/"font", so setAnimProp's record is the whole story
    if (anim && c.keyframes?.[k]?.length) return setAnimProp(c, k, def, at);
    c.props[k] = def;
    return effects(true, false, true, k === "text" || k === "font", fontFx(k, def));
  }

  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  return deepFreeze({
    clipEnd, clipSpeed, kfChannel, shiftKF,
    kfTimeEps, playheadOverClip, kfAtPlayhead, propsAtPlayhead,
    hasSpeedRamp, mediaTimeAt, clearSpeedCache,
    setAnimProp, toggleKfAtPlayhead, resetPropChannel, resetPropAtPlayhead,
  });
});
