/* Contract: test/fixtures/demo-reel.json is the playground's project. The
   source is DEMO in docs/demo/static-shim.js (what visitors see); the fixture
   copies it so the tests cover the exact document the playground ships (③).
   The fixture spells out two documented defaults the shim leaves implicit:
   `in: 0` (CLAUDE.md: `in` omitted = 0) and `mediaId: null` on text/adjust
   clips. Anything else must match exactly. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { loadFixture } = require("../fixtures");

const ROOT = path.join(__dirname, "..", "..");
const SHIM = path.join(ROOT, "docs", "demo", "static-shim.js");

/* The `var DEMO = { … };` object literal, evaluated on its own. */
function shimDemo() {
  const src = fs.readFileSync(SHIM, "utf8");
  const at = src.indexOf("var DEMO = {");
  assert.ok(at >= 0, "docs/demo/static-shim.js no longer declares `var DEMO = { … }` — update shimDemo() in " + path.relative(ROOT, __filename));
  let i = src.indexOf("{", at), depth = 0;
  const from = i;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && !--depth) break; }
  return JSON.parse(JSON.stringify(vm.runInNewContext("(" + src.slice(from, i + 1) + ")")));
}
const withDefaults = (doc) => ({
  ...doc,
  clips: doc.clips.map((c) => ({
    ...(["text", "adjust"].includes(c.kind) ? { mediaId: null } : {}), ...c, in: c.in ?? 0,
  })),
});
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

test("test/fixtures/demo-reel.json equals the playground's DEMO project (modulo in:0 / mediaId:null defaults)", () => {
  assert.deepEqual(sortKeys(withDefaults(loadFixture("demo-reel"))), sortKeys(withDefaults(shimDemo())),
    "test/fixtures/demo-reel.json drifted from DEMO in docs/demo/static-shim.js (the source): copy DEMO into the " +
    "fixture as JSON, keeping in:0 and mediaId:null explicit (test/core/summary.test.js then says how to refresh its snapshot)");
});
