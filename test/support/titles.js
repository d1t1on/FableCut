/* Every test title under test/, as node:test would register it.

   Each *.test.js is required in a child process with node:test swapped for a
   recorder, so titles built at run time (template literals, a TITLES table)
   count too. Test bodies never run; describe() bodies do, to reach the titles
   nested in them. Used by test/contract/spec-ids.test.js. */
"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");

const CHILD = `
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const titles = [], errors = [];
let file = "";
const noop = () => {};
const test = (name) => { if (typeof name === "string") titles.push({ file, title: name }); };
const describe = (name, ...rest) => { test(name); const fn = rest.find((x) => typeof x === "function"); if (fn) fn(); };
for (const f of [test, describe]) Object.assign(f, { skip: f, todo: f, only: f });
const api = Object.assign(test, { test, it: test, describe, suite: describe, before: noop, after: noop,
  beforeEach: noop, afterEach: noop, run: noop, mock: new Proxy({}, { get: () => noop }) });
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "node:test" || request === "test" ? api : load.call(this, request, ...rest);
};
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(path.join(process.cwd(), "test")).filter((f) => f.endsWith(".test.js")).sort()) {
  file = path.relative(process.cwd(), f);
  try { require(f); } catch (e) { errors.push(file + ": " + e.message); }
}
process.stdout.write(JSON.stringify({ titles, errors }), () => process.exit(0));
`;

function testTitles() {
  const r = spawnSync(process.execPath, ["-e", CHILD], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`collecting test titles failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

module.exports = { testTitles };
