/* Contract: every REST route server.js answers is documented in CLAUDE.md's
   "## REST API" section — agents and scripts learn the API there. The route
   list lives in server.js; this is a static scan, it runs nothing. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");

test("CLAUDE.md → '## REST API' documents every /api route in server.js", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const routes = [...new Set([...server.matchAll(/\bp === "(\/api\/[^"]+)"/g)].map((m) => m[1]))];
  assert.ok(routes.length >= 10, `found only ${routes.length} routes — did the route style in server.js change? Update the regex in ${path.relative(ROOT, __filename)}`);
  const section = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8").split(/^(?=## )/m).find((s) => s.startsWith("## REST API"));
  assert.ok(section, "CLAUDE.md needs its '## REST API' section");
  const missing = routes.filter((r) => !new RegExp(`${r.replace(/[/-]/g, "\\$&")}(?![\\w/-])`).test(section));
  assert.deepEqual(missing, [],
    `undocumented route(s) ${missing.join(", ")}: add a bullet for each to CLAUDE.md → '## REST API' (method, body, status codes)`);
});
