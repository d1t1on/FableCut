/* core/schema.js — the project schema and the tables derived from it.

   DEFAULT_PROPS and ANIMATABLE are DERIVED from PROJECT_SCHEMA, so these
   snapshots are the guard: the UI persists every default on every clip, and a
   reordered or changed default would silently churn every saved project.json.
   The snapshots are copied verbatim from the app.js literals they replaced —
   change them only together with a deliberate schema change. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const schema = require("../../core/schema");
const { lift } = require("../support/slice");
const { PROJECT_SCHEMA, DEFAULT_PROPS, ANIMATABLE, PATCHABLE_PROJECT_FIELDS } = schema;

const DEFAULT_PROPS_SNAPSHOT = Object.freeze({
  x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1, pan: 0,
  speed: 1,
  brightness: 100, contrast: 100, saturation: 100, hue: 0,
  blur: 0, grayscale: 0, sepia: 0, invert: 0,
  temperature: 0, tint: 0, vignette: 0,
  filterPreset: "none",
  fit: "contain",
  cropL: 0, cropT: 0, cropR: 0, cropB: 0,
  flipH: false, flipV: false,
  cornerRadius: 0,
  blend: "normal",
  chromaKey: "", chromaTolerance: 26, chromaSoftness: 12,
  bgRemove: false,
  shake: 0, shakeSpeed: 8,
  rgbSplit: 0,
  grain: 0,
  text: "Title", fontSize: 72, color: "#ffffff", color2: "", font: "Segoe UI",
  bold: true, italic: false, weight: 0, align: "center",
  letterSpacing: 0, lineHeight: 1.2, uppercase: false, textShadow: 12,
  glow: 0, glowColor: "",
  textAnim: "none", wordRate: 0.15, direction: "auto",
  strokeWidth: 0, strokeColor: "#000000", bgColor: "#000000", bgOpacity: 0,
  boxW: 0, boxH: 0,
  boxFit: false,
  vAlign: "middle",
});
const ANIMATABLE_SNAPSHOT = Object.freeze(["x", "y", "scale", "rotation", "opacity", "volume", "pan", "speed",
  "brightness", "contrast", "saturation", "hue", "blur", "grayscale", "sepia", "invert",
  "temperature", "tint", "vignette", "cornerRadius", "shake", "rgbSplit", "grain",
  "fontSize", "letterSpacing", "glow"]);

const PROPS = PROJECT_SCHEMA.$defs.props.properties;

test("DEFAULT_PROPS: same keys, values and key order as the app.js literal it replaced", () => {
  // stringify compares order too — deepEqual alone would not
  assert.equal(JSON.stringify(DEFAULT_PROPS), JSON.stringify(DEFAULT_PROPS_SNAPSHOT));
});

test("ANIMATABLE: same entries in the same order as the app.js literal it replaced", () => {
  assert.deepEqual(ANIMATABLE, ANIMATABLE_SNAPSHOT);
});

test("props schema: every default comes from a props entry that accepts it", () => {
  for (const [k, v] of Object.entries(DEFAULT_PROPS)) {
    const s = PROPS[k];
    assert.ok(s, `no props schema entry for ${k}`);
    assert.equal(s.default, v, `${k}: default`);
    const t = typeof v === "number" ? (Number.isInteger(v) && s.type === "integer" ? "integer" : "number") : typeof v;
    assert.ok([].concat(s.type).includes(t), `${k}: default ${JSON.stringify(v)} is not ${s.type}`);
    if (s.enum) assert.ok(s.enum.includes(v), `${k}: default ${v} not in enum`);
    if (s.minimum != null) assert.ok(v >= s.minimum, `${k}: default below minimum`);
    if (s.maximum != null) assert.ok(v <= s.maximum, `${k}: default above maximum`);
    if (s.exclusiveMinimum != null) assert.ok(v > s.exclusiveMinimum, `${k}: default not above exclusiveMinimum`);
  }
  // the two props that exist without a default
  assert.ok(!("default" in PROPS.audioChannel) && PROPS.audioChannel.type === "integer");
  assert.ok(!("default" in PROPS.fontCutSet) && PROPS.fontCutSet.type === "array");
});

test("x-animatable: exactly the ANIMATABLE props, all numeric, nothing else in the schema", () => {
  for (const k of ANIMATABLE) {
    assert.equal(PROPS[k]?.type, "number", `${k} must be numeric to interpolate`);
    assert.equal(PROPS[k]["x-animatable"], true, `${k} lacks x-animatable`);
  }
  const marked = [];
  walk(PROJECT_SCHEMA, "#", (node, path) => { if (node["x-animatable"]) marked.push(path); });
  assert.deepEqual(marked, ANIMATABLE.map((k) => `#/$defs/props/properties/${k}`));
});

test("x-patchable: PATCHABLE_PROJECT_FIELDS is the MCP setProject whitelist", () => {
  const expected = ["name", "width", "height", "fps", "background", "markers", "disabledTracks",
    "exportFrame", "encodeProfile", "tracks", "folders", "inPoint", "outPoint"];
  assert.deepEqual([...PATCHABLE_PROJECT_FIELDS].sort(), [...expected].sort());
  assert.equal(new Set(PATCHABLE_PROJECT_FIELDS).size, PATCHABLE_PROJECT_FIELDS.length);
  const marked = [];
  walk(PROJECT_SCHEMA, "#", (node, path) => { if (node["x-patchable"]) marked.push(path); });
  assert.deepEqual(marked, PATCHABLE_PROJECT_FIELDS.map((k) => `#/$defs/project/properties/${k}`));
});

/* ── Keyword subset: the validator interprets exactly these ── */
const ALLOWED = new Set(["$schema", "$id", "title", "description", "$defs", "$ref", "type", "enum",
  "const", "minimum", "maximum", "exclusiveMinimum", "required", "properties",
  "additionalProperties", "items", "default"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/* Visit every subschema (only keyword positions — not property names or enum/default data). */
function walk(node, path, visit) {
  visit(node, path);
  for (const [k, v] of Object.entries(node)) {
    if (k === "properties" || k === "$defs")
      for (const [name, sub] of Object.entries(v)) walk(sub, `${path}/${k}/${name}`, visit);
    else if ((k === "items" || k === "additionalProperties") && typeof v === "object")
      walk(v, `${path}/${k}`, visit);
  }
}
function resolve(ref) {
  assert.match(ref, /^#\/\$defs\/[A-Za-z]+$/, `only local #/$defs refs: ${ref}`);
  return PROJECT_SCHEMA.$defs[ref.slice("#/$defs/".length)];
}

test("PROJECT_SCHEMA uses only the supported keyword subset, and every $ref resolves", () => {
  let nodes = 0;
  walk(PROJECT_SCHEMA, "#", (node, path) => {
    nodes++;
    assert.equal(typeof node, "object", `${path}: schema must be an object`);
    for (const k of Object.keys(node))
      assert.ok(ALLOWED.has(k) || k.startsWith("x-"), `${path}: unsupported keyword "${k}"`);
    if (node.$ref) assert.ok(resolve(node.$ref), `${path}: $ref ${node.$ref} does not resolve`);
    if (node.type) for (const t of [].concat(node.type)) assert.ok(TYPES.has(t), `${path}: bad type ${t}`);
    if (node.enum) assert.ok(Array.isArray(node.enum) && node.enum.length, `${path}: empty enum`);
    if (node.required) for (const r of node.required)
      assert.ok(node.properties && r in node.properties, `${path}: required "${r}" has no properties entry`);
    if ("additionalProperties" in node)
      assert.ok(typeof node.additionalProperties === "boolean" || typeof node.additionalProperties === "object");
  });
  assert.ok(nodes > 100, `walked only ${nodes} nodes`);
  assert.equal(PROJECT_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(resolve(PROJECT_SCHEMA.$ref));
});

test("schema enums track the constants the code dispatches on", () => {
  const d = PROJECT_SCHEMA.$defs;
  assert.deepEqual(schema.CLIP_KINDS, ["video", "audio", "image", "svg", "text", "adjust"]);
  assert.deepEqual(schema.MEDIA_KINDS, ["video", "audio", "image", "svg"]);
  assert.deepEqual(d.clip.properties.kind.enum, schema.CLIP_KINDS);
  assert.deepEqual(d.media.properties.kind.enum, schema.MEDIA_KINDS);
  assert.deepEqual(PROPS.textAnim.enum, schema.TEXT_ANIMS);
  assert.deepEqual(PROPS.blend.enum, schema.BLEND_MODES);
  assert.deepEqual(PROPS.filterPreset.enum, Object.keys(schema.FILTER_PRESETS));
  assert.deepEqual(d.keyframe.properties.ease.enum, Object.keys(schema.EASE));
  // applyTransition also accepts two undocumented aliases
  assert.deepEqual(d.transition.properties.type.enum, [...schema.TRANSITIONS, "dissolve", "wipe-left"]);
  // clipSpeed clamps to this range, wider than the inspector slider
  assert.equal(PROPS.speed.minimum, schema.SPEED_MIN);
  assert.equal(PROPS.speed.maximum, schema.SPEED_MAX);
  assert.deepEqual([schema.SPEED_MIN, schema.SPEED_MAX, schema.MIN_DUR], [0.1, 8, 0.05]);
});

test("tracks default: the lanes app.js creates when project.tracks is absent", () => {
  // validate.js reads TRACK_UNDECLARED's baseline from here; app.js still has its own copy
  const appDefault = lift(/const DEFAULT_TRACK_DEFS = (\[[^\]]*\]);/);
  assert.deepEqual(PROJECT_SCHEMA.$defs.project.properties.tracks.default, appDefault);
});

test("exports are deeply frozen, so no consumer can change another's tables", () => {
  assert.ok(Object.isFrozen(schema));
  assert.ok(Object.isFrozen(DEFAULT_PROPS));
  assert.ok(Object.isFrozen(schema.FILTER_PRESETS.cinematic));
  assert.ok(Object.isFrozen(PROPS.speed));
  assert.throws(() => { "use strict"; DEFAULT_PROPS.x = 5; }, TypeError);
});
