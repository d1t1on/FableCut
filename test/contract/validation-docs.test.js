/* Contract: CLAUDE.md's "## Validation" table documents every validation code
   in core/validate.js with its severity — agents read that table to decide
   what a refused patch means, so it must not drift from CODES. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { CODES } = require("../../core/validate");

test("CLAUDE.md lists every validation code with its severity", () => {
  const md = fs.readFileSync(path.join(__dirname, "..", "..", "CLAUDE.md"), "utf8");
  const section = md.split(/^(?=## )/m).find((s) => s.startsWith("## Validation\n"));
  assert.ok(section, 'CLAUDE.md needs a "## Validation" section');
  const rows = new Map([...section.matchAll(/^\| `([A-Z_]+)` \| ([^|]+?) \|/gm)].map((m) => [m[1], m[2]]));
  const want = { schema: "per field", error: "error", warning: "warning" };
  for (const [code, { severity }] of Object.entries(CODES))
    assert.equal(rows.get(code), want[severity], `${code} should be documented as ${want[severity]}`);
  assert.deepEqual([...rows.keys()].filter((c) => !CODES[c]), [], "the table names codes the validator no longer has");
});
