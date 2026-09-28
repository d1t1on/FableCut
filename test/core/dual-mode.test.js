/* core/*.js are dual-mode classic scripts: a <script> tag exposes each as
   FableCore.<ns>, Node require()s the same file. This loads them the way the
   browser does — index.html's order, one shared global, no module/require —
   and checks both modes hand out the same tables. (The browser test tools
   cannot open file:// pages, so this is the standalone-mode guard.) */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const coreScripts = scripts.filter((s) => s.startsWith("core/"));
const coreFiles = fs.readdirSync(path.join(ROOT, "core")).filter((f) => f.endsWith(".js")).map((f) => "core/" + f);

/* Structural snapshot built in THIS realm, so values from the vm realm compare
   cleanly (deepStrictEqual also compares prototypes, which differ per realm).
   Keeps key order and function source, e.g. EASE's curves. */
function canon(v) {
  if (typeof v === "function") return { fn: v.toString() };
  if (Array.isArray(v)) return Array.from(v, canon); // v.map would build a vm-realm array
  if (v && typeof v === "object") return { obj: Object.entries(v).map(([k, x]) => [k, canon(x)]) };
  return v;
}

test("index.html loads every core/*.js exactly once, before app.js", () => {
  assert.ok(coreScripts.length > 0, "no core/ script tags in index.html");
  assert.deepEqual([...coreScripts].sort(), [...coreFiles].sort(), "core/ files vs. script tags");
  assert.equal(new Set(coreScripts).size, coreScripts.length, "a core script is loaded twice");
  const app = scripts.indexOf("app.js");
  assert.ok(app >= 0, "app.js script tag missing");
  for (const s of coreScripts) assert.ok(scripts.indexOf(s) < app, `${s} must load before app.js`);
});

test("browser mode: core scripts in index.html order add only FableCore, matching require()", () => {
  const ctx = vm.createContext({}); // no module, no require — like a page
  const before = new Set(vm.runInContext("Object.getOwnPropertyNames(globalThis)", ctx));
  for (const s of coreScripts)
    vm.runInContext(fs.readFileSync(path.join(ROOT, s), "utf8"), ctx, { filename: s });
  const added = Array.from(vm.runInContext("Object.getOwnPropertyNames(globalThis)", ctx)).filter((k) => !before.has(k));
  assert.deepEqual(added, ["FableCore"], "core scripts leaked globals");

  const FableCore = vm.runInContext("FableCore", ctx);
  assert.equal(Object.keys(FableCore).length, coreScripts.length, "one FableCore namespace per core script");
  for (const s of coreScripts) {
    const ns = path.basename(s, ".js");
    const browser = FableCore[ns];
    assert.ok(browser, `FableCore.${ns} missing after loading ${s}`);
    assert.ok(Object.isFrozen(browser), `FableCore.${ns} must be frozen`);
    const node = require(path.join(ROOT, s));
    assert.deepEqual(Object.keys(browser), Object.keys(node), `${s}: export keys differ between modes`);
    assert.deepStrictEqual(canon(browser), canon(node), `${s}: export values differ between modes`);
  }
});

test("browser mode: a core script loaded before its dependencies says which one is missing", () => {
  const load = (ctx, s) => vm.runInContext(fs.readFileSync(path.join(ROOT, s), "utf8"), ctx, { filename: s });
  const needs = { "core/keyframes.js": ["core/schema.js"], "core/compose.js": ["core/schema.js", "core/keyframes.js"],
    "core/edit.js": ["core/schema.js", "core/keyframes.js", "core/links.js"],
    "core/project.js": ["core/schema.js", "core/links.js"],
    "core/validate.js": ["core/schema.js", "core/keyframes.js"],
    "core/summary.js": ["core/schema.js"],
    "core/patch.js": ["core/schema.js", "core/keyframes.js", "core/links.js", "core/edit.js", "core/project.js",
      "core/summary.js", "core/validate.js"] };
  for (const [s, deps] of Object.entries(needs)) {
    assert.ok(coreScripts.indexOf(s) > Math.max(...deps.map((d) => coreScripts.indexOf(d))), `${s} loads after ${deps}`);
    for (const missing of deps) {
      const ctx = vm.createContext({});
      for (const d of deps) if (d !== missing && coreScripts.indexOf(d) < coreScripts.indexOf(missing)) load(ctx, d);
      assert.throws(() => load(ctx, s), new RegExp(`${missing.replace(".", "\\.")} must load before ${s.replace(".", "\\.")}`), `${s} without ${missing}`);
    }
  }
});
