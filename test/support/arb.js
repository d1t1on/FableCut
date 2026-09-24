/* fast-check generators of VALID FableCut projects.

   A project is generated as a small SPEC of primitives (fractions, ms
   integers, enum picks) and then built into a raw project.json — the shape an
   agent writes: sparse props, `in` present, linkGroups on disk. Building
   from a spec (map, never chain) keeps shrinking good: a counterexample
   shrinks to one or two clips with round numbers.

     arbProject(opts)  → raw project.json (load it with ops.createSession or
                         loadProject, exactly like the editor's applyProject)
     loadProject(raw)  → normalizeProject(raw).project (a deep copy of raw)

   What it covers (test/props/generators.test.js checks every shape shows up):
     fps ∈ {24, 25, 30, 50, 60}; canvases 16:9 / 9:16 / square; times on a 1 ms
     grid; default lanes (V3…V1, A1…A4) or custom (V1…V5, A1…A6, any order);
     a disabled-lane subset; optional IN/OUT, markers, folders, exportFrame,
     encodeProfile.
     Clips of every kind — video, audio, image, svg, text, adjust — and linked
     AV groups: a picture + k ∈ {1, 2, 6} stems on distinct A lanes sharing a
     linkGroup, start/in/duration, props.speed and keyframes.speed, with
     audioChannel 0…k-1 and the per-channel default pan.
     Timed kinds (video/audio/svg) may carry a static speed and/or a speed ramp
     (values 0.25–4, keys ≥ 0.5 s apart; ramps on clips of any length, up to
     12 s).
     Video/audio media are long enough for in + ∫speed dt (checked with
     core/keyframes mediaTimeAt), plus slack.
     Keyframes on a random subset of ANIMATABLE: sorted, unique t ∈ [0, dur],
     values inside the schema's min/max (else a sane range), every ease.
     Transitions of every type, each ≤ dur / 2.

   Every generated project and its normalized form validate with zero errors
   (the meta-test). If that ever fails, fix the generator, not the validator. */
"use strict";
const { fc } = require("./fc");
const S = require("../../core/schema");
const K = require("../../core/keyframes");
const { defaultPanForChannel } = require("../../core/links");
const { normalizeProject } = require("../../core/project");

const { ANIMATABLE, EASE, TRANSITIONS, TEXT_ANIMS, BLEND_MODES, FILTER_PRESETS, MIN_DUR, PROJECT_SCHEMA } = S;
const PROPS_SCHEMA = PROJECT_SCHEMA.$defs.props.properties;

const FPS = [24, 25, 30, 50, 60];
const CANVAS = [[1280, 720], [1920, 1080], [1080, 1920], [720, 720], [640, 360]];
const EASES = Object.keys(EASE);
const TRANSITION_TYPES = TRANSITIONS.filter((t) => t !== "none"); // "none" is a TRANSITION_ALIAS warning
const RAMP_GAP = 0.5; // min spacing of speed keys (s)
/* Ramped clips used to stay ≤ 6 s, for mediaTimeAt's float32 sum (~0.8 ms of
   drift over 12 s at 4×). It is Float64 since BUG-26, and the trapezoid error
   is per eased segment, not per second, so any clip length may carry a ramp. */

/* Value range per animatable prop: the schema's bounds, narrowed to something
   sane where the schema is open. A new animatable prop without either throws
   here, so the generator can't silently skip it. */
const SANE = {
  x: [-640, 640], y: [-360, 360], scale: [0.1, 3], rotation: [-180, 180],
  speed: [0.25, 4], brightness: [0, 200], contrast: [0, 200], saturation: [0, 200],
  hue: [-180, 180], blur: [0, 20], cornerRadius: [0, 80], shake: [0, 30],
  rgbSplit: [0, 20], fontSize: [8, 160], letterSpacing: [-4, 20],
};
function rangeOf(k) {
  const s = PROPS_SCHEMA[k] || {};
  const [lo0, hi0] = SANE[k] || [-Infinity, Infinity];
  const lo = Math.max(lo0, s.minimum ?? -Infinity, s.exclusiveMinimum != null ? s.exclusiveMinimum + 0.001 : -Infinity);
  const hi = Math.min(hi0, s.maximum ?? Infinity);
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi)) throw new Error(`arb.js: no value range for animatable prop "${k}" — add it to SANE`);
  return [lo, hi];
}
const RANGES = Object.fromEntries(ANIMATABLE.map((k) => [k, rangeOf(k)]));
const VISUAL_KEYS = ANIMATABLE.filter((k) => k !== "speed"); // speed ramps are generated on their own
const AUDIO_KEYS = ["volume", "pan"];

