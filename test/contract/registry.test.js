/* Contract: the SSOT registry in AGENTS.md → "## Development" is itself
   checked (③), so it can't claim a guard that doesn't exist:
   - every test file and npm script its "enforced by" column names exists;
   - every ② (generated) row names a --check command that CI runs;
   - every test/contract/ file is registered (a new contract test = a row);
   - the Scripts table lists exactly package.json's scripts. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const DEV = read("AGENTS.md").split(/^(?=## )/m).find((s) => s.startsWith("## Development")) || "";
const sub = (h) => DEV.split(/^(?=### )/m).find((s) => s.startsWith(`### ${h}`)) || "";
const SCRIPTS = JSON.parse(read("package.json")).scripts;
const CI = read(".github/workflows/ci.yml");
const WHERE = "AGENTS.md → '## Development' → '### Single source of truth' (the registry table)";

/* Body rows of the first markdown table in `text`, as trimmed cells. */
const rows = (text) => text.split("\n").filter((l) => l.startsWith("|")).slice(2)
  .map((l) => l.slice(1, l.endsWith("|") ? -1 : undefined).split(" | ").map((c) => c.trim()));
const ticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
/* "npm run schema -- --check" → "schema"; "npm test" → "test"; "npm start" → "start" */
const scriptOf = (cmd) => (cmd.match(/^npm (?:run (\S+)|(test|start))\b/) || []).slice(1).find(Boolean);

test("every registry row names a method and guards that exist", () => {
  assert.ok(DEV, "AGENTS.md needs its '## Development' section (scripts, rules, the SSOT registry)");
  const table = rows(sub("Single source of truth"));
  assert.ok(table.length >= 20, `${WHERE} has only ${table.length} rows — did the table move?`);
  const problems = [];
  for (const [fact, source, , method, enforced] of table) {
    const row = `row "${fact}"`;
    if (!source || !enforced) problems.push(`${row}: fill in the source and the enforced-by cells`);
    if (!/^[①②③]$/.test(method || "")) problems.push(`${row}: method must be ①, ② or ③ (convention alone is not a method), not "${method}"`);
    const items = ticks(enforced || "");
    for (const f of items.filter((i) => /^test\/.+\.js$/.test(i)))
      if (!fs.existsSync(path.join(ROOT, f))) problems.push(`${row}: ${f} does not exist — fix the path or add the test`);
    const cmds = items.filter((i) => i.startsWith("npm "));
    for (const c of cmds) if (!SCRIPTS[scriptOf(c)]) problems.push(`${row}: \`${c}\` names no script in package.json`);
    if (method === "②") {
      const checks = cmds.filter((c) => /--check|:check\b/.test(c));
      if (!checks.length) problems.push(`${row}: a ② row needs its staleness command (npm run <x> -- --check or npm run <x>:check)`);
      for (const c of checks) if (!CI.includes(`run: ${c}`)) problems.push(`${row}: CI never runs \`${c}\` — add a step to .github/workflows/ci.yml's check job`);
    }
  }
  assert.deepEqual(problems, [], `${WHERE}:\n  ${problems.join("\n  ")}`);
});

test("every contract test is registered", () => {
  const enforced = rows(sub("Single source of truth")).map((r) => r[4] || "").join(" ");
  const missing = fs.readdirSync(path.join(ROOT, "test", "contract")).filter((f) => f.endsWith(".test.js"))
    .map((f) => `test/contract/${f}`).filter((f) => !enforced.includes(`\`${f}\``));
  assert.deepEqual(missing, [], `${WHERE}: add a row for ${missing.join(", ")} (fact | source | copies | method | enforced by)`);
});

test("the Scripts table lists exactly package.json's scripts", () => {
  const listed = rows(sub("Scripts")).flatMap((r) => ticks(r[0])).map(scriptOf).filter(Boolean);
  const missing = Object.keys(SCRIPTS).filter((s) => !listed.includes(s));
  const stale = listed.filter((s) => !SCRIPTS[s]);
  const where = "AGENTS.md → '## Development' → '### Scripts'";
  assert.deepEqual(missing, [], `${where}: add a row for npm script(s) ${missing.join(", ")} (\`npm run <name>\` | what it does)`);
  assert.deepEqual(stale, [], `${where} lists ${stale.join(", ")}, which package.json no longer has: remove the row(s)`);
});
