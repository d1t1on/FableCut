/* Contract: the runtime needs nothing from npm. Server, MCP server and core/
   may require only Node builtins and the repo's own files; package.json
   declares no runtime dependencies. devDependencies (ajv, …) are test-only
   tooling and must never be reached from these files. A static scan: it reads
   the source and runs nothing. The runtime files are derived (①): everything
   the entry points (package.json main, manifest.json's MCP entry point, the
   analyze.js CLI) reach through relative requires, plus all of core/. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { builtinModules } = require("node:module");

const ROOT = path.join(__dirname, "..", "..");
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

/* Every module specifier the file names: require("x"), import("x"), import … from "x". */
function specifiers(src) {
  const found = [];
  for (const re of [
    /\brequire\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
    /^\s*import\b[^;]*?\bfrom\s*(["'])([^"']+)\1/gm,
  ]) for (const m of src.matchAll(re)) found.push(m[2]);
  return found;
}

function runtimeFiles() {
  const json = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f) || !fs.existsSync(path.join(ROOT, f))) return;
    seen.add(f);
    for (const spec of specifiers(fs.readFileSync(path.join(ROOT, f), "utf8")).filter((x) => /^\.\.?\//.test(x))) {
      const to = path.relative(ROOT, path.resolve(ROOT, path.dirname(f), spec));
      visit(to.endsWith(".js") || to.endsWith(".json") ? to : to + ".js");
    }
  };
  for (const entry of [json("package.json").main, json("manifest.json").server.entry_point, "analyze.js"]) visit(entry);
  for (const f of walk("core")) if (f.endsWith(".js")) visit(f);
  return [...seen].filter((f) => f.endsWith(".js")).sort();
}
const RUNTIME = runtimeFiles();

test("runtime files require only Node builtins and relative paths", () => {
  const bad = [];
  let total = 0;
  for (const f of RUNTIME) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    // a computed require(x) could load anything — the scan must see every target
    for (const m of src.matchAll(/\brequire\s*\(\s*(?![\s"'`)])/g))
      bad.push(`${f}: non-literal require at offset ${m.index}`);
    for (const spec of specifiers(src)) {
      total++;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const to = path.resolve(ROOT, path.dirname(f), spec);
        if (!to.startsWith(ROOT + path.sep) || to.includes(`${path.sep}node_modules${path.sep}`))
          bad.push(`${f}: ${spec} leaves the repo`);
      } else if (!BUILTINS.has(spec.replace(/^node:/, ""))) bad.push(`${f}: ${spec} is not a Node builtin`);
    }
  }
  assert.deepEqual(bad, [], "runtime code may require only node: builtins and relative paths inside the repo (the runtime is " +
    "zero-dependency): replace each package with a builtin or repo code; test/dev-only tooling belongs in test/ or scripts/ " +
    "as a devDependency");
  assert.ok(total >= 20, `the scan found only ${total} specifiers — is the regex broken?`);
  for (const f of ["server.js", "mcp-server.js", "mcp-tools.js", "paths.js", "import-url.js", "encode-profiles.js", "core/schema.js"])
    assert.ok(RUNTIME.includes(f), `${f} is not reached from the entry points — did an entry point or a require move? Update runtimeFiles()`);
});

test("the scan itself catches packages, non-literal requires and ESM imports", () => {
  assert.deepEqual(specifiers(`const a = require("ajv"); const b = require('node:fs');
import x from "left-pad";
const c = await import("./core/x.js");`), ["ajv", "node:fs", "./core/x.js", "left-pad"]);
  assert.ok(/\brequire\s*\(\s*(?![\s"'`)])/.test("require(name)"));
  assert.ok(!/\brequire\s*\(\s*(?![\s"'`)])/.test("Node `require()`s it")); // prose in comments is fine
});

test("package.json declares no runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
    const v = pkg[field];
    assert.ok(v === undefined || (Array.isArray(v) ? v : Object.keys(v)).length === 0,
      `package.json ${field} must be empty: the runtime is zero-dependency — move test-only tooling to devDependencies`);
  }
});