/* ── Primitives ── */
const ms = (s) => Math.round(s * 1000) / 1000;
const ceilMs = (s) => Math.ceil(s * 1000) / 1000;
const lerp = ([lo, hi], u) => ms(lo + (hi - lo) * u);
const pick = (list, u) => list[Math.min(list.length - 1, Math.floor(u * list.length))];

module.exports = fc ? build() : {};

function build() {
  const frac = fc.integer({ min: 0, max: 1000 }).map((i) => i / 1000);
  const secs = (lo, hi) => fc.integer({ min: Math.round(lo * 1000), max: Math.round(hi * 1000) }).map((i) => i / 1000);
  const opt = (arb, freq = 2) => fc.option(arb, { nil: undefined, freq });
  const ease = opt(fc.constantFrom(...EASES), 3);

  /* ── Spec arbitraries ── */
  const arbKey = fc.record({ u: frac, v: frac, ease });
  const arbChannel = (keys) => fc.record({ key: fc.constantFrom(...keys), keys: fc.array(arbKey, { minLength: 1, maxLength: 4 }) });
  const arbTransition = opt(fc.record({ type: fc.constantFrom(...TRANSITION_TYPES), u: frac }), 2);
  const arbLook = fc.record({
    opacity: frac, x: frac, y: frac, scale: frac, rotation: frac, cornerRadius: frac,
    filterPreset: fc.constantFrom(...Object.keys(FILTER_PRESETS)),
    blend: fc.constantFrom(...BLEND_MODES),
    shake: frac, grain: frac, rgbSplit: frac, vignette: frac,
  }, { requiredKeys: [] });
  const arbText = fc.record({
    text: fc.constantFrom("Title", "Hello world", "Two\nlines"),
    font: fc.constantFrom("Anton", "Bebas Neue", "Playfair Display", "Roboto"),
    textAnim: fc.constantFrom(...TEXT_ANIMS),
    fontCutSet: opt(fc.constant(["Anton", "Oswald"]), 2),
    styleName: opt(fc.constantFrom("impact", "neon", "subtitle"), 2),
  });
  const arbItem = fc.record({
    type: fc.constantFrom("group", "group", "video", "audio", "image", "svg", "text", "adjust"),
    lane: frac, stems: frac, stemLane: frac,
    start: secs(0, 20),
    dur: fc.oneof({ weight: 1, arbitrary: secs(MIN_DUR, 0.5) }, { weight: 4, arbitrary: secs(0.5, 12) }),
    inn: fc.oneof(fc.constant(0), secs(0, 8)),
    speed: opt(frac),
    ramp: opt(fc.array(fc.record({ u: frac, v: frac, ease }), { minLength: 1, maxLength: 4 })),
    channels: fc.array(arbChannel(VISUAL_KEYS), { maxLength: 3 }),
    stemChannels: fc.array(arbChannel(AUDIO_KEYS), { maxLength: 1 }),
    trIn: arbTransition, trOut: arbTransition,
    look: arbLook, text: arbText,
    volume: opt(frac),
    slack: fc.oneof(fc.constant(0), secs(0, 4)),
  });
  const arbLanes = fc.oneof(
    { weight: 1, arbitrary: fc.constant({ custom: false }) },
    {
      weight: 2, arbitrary: fc.record({
        custom: fc.constant(true),
        nV: fc.integer({ min: 1, max: 5 }),
        nA: fc.constantFrom(1, 2, 3, 4, 6, 6), // 6-stem groups need six A lanes
        order: fc.constantFrom("display", "reversed", "mixed"),
      }),
    },
  );
  const arbSpec = ({ minItems = 1, maxItems = 6 } = {}) => fc.record({
    name: fc.constantFrom("Prop", "Reel", "Cut 2"),
    fps: fc.constantFrom(...FPS),
    canvas: fc.integer({ min: 0, max: CANVAS.length - 1 }),
    revision: fc.integer({ min: 0, max: 50 }),
    lanes: arbLanes,
    items: fc.array(arbItem, { minLength: minItems, maxLength: maxItems }),
    disabled: fc.oneof(fc.constant([]), fc.array(frac, { minLength: 1, maxLength: 3 })),
    work: fc.record({ in: opt(frac, 4), out: opt(frac, 4) }),
    markers: fc.array(fc.record({ u: frac, label: opt(fc.constantFrom("drop", "beat")) }), { maxLength: 4 }),
    folders: fc.integer({ min: 0, max: 2 }),
    exportFrame: opt(frac),
    encodeProfile: opt(fc.constantFrom("draft", "hq")),
    background: opt(fc.constantFrom("#000000", "#101820")),
  });

  /* ── Spec → raw project ── */
  function lanesOf(l) {
    if (!l.custom) return { v: ["V1", "V2", "V3"], a: ["A1", "A2", "A3", "A4"], tracks: undefined };
    const v = Array.from({ length: l.nV }, (_, i) => "V" + (i + 1));
    const a = Array.from({ length: l.nA }, (_, i) => "A" + (i + 1));
    const vd = v.map((id) => ({ id, kind: "video" })), ad = a.map((id) => ({ id, kind: "audio" }));
    const tracks = l.order === "display" ? [...vd.slice().reverse(), ...ad]
      : l.order === "reversed" ? [...ad.slice().reverse(), ...vd] : [...vd, ...ad];
    return { v, a, tracks };
  }
  /* Sorted, unique keyframe times on the ms grid inside [0, dur]. */
  function channelKeys(ch, dur) {
    const seen = new Set();
    return ch.keys.map((k) => ({ t: ms(k.u * dur), v: lerp(RANGES[ch.key], k.v), ease: k.ease }))
      .filter((k) => !seen.has(k.t) && seen.add(k.t))
      .sort((a, b) => a.t - b.t)
      .map(({ t, v, ease }) => (ease ? { t, v, ease } : { t, v }));
  }
  /* Speed keys ≥ RAMP_GAP apart: key i sits in its own slot of width w ≥ 2·RAMP_GAP. */
  function rampKeys(ramp, dur) {
    const n = Math.max(1, Math.min(ramp.length, Math.floor(dur / (2 * RAMP_GAP))));
    const w = dur / n;
    return ramp.slice(0, n).map((k, i) => {
      const t = n === 1 ? ms(k.u * dur) : ms(i * w + k.u * (w / 2));
      const key = { t, v: lerp(RANGES.speed, k.v) };
      if (k.ease) key.ease = k.ease;
      return key;
    });
  }
  function keyframesOf(channels, dur, ramp) {
    const out = {};
    for (const ch of channels) if (!out[ch.key]) out[ch.key] = channelKeys(ch, dur);
    if (ramp) out.speed = ramp;
    return Object.keys(out).length ? out : undefined;
  }
  function transitionOf(tr, dur) {
    if (!tr) return undefined;
    return { type: tr.type, duration: Math.max(1, Math.floor(tr.u * dur * 500)) / 1000 }; // ≤ dur / 2
  }
  function lookOf(look) {
    const p = {};
    for (const k of ["opacity", "x", "y", "scale", "rotation", "cornerRadius"]) if (look[k] != null) p[k] = lerp(RANGES[k], look[k]);
    if (look.filterPreset) p.filterPreset = look.filterPreset;
    if (look.blend) p.blend = look.blend;
    return p;
  }
  /* Media seconds a timed clip consumes — the larger of the exact ∫speed dt
     and what the editor's mediaTimeAt computes, so the bound holds whichever
     one a check (or a later fix of mediaTimeAt) uses. */
  const PROBE = Symbol("arb");
  function consumed(dur, speed, ramp) {
    const probe = { id: PROBE, start: 0, in: 0, duration: dur, props: { speed: speed ?? 1 }, keyframes: ramp ? { speed: ramp } : undefined };
    try { return Math.max(K.mediaTimeAt(probe, dur), speedIntegral(probe, dur)); } finally { K.clearSpeedCache(PROBE); }
  }

  function buildProject(spec) {
    const [W, H] = CANVAS[spec.canvas];
    const lanes = lanesOf(spec.lanes);
    const media = [], clips = [];
    let nm = 0, nc = 0, ng = 0;
    const addMedia = (kind, extra) => {
      const id = "m" + nm++;
      const ext = { video: ".mp4", audio: ".mp3", image: ".png", svg: ".svg" }[kind];
      media.push({ id, name: id + ext, kind, src: "/media/" + id + ext, ...extra });
      return id;
    };
    const addClip = (fields) => { const c = { id: "c" + nc++, ...fields }; clips.push(c); return c; };

    for (const it of spec.items) {
      const dur = it.dur, start = it.start;
      const timed = it.type === "group" || it.type === "video" || it.type === "audio" || it.type === "svg";
      const speed = timed && it.speed != null ? lerp(RANGES.speed, it.speed) : undefined;
      const ramp = timed && it.ramp ? rampKeys(it.ramp, dur) : undefined;
      const inn = timed ? it.inn : 0;
      const base = { start, in: inn, duration: dur, name: it.type + " " + nc };
      const tr = { transitionIn: transitionOf(it.trIn, dur), transitionOut: transitionOf(it.trOut, dur) };
      const tidy = (c) => { for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k]; return c; };
      const avMedia = (kind) => addMedia(kind, { duration: ceilMs(inn + consumed(dur, speed, ramp)) + it.slack, ...(kind === "video" ? { width: 1920, height: 1080 } : {}) });

      if (it.type === "group") {
        const lg = "lg_g" + ng++;
        const mid = avMedia("video");
        const k = pick([1, 2, 6].filter((n) => n <= lanes.a.length), it.stems);
        addClip(tidy({ mediaId: mid, kind: "video", track: pick(lanes.v, it.lane), ...base,
          props: { ...lookOf(it.look), volume: 0, ...(speed != null ? { speed } : {}) },
          keyframes: keyframesOf(it.channels, dur, ramp), ...tr, linkGroup: lg }));
        const a0 = Math.floor(it.stemLane * lanes.a.length);
        for (let ch = 0; ch < k; ch++) {
          addClip(tidy({ mediaId: mid, kind: "audio", track: lanes.a[(a0 + ch) % lanes.a.length], ...base,
            props: { audioChannel: ch, pan: defaultPanForChannel(ch), ...(speed != null ? { speed } : {}) },
            keyframes: keyframesOf(ch === 0 ? it.stemChannels : [], dur, ramp && ramp.map((x) => ({ ...x }))),
            linkGroup: lg }));
        }
      } else if (it.type === "video" || it.type === "audio") {
        const mid = avMedia(it.type);
        const props = it.type === "video" ? lookOf(it.look) : {};
        if (it.volume != null) props.volume = lerp([0, 2], it.volume);
        if (speed != null) props.speed = speed;
        addClip(tidy({ mediaId: mid, kind: it.type, track: pick(it.type === "audio" ? lanes.a : lanes.v, it.lane), ...base,
          props, keyframes: keyframesOf(it.type === "audio" ? it.stemChannels : it.channels, dur, ramp), ...tr }));
      } else if (it.type === "image" || it.type === "svg") {
        const mid = addMedia(it.type, { width: 800, height: 450 });
        const props = lookOf(it.look);
        if (speed != null) props.speed = speed;
        addClip(tidy({ mediaId: mid, kind: it.type, track: pick(lanes.v, it.lane), ...base,
          props, keyframes: keyframesOf(it.channels, dur, ramp), ...tr }));
      } else if (it.type === "text") {
        const t = it.text;
        const props = { ...lookOf(it.look), text: t.text, font: t.font, textAnim: t.textAnim };
        if (t.fontCutSet) props.fontCutSet = t.fontCutSet.slice();
        addClip(tidy({ mediaId: null, kind: "text", track: pick(lanes.v, it.lane), ...base,
          props, keyframes: keyframesOf(it.channels, dur), ...tr, styleName: t.styleName }));
      } else { // adjust
        const l = it.look, props = {};
        for (const k of ["shake", "grain", "rgbSplit", "vignette"]) if (l[k] != null) props[k] = lerp(RANGES[k], l[k]);
        if (l.filterPreset) props.filterPreset = l.filterPreset;
        addClip(tidy({ mediaId: null, kind: "adjust", track: pick(lanes.v, it.lane), ...base,
          props, keyframes: keyframesOf(it.channels, dur), ...tr }));
      }
    }

    const end = clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0) || 10;
    const raw = { name: spec.name, width: W, height: H, fps: spec.fps, revision: spec.revision, panSchema: 1 };
    if (spec.background) raw.background = spec.background;
    if (spec.folders) {
      raw.folders = Array.from({ length: spec.folders }, (_, i) => ({ id: "f" + i, name: "Folder " + i, parentId: i ? "f0" : null, open: i === 0 }));
      media.forEach((m, i) => { if (i % 2 === 0) m.folderId = "f" + (i % spec.folders); });
    }
    if (lanes.tracks) raw.tracks = lanes.tracks;
    raw.media = media;
    raw.clips = clips;
    raw.markers = spec.markers.map((m) => ({ t: ms(m.u * end), ...(m.label ? { label: m.label } : {}) }))
      .sort((a, b) => a.t - b.t);
    const w = spec.work;
    const inPoint = w.in != null ? ms(w.in * end) : null;
    const outPoint = w.out != null ? ms((inPoint ?? 0) + Math.max(0.1, w.out * (end + 1 - (inPoint ?? 0)))) : null;
    if (inPoint != null) raw.inPoint = inPoint;
    if (outPoint != null) raw.outPoint = outPoint;
    const allLanes = [...lanes.v, ...lanes.a];
    const off = [...new Set(spec.disabled.map((u) => pick(allLanes, u)))].sort();
    if (off.length) raw.disabledTracks = off;
    if (spec.exportFrame != null) {
      const fw = Math.max(8, Math.floor(W * 0.28) * 2), fh = Math.max(8, Math.floor(H * 0.375) * 2);
      raw.exportFrame = { x: Math.round((W - fw) * spec.exportFrame), y: 0, w: fw, h: fh };
    }
    if (spec.encodeProfile) raw.encodeProfile = spec.encodeProfile;
    return raw;
  }

  const arbProject = (opts) => arbSpec(opts).map(buildProject);

  return { arbProject, arbSpec, buildProject, frac, RANGES, FPS, CANVAS, TIMED_KINDS: ["video", "audio", "svg"] };
}

