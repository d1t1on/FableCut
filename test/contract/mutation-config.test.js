/* Contract: the mutation-testing setup (`npm run mutation`) stays runnable,
   and the threshold AGENTS.md states is the config's (③). Stryker runs only
   weekly (.github/workflows/mutation.yml), so this is what catches a pull
   request that breaks it:
   - every file in stryker.config.json `mutate` exists (the list lives only
     there: docs point to the file, they don't copy it);
   - the command runner runs scripts/mutation-tests.js;
   - the incremental file and the HTML report go under gitignored reports/;
   - the workflow runs `npm run mutation` and uploads reports/mutation/;
   - AGENTS.md → "### Mutation testing" names the same `thresholds.break`. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const CONFIG = JSON.parse(read("stryker.config.json"));
const WHERE = "stryker.config.json";

test("stryker.config.json mutates files that exist, through scripts/mutation-tests.js, into reports/", () => {
  assert.ok(Array.isArray(CONFIG.mutate) && CONFIG.mutate.length, `${WHERE}: \`mutate\` must list the files to mutate`);
  for (const f of CONFIG.mutate) assert.ok(fs.existsSync(path.join(ROOT, f)), `${WHERE} mutates ${f}, which does not exist — fix the path in \`mutate\``);
  assert.equal(CONFIG.testRunner, "command", `${WHERE}: the test runner is the command runner`);
  const script = (CONFIG.commandRunner?.command.match(/^node (\S+)$/) || [])[1];
  assert.equal(script, "scripts/mutation-tests.js", `${WHERE}: commandRunner.command must be "node scripts/mutation-tests.js" (it fixes the seed and runs)`);
  assert.ok(fs.existsSync(path.join(ROOT, script)), `${script} is missing`);
  for (const [key, file] of [["incrementalFile", CONFIG.incrementalFile], ["htmlReporter.fileName", CONFIG.htmlReporter?.fileName]])
    assert.ok(/^reports\//.test(file || ""), `${WHERE}: ${key} must be under reports/ (gitignored), not ${file}`);
});

test("the weekly workflow runs npm run mutation and uploads the report", () => {
  const wf = read(".github/workflows/mutation.yml");
  assert.match(wf, /run: npm run mutation\b/, ".github/workflows/mutation.yml must run `npm run mutation`");
  assert.match(wf, /path: reports\/mutation\//, ".github/workflows/mutation.yml must upload reports/mutation/ (the HTML report)");
  assert.doesNotMatch(wf, /pull_request/, ".github/workflows/mutation.yml is weekly / manual — never a PR check");
});

test("AGENTS.md states the thresholds.break the config has", () => {
  const dev = read("AGENTS.md").split(/^(?=### )/m).find((s) => s.startsWith("### Mutation testing")) || "";
  const stated = (dev.match(/`thresholds\.break` is \*\*(\w+)\*\*/) || [])[1];
  const actual = String(CONFIG.thresholds?.break ?? null);
  assert.equal(stated, actual,
    `AGENTS.md → '### Mutation testing' must say "\`thresholds.break\` is **${actual}**" (${WHERE}); update whichever is stale`);
});
