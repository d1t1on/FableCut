/* Contract: CLAUDE.md's "## Validation" table documents every validation code
   in core/validate.js with its severity — agents read that table to decide
   what a refused patch means, so it must not drift from CODES. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { CODES } = require("../../core/validate");

const WHERE = "CLAUDE.md → '## Validation' (the | code | severity | meaning | table)";

test("CLAUDE.md lists every validation code with its severity", () => {
  const md = fs.readFileSync(path.join(__dirname, "..", "..", "CLAUDE.md"), "utf8");
  const section = md.split(/^(?=## )/m).find((s) => s.startsWith("## Validation\n"));
  assert.ok(section, 'CLAUDE.md needs a "## Validation" section with the code table (one row per CODES entry in core/validate.js)');
  const rows = new Map([...section.matchAll(/^\| `([A-Z_]+)` \| ([^|]+?) \|/gm)].map((m) => [m[1], m[2]]));
  const want = { schema: "per field", error: "error", warning: "warning" };
  const wrong = Object.entries(CODES).filter(([code, { severity }]) => rows.get(code) !== want[severity])
    .map(([code, { severity }]) => `| \`${code}\` | ${want[severity]} | … |${rows.has(code) ? ` (the table says "${rows.get(code)}")` : " (no row)"}`);
  assert.deepEqual(wrong, [], `${WHERE}: add or fix these rows (codes and severities are CODES in core/validate.js):\n  ${wrong.join("\n  ")}`);
  const stale = [...rows.keys()].filter((c) => !CODES[c]);
  assert.deepEqual(stale, [], `${WHERE} has rows for ${stale.join(", ")}, which CODES in core/validate.js no longer has: remove them`);
});
