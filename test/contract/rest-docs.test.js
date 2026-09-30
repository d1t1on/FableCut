/* Contract: every REST route server.js answers is documented — in full in
   CLAUDE.md's "## REST API" section (agents and scripts learn the API
   there), and by name in README.md's REST item. The route list lives in
   server.js (`p === "/api/…"`); this is a static scan, it runs nothing. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function serverRoutes() {
  const routes = [...new Set([...read("server.js").matchAll(/\bp === "(\/api\/[^"]+)"/g)].map((m) => m[1]))];
  assert.ok(routes.length >= 10, `found only ${routes.length} routes — did the route style in server.js change? Update serverRoutes() in ${path.relative(ROOT, __filename)}`);
  return routes;
}
/* A route counts as named when it is not just the prefix of a longer path. */
const undocumented = (routes, text) => routes.filter((r) => !new RegExp(`${r.replace(/[/-]/g, "\\$&")}(?![\\w/-])`).test(text));

test("CLAUDE.md → '## REST API' documents every /api route in server.js", () => {
  const section = read("CLAUDE.md").split(/^(?=## )/m).find((s) => s.startsWith("## REST API"));
  assert.ok(section, "CLAUDE.md needs its '## REST API' section");
  const missing = undocumented(serverRoutes(), section);
  assert.deepEqual(missing, [],
    `undocumented route(s) ${missing.join(", ")}: add a bullet for each to CLAUDE.md → '## REST API' (method, body, status codes)`);
});

test("README.md's REST item names every /api route in server.js", () => {
  const item = read("README.md").split(/\n(?=\d+\. \*\*)/).find((s) => s.startsWith("3. **REST**")) || "";
  assert.ok(item, "README.md → '## Driving it with an AI agent' lost its '3. **REST**' item — restore it, or point this test at the REST list");
  const missing = undocumented(serverRoutes(), item.split(/\n\S/)[0]);
  assert.deepEqual(missing, [],
    `README.md → '## Driving it with an AI agent' → '3. **REST**' doesn't name ${missing.join(", ")}: add each (method + path) to that list`);
});