/* ∫ speed dt over clip-local [0, L], exactly: keys and ease-in-out midpoints
   cut the speed curve into linear / quadratic pieces, where Simpson's rule is
   exact. The reference mediaTimeAt's 1/120 s trapezoid grid is checked against
   (INV-05c). */
function speedIntegral(c, L) {
  const base = K.clipSpeed(c);
  const f = (lt) => Math.min(S.SPEED_MAX, Math.max(S.SPEED_MIN, K.kfChannel(c, "speed", lt, base)));
  const keys = c.keyframes?.speed || [];
  const cuts = [0, L, ...keys.map((k) => k.t), ...keys.slice(1).map((k, i) => (keys[i].t + k.t) / 2)]
    .filter((x) => x >= 0 && x <= L).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < cuts.length; i++) {
    const a = cuts[i - 1], b = cuts[i];
    if (b > a) sum += ((b - a) / 6) * (f(a) + 4 * f((a + b) / 2) + f(b));
  }
  return sum;
}
module.exports.speedIntegral = speedIntegral;

/* Load a raw project the way the editor does (normalizeProject adopts clips,
   so it gets a deep copy). Link ids need no factory: on-disk ids are kept and
   new ones are lg_<video clip id> (D1). */
function loadProject(raw) {
  return normalizeProject(JSON.parse(JSON.stringify(raw)), { prevFps: 30 }).project;
}
module.exports.loadProject = loadProject;
