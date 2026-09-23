/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — project.json schema + timeline constants (single source).

   Dual-mode classic script (no ES modules, so index.html still works from
   file://): a <script> tag exposes it as `FableCore.schema`, Node `require()`s
   it via module.exports. app.js, mcp-server.js and the tests all read these
   tables from here — change them here, never re-declare them elsewhere.

   PROJECT_SCHEMA is a JSON Schema 2020-12 SUBSET. Only these keywords may
   appear (the validator interprets exactly this set, and a test enforces it):
     $schema $id title description $defs $ref(local) type enum const minimum
     maximum exclusiveMinimum required properties additionalProperties items
     default, plus `x-` annotations:
       x-animatable — prop may be keyframed (feeds ANIMATABLE)
       x-patchable  — project field MCP `setProject` may change
       x-severity   — how core/validate.js grades a violation. Unannotated =
                      "error". A string ("warning"/"error") covers the node and
                      everything evaluated beneath it (through $ref) until the
                      next x-severity; an object {keyword: severity} overrides
                      single keywords on that node only.
   Severity policy: an ERROR is something that crashes the editor, corrupts
   timing or silently drops what the author asked for (bad clip timing/kind/
   lane, unknown enum on a transition/textAnim/blend/fit/ease, speed outside
   0.1–8, canvas size/fps not > 0). Everything else is a WARNING.
   Where the docs and the code disagree, this follows the code (e.g. speed is
   clamped to 0.1–8 by clipSpeed, the mixer clamps volume to 0–4).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else (root.FableCore = root.FableCore || {}).schema = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ── Timeline constants ── */
  const MIN_DUR = 0.05;                    // shortest clip an edit may leave behind (s)
  const SPEED_MIN = 0.1, SPEED_MAX = 8;    // clipSpeed() clamp; the inspector slider is 0.25–4
  const TRANSITIONS = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down",
    "zoom", "wipe", "wipe-right", "wipe-up", "wipe-down", "iris", "spin", "blur", "whip",
    "glitch", "pop"];
  const TRANSITION_ALIASES = ["dissolve", "wipe-left"]; // applyTransition accepts them (= fade, = wipe)
  const TEXT_ANIMS = ["none", "typewriter", "word-pop", "word-slide", "karaoke",
    "letter-pop", "wave", "bounce", "shake",
    "clip-reveal", "zoom-in", "font-cut", "rise-mask"];
  const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "lighter", "soft-light",
    "hard-light", "color-dodge", "darken", "lighten", "difference"];
  /* Named looks. % props multiply against the clip's own value, additive props add. */
  const FILTER_PRESETS = {
    none: {},
    cinematic: { contrast: 112, saturation: 118, temperature: -10, vignette: 28 },
    "teal-orange": { contrast: 115, saturation: 125, temperature: -18, hue: -8, vignette: 22 },
    noir: { grayscale: 100, contrast: 128, brightness: 96, vignette: 45 },
    vintage: { sepia: 42, contrast: 92, brightness: 106, saturation: 88, temperature: 12, vignette: 30 },
    faded: { contrast: 84, brightness: 110, saturation: 82 },
    warm: { temperature: 28, brightness: 103, saturation: 108 },
    cold: { temperature: -28, saturation: 104 },
    pop: { saturation: 152, contrast: 116 },
    dreamy: { brightness: 109, saturation: 112, blur: 0.6, temperature: 8 },
    retro: { saturation: 130, hue: -6, contrast: 106, sepia: 15 },
    "bw-soft": { grayscale: 100, contrast: 95, brightness: 108 },
    cyberpunk: { saturation: 140, hue: 12, contrast: 118, temperature: -15, vignette: 25 },
    sunset: { temperature: 24, tint: 6, brightness: 105, saturation: 116, contrast: 104, vignette: 20 },
    midnight: { temperature: -24, brightness: 88, contrast: 122, saturation: 94, vignette: 38 },
  };
  /* Keyframe easing curves; `ease` sits on the destination keyframe. */
  const EASE = {
    linear: (u) => u,
    "ease-in": (u) => u * u,
    "ease-out": (u) => 1 - (1 - u) * (1 - u),
    "ease-in-out": (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
  };

  /* ── Schema builders (props table stays one line per prop) ── */
  const A = { "x-animatable": true };
  const P = { "x-patchable": true };
  const W = { "x-severity": "warning" };
  const E = { "x-severity": "error" }; // back to error inside a warning subtree
  const num = (dflt, o) => ({ type: "number", default: dflt, ...o });
  const pct = (dflt, o) => num(dflt, { minimum: 0, maximum: 100, ...o });
  const str = (dflt, o) => ({ type: "string", default: dflt, ...o });
  const bool = (dflt, o) => ({ type: "boolean", default: dflt, ...o });
  const pick = (values, dflt, o) => ({ type: "string", enum: values, default: dflt, ...o });
  const ref = (name) => ({ $ref: "#/$defs/" + name });
  const list = (name, o) => ({ type: "array", items: ref(name), ...o });

  /* Clip props. Key ORDER here is DEFAULT_PROPS's order (the UI persists every
     default on every clip, so reordering would churn every saved project.json). */
  const PROPS = {
    type: "object",
    description: "Clip properties; missing keys take `default`. Unknown keys are kept.",
    ...W, // a bad look is a warning; timing (speed) and enums the renderer switches on are errors
    additionalProperties: true,
    properties: {
      // transform & compositing
      x: num(0, { ...A, description: "px offset from canvas center" }),
      y: num(0, { ...A, description: "px offset from canvas center" }),
      scale: num(1, A),
      rotation: num(0, { ...A, description: "degrees" }),
      opacity: num(1, { ...A, minimum: 0, maximum: 1 }),
      // audio / time
      volume: num(1, { ...A, minimum: 0, maximum: 4, description: "gain; the inspector stops at 2, the mixer clamps at 4" }),
      pan: num(0, { ...A, minimum: -1, maximum: 1, description: "-1 full left … +1 full right" }),
      speed: num(1, { ...A, ...E, minimum: SPEED_MIN, maximum: SPEED_MAX, description: "playback rate; keyframes = speed ramp (media time = in + ∫speed dt)" }),
      // filter / color
      brightness: num(100, { ...A, minimum: 0, description: "%" }),
      contrast: num(100, { ...A, minimum: 0, description: "%" }),
      saturation: num(100, { ...A, minimum: 0, description: "%" }),
      hue: num(0, { ...A, description: "degrees" }),
      blur: num(0, { ...A, minimum: 0, description: "px" }),
      grayscale: pct(0, A),
      sepia: pct(0, A),
      invert: pct(0, A),
      temperature: num(0, { ...A, minimum: -100, maximum: 100, description: "-100 cool … +100 warm" }),
      tint: num(0, { ...A, minimum: -100, maximum: 100, description: "-100 magenta … +100 green" }),
      vignette: pct(0, A),
      filterPreset: pick(Object.keys(FILTER_PRESETS), "none", { description: "named look, combines with the sliders" }),
      // layout
      fit: pick(["contain", "cover", "stretch", "none"], "contain", E),
      cropL: pct(0, { description: "% of the source trimmed off the left edge" }),
      cropT: pct(0, { description: "% trimmed off the top edge" }),
      cropR: pct(0, { description: "% trimmed off the right edge" }),
      cropB: pct(0, { description: "% trimmed off the bottom edge" }),
      flipH: bool(false),
      flipV: bool(false),
      cornerRadius: num(0, { ...A, minimum: 0, description: "px, rounded corners (PiP look)" }),
      blend: pick(BLEND_MODES, "normal", { ...E, description: "canvas blend mode" }),
      // keying / cut-out
      chromaKey: str("", { description: "hex key color, e.g. #00ff00; empty = off" }),
      chromaTolerance: pct(26),
      chromaSoftness: pct(12),
      bgRemove: bool(false, { description: "AI person cut-out (MediaPipe)" }),
      // motion fx
      shake: num(0, { ...A, minimum: 0, description: "camera-shake amplitude, px" }),
      shakeSpeed: num(8, { minimum: 0, description: "shake frequency" }),
      rgbSplit: num(0, { ...A, minimum: 0, description: "chromatic aberration, px" }),
      grain: pct(0, { ...A, description: "animated film grain, %" }),
      // text clips
      text: str("Title", { description: "\\n for multi-line" }),
      fontSize: num(72, { ...A, exclusiveMinimum: 0, description: "px" }),
      color: str("#ffffff"),
      color2: str("", { description: "if set: vertical gradient color → color2" }),
      font: str("Segoe UI", { description: "system font, library/fonts family, or any Google Font name" }),
      bold: bool(true),
      italic: bool(false),
      weight: num(0, { minimum: 0, maximum: 1000, description: "300–900 overrides `bold` when non-zero" }),
      align: pick(["left", "center", "right", "justify"], "center"),
      letterSpacing: num(0, { ...A, description: "px" }),
      lineHeight: num(1.2, { exclusiveMinimum: 0, description: "multiplier" }),
      uppercase: bool(false),
      textShadow: num(12, { minimum: 0, description: "soft drop shadow amount, 0 = off" }),
      glow: pct(0, { ...A, description: "neon glow strength; replaces the drop shadow" }),
      glowColor: str("", { description: "empty = the text color" }),
      textAnim: pick(TEXT_ANIMS, "none", E),
      wordRate: num(0.15, { exclusiveMinimum: 0, description: "seconds per word" }),
      direction: pick(["auto", "ltr", "rtl"], "auto"),
      strokeWidth: num(0, { minimum: 0, description: "text outline, px" }),
      strokeColor: str("#000000"),
      bgColor: str("#000000", { description: "pill behind each line" }),
      bgOpacity: num(0, { minimum: 0, maximum: 1 }),
      boxW: num(0, { minimum: 0, description: "text box px; 0 = hug content" }),
      boxH: num(0, { minimum: 0, description: "text box px; 0 = hug content" }),
      boxFit: bool(false, { description: "false = wrap at fixed fontSize; true = shrink font to fit the box" }),
      vAlign: pick(["top", "middle", "bottom"], "middle", { description: "vertical align of the text block in the box" }),
      // no default: only present where they mean something
      audioChannel: { type: "integer", minimum: 0, description: "source channel of a linked audio stem (0 = L, 1 = R, …)" },
      fontCutSet: { type: "array", items: { type: "string" }, description: "font families cycled by textAnim font-cut" },
    },
  };

  /* Inside the keyframes warning subtree, but a null or partial entry crashes the
     load-time sort, so the entry's own shape is an error again. */
  const KEYFRAME = {
    type: "object",
    "x-severity": { type: "error", required: "error" },
    additionalProperties: false,
    required: ["t", "v"],
    properties: {
      t: { type: "number", minimum: 0, description: "s, relative to clip start" },
      v: { type: "number" },
      ease: { type: "string", enum: Object.keys(EASE), default: "ease-in-out", description: "easing of the segment ending here", ...E },
    },
  };
  /* Lanes when project.tracks is absent or empty (app.js DEFAULT_TRACK_DEFS). */
  const DEFAULT_TRACKS = [
    { id: "V3", kind: "video" }, { id: "V2", kind: "video" }, { id: "V1", kind: "video" },
    { id: "A1", kind: "audio" }, { id: "A2", kind: "audio" }, { id: "A3", kind: "audio" }, { id: "A4", kind: "audio" },
  ];

  const PROJECT_SCHEMA = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ronak-create.github.io/FableCut/schema/project.schema.json",
    title: "FableCut project.json",
    description: "The timeline document the editor UI, REST API and MCP tools read and write.",
    $ref: "#/$defs/project",
    $defs: {
      project: {
        type: "object",
        additionalProperties: true,
        required: ["media", "clips"],
        properties: {
          name: { type: "string", default: "Untitled Project", ...P, ...W },
          width: { type: "integer", exclusiveMinimum: 0, default: 1280, description: "composition canvas, px", ...P },
          height: { type: "integer", exclusiveMinimum: 0, default: 720, description: "composition canvas, px", ...P },
          fps: { type: "number", exclusiveMinimum: 0, default: 30, description: "timeline + export frame rate (sole FPS source)", ...P },
          background: { type: "string", default: "#000000", description: "canvas color behind all clips", ...P, ...W },
          revision: { type: "integer", minimum: 0, default: 0, description: "bump on every write; stale writes are rejected", ...W },
          panSchema: { type: "integer", minimum: 0, maximum: 1, description: "1 = pan-aware; absent = pre-pan project (migrated once on load)", ...W },
          folders: list("folder", { description: "project-bin virtual folders", ...P, ...W }),
          tracks: list("track", { description: "timeline lanes; absent or empty = `default`", default: DEFAULT_TRACKS, ...P, ...W }),
          media: list("media"),
          clips: list("clip"),
          markers: list("marker", { description: "beat/cue markers; snap targets", ...P, ...W }),
          inPoint: { type: ["number", "null"], minimum: 0, description: "work-area IN, s", ...P, ...W },
          outPoint: { type: ["number", "null"], minimum: 0, description: "work-area OUT, s; null = timeline end", ...P, ...W },
          disabledTracks: { type: "array", items: { type: "string" }, description: "track ids left out of preview/export", ...P, ...W },
          exportFrame: { ...ref("exportFrame"), ...P, ...W },
          encodeProfile: { type: ["string", "null"], description: "fast-export profile id (encoding-profiles.json)", ...P, ...W },
        },
      },
      // track, marker, folder, exportFrame: reached only through project fields
      // marked W above, so everything inside them grades as a warning
      track: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind"],
        properties: {
          id: { type: "string", description: "V1…Vn (video) or A1…An (audio)" },
          kind: { type: "string", enum: ["video", "audio"] },
        },
      },
      media: {
        type: "object",
        additionalProperties: true,
        required: ["id", "name", "kind", "src"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          kind: { type: "string", enum: ["video", "audio", "image", "svg"] },
          src: { type: "string", description: "/media/… or /library/… (never a raw https:// URL)" },
          duration: { type: ["number", "null"], minimum: 0, description: "s; the browser probes it when missing", ...W },
          width: { type: ["number", "null"], minimum: 0, ...W },
          height: { type: ["number", "null"], minimum: 0, ...W },
          folderId: { type: ["string", "null"], description: "id of a folders[] entry", ...W },
          channels: { type: "integer", minimum: 1, description: "audio channel count (probe cache; the UI does not persist it)", ...W },
        },
      },
      clip: {
        type: "object",
        additionalProperties: true,
        required: ["id", "kind", "track", "start", "duration"],
        properties: {
          id: { type: "string" },
          mediaId: { type: ["string", "null"], description: "null for text and adjust clips" },
          kind: { type: "string", enum: ["video", "audio", "image", "svg", "text", "adjust"] },
          track: { type: "string", description: "a tracks[] id; video kinds on V lanes, audio on A lanes" },
          start: { type: "number", minimum: 0, description: "timeline position, s" },
          in: { type: "number", minimum: 0, default: 0, description: "offset into the source, s (0 for image/svg/text/adjust)" },
          duration: { type: "number", exclusiveMinimum: 0, description: "length on the timeline, s" },
          name: { type: "string", ...W },
          props: ref("props"),
          keyframes: ref("keyframes"),
          transitionIn: ref("transition"),
          transitionOut: ref("transition"),
          linkGroup: { type: "string", description: "AV link: video + per-channel stems share one id", ...W },
          linkedId: { type: "string", description: "legacy pairwise AV link (superseded by linkGroup)", ...W },
          styleName: { type: "string", description: "title style the inspector picker last applied", ...W },
        },
      },
      props: PROPS,
      keyframe: KEYFRAME,
      speedKeyframe: {
        ...KEYFRAME,
        description: "a speed-ramp keyframe: out-of-range values would be clamped, retiming the clip",
        properties: { ...KEYFRAME.properties, v: { type: "number", minimum: SPEED_MIN, maximum: SPEED_MAX, ...E } },
      },
      keyframes: {
        type: ["object", "null"],
        description: "animatable prop name → keyframes sorted by t",
        ...W,
        properties: { speed: list("speedKeyframe") },
        additionalProperties: list("keyframe"),
      },
      transition: {
        type: ["object", "null"],
        "x-severity": { additionalProperties: "warning" }, // a bad/partial transition silently renders nothing
        additionalProperties: false,
        required: ["type", "duration"],
        properties: {
          type: { type: "string", enum: TRANSITIONS.concat(TRANSITION_ALIASES) },
          duration: { type: "number", minimum: 0, description: "s" },
        },
      },
      marker: {
        type: "object",
        additionalProperties: false,
        required: ["t"],
        properties: {
          t: { type: "number", minimum: 0, description: "s" },
          label: { type: "string" },
        },
      },
      folder: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string", default: "Folder" },
          parentId: { type: ["string", "null"] },
          open: { type: "boolean", default: true },
        },
      },
      exportFrame: {
        type: ["object", "null"],
        description: "delivery crop inside the canvas; null/absent = full canvas. Even w/h for H.264.",
        additionalProperties: false,
        required: ["w", "h"],
        properties: {
          x: { type: "number", minimum: 0, default: 0 },
          y: { type: "number", minimum: 0, default: 0 },
          w: { type: "number", minimum: 8 },
          h: { type: "number", minimum: 8 },
        },
      },
    },
  };

  /* ── Derived tables (one source of truth: the schema above) ── */
  const defs = PROJECT_SCHEMA.$defs;
  const propEntries = Object.entries(defs.props.properties);
  const DEFAULT_PROPS = Object.fromEntries(propEntries.filter(([, s]) => "default" in s).map(([k, s]) => [k, s.default]));
  const ANIMATABLE = propEntries.filter(([, s]) => s["x-animatable"]).map(([k]) => k);
  const PATCHABLE_PROJECT_FIELDS = Object.keys(defs.project.properties).filter((k) => defs.project.properties[k]["x-patchable"]);
  const CLIP_KINDS = defs.clip.properties.kind.enum;
  const MEDIA_KINDS = defs.media.properties.kind.enum;

  /* Consumers share these tables — freeze so none can mutate another's view. */
  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };

  return deepFreeze({
    PROJECT_SCHEMA,
    DEFAULT_PROPS, ANIMATABLE, PATCHABLE_PROJECT_FIELDS, CLIP_KINDS, MEDIA_KINDS,
    TRANSITIONS, TEXT_ANIMS, BLEND_MODES, FILTER_PRESETS, EASE,
    MIN_DUR, SPEED_MIN, SPEED_MAX,
  });
});
