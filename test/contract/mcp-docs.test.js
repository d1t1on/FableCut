/* Contract: TOOLS in mcp-tools.js is the one list of MCP tools. tools/list
   serves it (①) and manifest.json is generated from it (②, npm run
   manifest); CLAUDE.md and README.md name the tools by hand, so this checks
   they name every tool and no tool that is gone (③). */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { TOOLS } = require("../../mcp-tools.js");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const NAMES = TOOLS.map((t) => t.name);

function compare(where, named, fix) {
  const missing = NAMES.filter((n) => !named.includes(n));
  const stale = [...new Set(named)].filter((n) => !NAMES.includes(n));
  assert.deepEqual(missing, [], `${where} doesn't name tool(s) ${missing.join(", ")}: ${fix}`);
  assert.deepEqual(stale, [], `${where} names tool(s) ${stale.join(", ")} that mcp-tools.js TOOLS doesn't have: remove or rename them there`);
}

test("CLAUDE.md → '## MCP connection' has a bullet for every tool in TOOLS", () => {
  const section = read("CLAUDE.md").split(/^(?=## )/m).find((s) => s.startsWith("## MCP connection"));
  assert.ok(section, "CLAUDE.md needs its '## MCP connection' section (the tool bullets live there)");
  // "- `fablecut_x` — …" or "- `fablecut_a` / `fablecut_b` — …"
  const named = [...section.matchAll(/^- (`fablecut_\w+`(?:\s*\/\s*`fablecut_\w+`)*)/gm)]
    .flatMap((m) => [...m[1].matchAll(/`(fablecut_\w+)`/g)].map((x) => x[1]));
  compare("CLAUDE.md → '## MCP connection'", named,
    "add a bullet \"- `name` — what it does\" for each to the tool list at the top of that section (its summary is in mcp-tools.js)");
});

test("README.md's MCP 'Tools:' line names every tool in TOOLS", () => {
  const para = read("README.md").split(/\n\s*\n/).find((p) => /^\s*Tools: `fablecut_/.test(p)) || "";
  assert.ok(para, "README.md → '## Driving it with an AI agent' lost its 'Tools: `fablecut_…`' paragraph — restore it, or point this test at the tool list");
  compare("README.md → '## Driving it with an AI agent' → 'Tools:' paragraph",
    [...para.matchAll(/`(fablecut_\w+)`/g)].map((m) => m[1]), "add each, in backticks, to that paragraph");
});
