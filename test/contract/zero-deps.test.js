/* Contract: the runtime needs nothing from npm. Server, MCP server and core/
   may require only Node builtins and the repo's own files; package.json
   declares no runtime dependencies. devDependencies (ajv, …) are test-only
   tooling and must never be reached from these files. A static scan: it reads
   the source and runs nothing. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { builtinModules } = require("node:module");

const ROOT = path.join(__dirname, "..", "..");
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const RUNTIME = [
  "server.js", "mcp-server.js", "paths.js", "import-url.js", "encode-profiles.js", "analyze.js",
  ...walk("core").filter((f) => f.endsWith(".js")),
];
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
  assert.deepEqual(bad, []);
  assert.ok(total >= 20, `the scan found only ${total} specifiers — is the regex broken?`);
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
    assert.ok(v === undefined || (Array.isArray(v) ? v : Object.keys(v)).length === 0, `package.json ${field} must be empty`);
  }
});
