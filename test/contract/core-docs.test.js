/* Contract: the file maps that describe core/ name every module in it (③).
   core/*.js is the source; AGENTS.md, CONTRIBUTING.md and README.md each
   describe the modules by hand, so a new module must get a line in each. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const section = (f, heading) => read(f).split(/^(?=## )/m).find((s) => s.startsWith(heading)) || "";
const CORE = fs.readdirSync(path.join(ROOT, "core")).filter((f) => f.endsWith(".js")).sort();

test("every core/ module is described in AGENTS.md, CONTRIBUTING.md and README.md", () => {
  const places = [
    ["AGENTS.md → '## Where the logic lives'", section("AGENTS.md", "## Where the logic lives"), (f) => `core/${f}`],
    ["CONTRIBUTING.md → '## Where things live' table", section("CONTRIBUTING.md", "## Where things live"), (f) => `| \`core/${f}\` |`],
    ["README.md → '## Project layout' (the core/ entry)", section("README.md", "## Project layout"), (f) => f],
  ];
  const problems = [];
  for (const [where, text, name] of places) {
    if (!text) { problems.push(`${where} is gone — restore it, or update ${path.relative(ROOT, __filename)}`); continue; }
    const missing = CORE.filter((f) => !text.includes(name(f)));
    if (missing.length) problems.push(`${where}: add ${missing.map((f) => `core/${f}`).join(", ")} with a one-line description`);
  }
  assert.deepEqual(problems, [], `core/ modules missing from the file maps:\n  ${problems.join("\n  ")}`);
});
