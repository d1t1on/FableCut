/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — keyframe curves, speed-ramp time remapping and the pure
   cores of the keyframe mutators.

   Dual-mode classic script like core/schema.js, and loaded after it: a
   <script> tag exposes FableCore.keyframes, Node require()s it. Pure — no DOM,
   no app state: the playhead time and the project fps come in as arguments.
   app.js keeps its old names and signatures as thin wrappers that pass
   state.time / projectFps() and own the UI side effects.

   Keyframe times are seconds RELATIVE TO CLIP START; `ease` sits on the
   destination keyframe of each segment (unknown name → linear). A key may
   lie outside [0, duration]: an anchor that shapes the curve at that edge
   (docs/specs/0001, D4 — see "Anchors" below).

   Speed ramps: `speed` is keyframable, so media time = in + ∫ speed(t) dt over
   the clip. The integral is sampled once per unique speed curve on a 1/120 s
   trapezoid grid (Float64Array; the last step ends at the clip end) and
   cached per clip id. The cache is private; clearSpeedCache() empties it
   (tests), clearSpeedCache(id) drops one entry (callers that probe with a
   throwaway id).

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
  /* The curve of an ease name. An own property only (BUG-18): "__proto__" or
     "constructor" would otherwise run an Object.prototype member as the curve.
     No name → ease-in-out; an unknown one → linear. */
  const easeOf = (name) => { const n = name || "ease-in-out"; return Object.hasOwn(EASE, n) ? EASE[n] : EASE.linear; };
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
        return a.v + (b.v - a.v) * easeOf(b.ease)(u);
      }
    }
    return fallback;
  }
  /* ── Anchors (docs/specs/0001, D4) ──
     A key may sit outside [0, duration]: it still shapes the curve at the
     clip's edge. Splits and trims keep one such ANCHOR per side per channel —
     the nearest original key outside the new piece — so the segment the cut
     goes through keeps interpolating exactly, for every ease and for speed
     ramps (mediaTimeAt integrates the interpolated curve). Anchors are never
     drawn, navigated or toggled: the UI and the playhead helpers see only the
     keys on the clip. */
  const KF_EPS = 1e-3; // a key this close outside an edge still counts as on it
  const onClip = (kf, dur) => kf.t >= -KF_EPS && kf.t <= dur + KF_EPS;
  /* The keys of channel k on the clip (anchors left out), in order. */
  function keysOnClip(c, k) {
    const arr = c.keyframes?.[k];
    return Array.isArray(arr) ? arr.filter((kf) => onClip(kf, c.duration)) : [];
  }
  /* Re-base clip-local keyframe times by −offset onto a clip of length dur
     (a split piece, a trimmed clip). The keys on [0, dur] ± KF_EPS stay, plus
     the nearest key before 0 and the nearest after dur (the anchors); keys
     beyond them are dropped. Times are rounded to 0.1 ms; the keys are
     copies, sorted. */
  function shiftKF(kfs, offset, dur) {
    if (!kfs) return undefined;
    const out = {};
    for (const [k, arr] of Object.entries(kfs)) {
      const a = arr.map((kf) => ({ ...kf, t: +(kf.t - offset).toFixed(4) })).sort((x, y) => x.t - y.t);
      let lo = 0, hi = a.length;
      while (lo < a.length && a[lo].t < -KF_EPS) lo++; // a[lo - 1]: the anchor before 0
      while (hi > lo && a[hi - 1].t > dur + KF_EPS) hi--; // a[hi]: the anchor after dur
      const keep = a.slice(Math.max(0, lo - 1), hi + 1);
      if (keep.length) out[k] = keep;
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
  /* Keyframe on this channel whose absolute time matches `time` — a key on
     the clip: an anchor is never "at the playhead" (D4). */
  function kfAtPlayhead(c, k, time, fps) {
    const eps = kfTimeEps(fps);
    return keysOnClip(c, k).find((kf) => Math.abs(c.start + kf.t - time) < eps) || null;
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
  const STEP = 1 / 120; // integral grid (s)
  const speedIntCache = new Map(); // clipId -> {key, cum: Float64Array}
  function hasSpeedRamp(c) {
    return Array.isArray(c.keyframes?.speed) && c.keyframes.speed.length > 0;
  }
  const speedAt = (c, lt, base) => clamp(kfChannel(c, "speed", lt, base), SPEED_MIN, SPEED_MAX);
  /* ∫ speed over [0, dur] on the grid: cum[i] at i·STEP, the last entry at
     dur itself (a partial step), trapezoid per step. */
  function speedTable(c, dur, base) {
    const n = Math.max(2, Math.ceil(dur / STEP) + 1);
    const cum = new Float64Array(n);
    let prev = speedAt(c, 0, base);
    for (let i = 1; i < n; i++) {
      const lt = Math.min(dur, i * STEP);
      const cur = speedAt(c, lt, base);
      cum[i] = cum[i - 1] + ((prev + cur) / 2) * (lt - (i - 1) * STEP);
      prev = cur;
    }
    return cum;
  }
  /* Source-media time shown at timeline time t (clamped to the clip). */
  function mediaTimeAt(c, t) {
    const base = clipSpeed(c);
    const local = clamp(t - c.start, 0, c.duration);
    if (!hasSpeedRamp(c)) return c.in + local * base;
    const key = JSON.stringify(c.keyframes.speed) + "|" + c.duration.toFixed(4) + "|" + base;
    let e = speedIntCache.get(c.id);
    if (!e || e.key !== key) {
      e = { key, cum: speedTable(c, c.duration, base) };
      speedIntCache.set(c.id, e);
    }
    const cum = e.cum;
    // step [i0, i0 + 1] holds local; the last one ends at the clip end, so it
    // is interpolated over its real length, not a full STEP (BUG-26)
    const i0 = Math.min(Math.floor(local / STEP), cum.length - 2);
    const a = i0 * STEP, b = Math.min(c.duration, (i0 + 1) * STEP);
    const u = b > a ? clamp((local - a) / (b - a), 0, 1) : 1;
    return c.in + cum[i0] + (cum[i0 + 1] - cum[i0]) * u;
  }
  /* The longest clip duration whose source window stays inside media time
     `end`: from c.in along c's speed curve, its last key held past the end —
     what a right-edge extension plays. Solved on mediaTimeAt's own grid, so a
     clip of that duration (same keys) has mediaTimeAt(end of clip) ≈ `end`
     within float noise. A ramp costs one integral up to its last key, not
     cached (a drag calls this once). ≤ 0 when c.in is already past `end`. */
  function durationUntil(c, end) {
    const base = clipSpeed(c);
    const need = end - c.in;
    if (!hasSpeedRamp(c)) return need / base;
    if (!(need > 0)) return 0;
    const kfs = c.keyframes.speed;
    // the first grid point after the last key — or after need / SPEED_MIN,
    // where the source has run out whatever the curve (a stray far key)
    const k = Math.ceil(Math.min(Math.max(0, kfs[kfs.length - 1].t), need / SPEED_MIN) / STEP);
    const cum = speedTable(c, k * STEP, base);
    const top = cum[cum.length - 1];
    // past the last key the speed is constant: every grid step there is exact
    if (top <= need) return k * STEP + (need - top) / speedAt(c, k * STEP, base);
    let i0 = 0, hi = cum.length - 1; // largest i with cum[i] ≤ need (cum rises: speed ≥ SPEED_MIN)
    while (hi - i0 > 1) { const m = (i0 + hi) >> 1; if (cum[m] <= need) i0 = m; else hi = m; }
    // a clip ending inside step i0 integrates [i0·STEP, D] as one trapezoid
    const a = i0 * STEP, sa = speedAt(c, a, base);
    const at = (D) => cum[i0] + ((sa + speedAt(c, D, base)) / 2) * (D - a);
    let lo = a, up = Math.min((i0 + 1) * STEP, k * STEP);
    for (let n = 0; n < 48 && up - lo > 1e-12; n++) { const m = (lo + up) / 2; if (at(m) <= need) lo = m; else up = m; }
    return lo;
  }
  /* What extending c's head plays: the speed curve BEFORE clip-local 0 — an
     anchor's segment (D4), then the first key's value held. Built once per
     gesture on mediaTimeAt's grid, walking back from 0:
       back(e)     ∫ speed over [−e, 0], e ≥ 0 — the source a head extension
                   of e seconds uncovers (new in = in − back(e))
       reach(need) the e where back(e) = need — how far the head can go
                   before in reaches 0 (need = in)
     Without a key before 0 the curve there is constant: back(e) = e × the
     speed at 0, exactly. */
  function headRamp(c) {
    const base = clipSpeed(c);
    const kfs = hasSpeedRamp(c) ? c.keyframes.speed : null;
    const span = kfs ? Math.max(0, -kfs[0].t) : 0; // the curve varies on [first key, 0]
    const n = Math.max(2, Math.ceil(span / STEP) + 1);
    const cum = new Float64Array(n); // cum[i] = ∫ over [−i·STEP, 0]; the last entry at span
    let prev = speedAt(c, 0, base);
    for (let i = 1; i < n; i++) {
      const e = Math.min(span, i * STEP);
      const cur = speedAt(c, -e, base);
      cum[i] = cum[i - 1] + ((prev + cur) / 2) * (e - (i - 1) * STEP);
      prev = cur;
    }
    const top = cum[n - 1], held = speedAt(c, -span, base); // before the first key: its value
    const back = (e) => {
      if (e >= span) return top + (e - span) * held;
      const i0 = Math.min(Math.floor(e / STEP), n - 2);
      const a = i0 * STEP, b = Math.min(span, (i0 + 1) * STEP);
      return cum[i0] + (cum[i0 + 1] - cum[i0]) * (b > a ? clamp((e - a) / (b - a), 0, 1) : 1);
    };
    const reach = (need) => {
      if (!(need > 0)) return 0;
      if (need >= top) return span + (need - top) / held;
      let i0 = 0, hi = n - 1; // largest i with cum[i] ≤ need (cum rises: speed ≥ SPEED_MIN)
      while (hi - i0 > 1) { const m = (i0 + hi) >> 1; if (cum[m] <= need) i0 = m; else hi = m; }
      const a = i0 * STEP, b = Math.min(span, (i0 + 1) * STEP);
      return a + (b - a) * ((need - cum[i0]) / (cum[i0 + 1] - cum[i0])); // back() is linear inside a step
    };
    return { back, reach };
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
    const dup = keysOnClip(c, k).find((kf) => Math.abs(kf.t - lt) < eps); // never an anchor
    if (dup) { dup.v = v; return VALUE; }
    arr.push({ t: lt, v });
    arr.sort((a, b) => a.t - b.t);
    return KEYED;
  }
  /* ◆ : add a keyframe at the playhead, or remove the one already there.
     Refused when the playhead is off the clip — there is no "at the playhead"
     then, and clamping would plant a keyframe on the clip's edge. Removing
     the last key on the clip drops the channel, anchors included: a curve
     nobody can see or reach would be left otherwise. */
  function toggleKfAtPlayhead(c, k, { time, fps } = {}) {
    if (!c || !ANIMATABLE.includes(k) || !playheadOverClip(c, time, fps)) return REFUSED;
    const near = kfAtPlayhead(c, k, time, fps);
    if (near) {
      const rest = c.keyframes[k].filter((kf) => kf !== near);
      if (rest.some((kf) => onClip(kf, c.duration))) c.keyframes[k] = rest;
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
    const dup = keysOnClip(c, k).find((kf) => Math.abs(kf.t - lt) < eps);
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
    clipEnd, clipSpeed, kfChannel, shiftKF, KF_EPS, keysOnClip,
    kfTimeEps, playheadOverClip, kfAtPlayhead, propsAtPlayhead,
    hasSpeedRamp, mediaTimeAt, durationUntil, headRamp, clearSpeedCache,
    setAnimProp, toggleKfAtPlayhead, resetPropChannel, resetPropAtPlayhead,
  });
});
