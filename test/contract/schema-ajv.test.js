/* Contract: core/validate.js's structural layer agrees with ajv, the reference
   JSON Schema 2020-12 implementation, on PROJECT_SCHEMA — so the published
   schema/project.schema.json means the same thing to other tools as it does
   to the editor.

   For every fixture and ~thousands of mutations generated from them (type
   flips, deleted keys, bogus enum strings, out-of-range numbers, extra keys),
   the SET of failing JSON pointers must match. Mapping of ajv errors onto the
   pointer our layer reports:
     required             → instancePath + "/" + params.missingProperty   (the missing key)
     additionalProperties → instancePath + "/" + params.additionalProperty (the extra key)
     every other keyword  → instancePath
   Sets, not lists: ajv (allErrors) reports each failing keyword, we report one
   issue per value (a mistyped value skips its enum/range checks).

   ajv is a devDependency. Without it this skips ("run npm ci"), unless
   FABLECUT_REQUIRE_DEV=1 (CI), where a missing ajv fails. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { PROJECT_SCHEMA } = require("../../core/schema");
const { validateStructure, compileSchema } = require("../../core/validate");
const { listFixtures, loadFixture } = require("../fixtures");

let Ajv2020 = null;
try { Ajv2020 = require("ajv/dist/2020"); Ajv2020 = Ajv2020.default || Ajv2020; } catch { /* optional */ }
const REQUIRE_DEV = process.env.FABLECUT_REQUIRE_DEV === "1";
const skip = Ajv2020 || REQUIRE_DEV ? false : "ajv is not installed — run npm ci";

function ajvFor(schema) {
  assert.ok(Ajv2020, "ajv is not installed and FABLECUT_REQUIRE_DEV=1 — run npm ci");
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const xs = new Set();
  (function collect(v) {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k.startsWith("x-")) xs.add(k); collect(x); }
  })(schema);
  ajv.addVocabulary([...xs]); // our annotations; strict mode rejects unknown keywords otherwise
  return ajv.compile(structuredClone(schema));
}

const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
function ajvPointers(validate, doc) {
  if (validate(doc)) return [];
  return [...new Set(validate.errors.map((e) =>
    e.keyword === "required" ? e.instancePath + "/" + esc(e.params.missingProperty)
      : e.keyword === "additionalProperties" ? e.instancePath + "/" + esc(e.params.additionalProperty)
        : e.instancePath))].sort();
}
const ourPointers = (issues) => [...new Set(issues.map((i) => i.pointer))].sort();

/* ── Mutation generator ── */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function* positions(v, segs = []) {
  yield segs;
  if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* positions(v[i], [...segs, i]);
  else if (isObj(v)) for (const k of Object.keys(v)) yield* positions(v[k], [...segs, k]);
}
const get = (doc, segs) => segs.reduce((o, s) => o[s], doc);
function edit(doc, segs, fn) {
  const d = structuredClone(doc);
  if (!segs.length) return fn(d);
  const parent = get(d, segs.slice(0, -1));
  fn(parent, segs.at(-1));
  return d;
}
const FLIP = (v) => (typeof v === "number" ? "7" : typeof v === "string" ? 7 : typeof v === "boolean" ? "yes"
  : v === null ? false : Array.isArray(v) ? {} : []);

function mutations(name, doc) {
  const out = [];
  const add = (what, d) => out.push({ what: `${name}: ${what}`, doc: d });
  for (const segs of positions(doc)) {
    const at = "/" + segs.join("/");
    const v = segs.length ? get(doc, segs) : doc;
    if (segs.length) add(`flip type at ${at}`, edit(doc, segs, (p, k) => { p[k] = FLIP(v); }));
    if (typeof v === "string") add(`bogus string at ${at}`, edit(doc, segs, (p, k) => { p[k] = "zz-bogus"; }));
    if (typeof v === "number") for (const n of [-1, 0, 0.5, 1e6])
      add(`${n} at ${at}`, edit(doc, segs, (p, k) => { p[k] = n; }));
    if (isObj(v)) {
      add(`extra key at ${at}`, edit(doc, segs, (p, k) => { (k === undefined ? p : p[k]).zzExtra = 1; }));
      for (const key of Object.keys(v))
        add(`delete ${at}/${key}`, edit(doc, [...segs, key], (p, k) => { delete p[k]; }));
    }
    if (Array.isArray(v)) add(`null entry in ${at}`, edit(doc, segs, (p, k) => { (k === undefined ? p : p[k]).push(null); }));
  }
  return out;
}

test("structural layer vs ajv: same failing pointers on every fixture and its mutations", { skip }, () => {
  const validate = ajvFor(PROJECT_SCHEMA);
  const docs = [];
  for (const name of listFixtures()) {
    const doc = loadFixture(name);
    docs.push({ what: `${name} (as is)`, doc }, ...mutations(name, doc));
  }
  for (const doc of [null, [], "x", 7, {}]) docs.push({ what: `root ${JSON.stringify(doc)}`, doc });
  assert.ok(docs.length >= 50, `only ${docs.length} documents`);

  const mismatches = [];
  const codes = new Set();
  let failing = 0;
  for (const { what, doc } of docs) {
    const issues = validateStructure(doc);
    for (const i of issues) codes.add(i.code);
    const ours = ourPointers(issues), theirs = ajvPointers(validate, doc);
    if (theirs.length) failing++;
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) mismatches.push(`${what}\n    ours: ${ours.join(" ")}\n    ajv:  ${theirs.join(" ")}`);
  }
  assert.equal(mismatches.length, 0, `${mismatches.length}/${docs.length} documents disagree:\n  ${mismatches.slice(0, 8).join("\n  ")}`);
  // the generator must actually exercise the interpreter, not just agree on valid docs
  assert.ok(failing > docs.length / 2, `only ${failing}/${docs.length} mutations were invalid`);
  for (const c of ["SCHEMA_TYPE", "SCHEMA_ENUM", "SCHEMA_MINIMUM", "SCHEMA_MAXIMUM", "SCHEMA_EXCLUSIVE_MINIMUM", "SCHEMA_REQUIRED", "SCHEMA_ADDITIONAL"])
    assert.ok(codes.has(c), `no mutation produced ${c}`);
});

test("structural layer vs ajv: a custom schema with const, integer, nested $ref and items", { skip }, () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["v"],
    additionalProperties: false,
    properties: {
      v: { const: 1 },
      n: { type: "integer", minimum: 0, maximum: 10 },
      e: { type: ["string", "null"], enum: ["a", "b", null] },
      list: { type: "array", items: { $ref: "#/$defs/item" } },
    },
    $defs: {
      item: { type: "object", required: ["id"], properties: { id: { type: "string" }, x: { type: "number", exclusiveMinimum: 0 } } },
    },
  };
  const ours = compileSchema(schema), theirs = ajvFor(schema);
  const values = [
    { v: 1 }, { v: 2 }, {}, { v: 1, extra: 0 }, { v: 1, n: 1.5 }, { v: 1, n: -1 }, { v: 1, n: 11 },
    { v: 1, e: "c" }, { v: 1, e: null }, { v: 1, e: 3 }, { v: 1, list: [{ id: "a" }, {}, { id: 3, x: 0 }, 5] },
    { v: 1, list: {} }, { v: "1" }, [], null,
  ];
  for (const v of values)
    assert.deepEqual(ourPointers(ours.validate(v)), ajvPointers(theirs, v), JSON.stringify(v));
});
