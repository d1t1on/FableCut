/* Contract: generated copies match their source (②). CI's check job runs the
   same three commands; this runs them in `npm test` too, so a stale copy
   shows up before a push. Each script's own message names the command that
   regenerates the copy. */
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const CHECKS = [
  ["schema/project.schema.json from core/schema.js", "scripts/build-schema.js"],
  ["manifest.json tools from mcp-tools.js TOOLS", "scripts/build-manifest.js"],
  ["docs/demo/ from index.html, app.js, style.css and core/", "docs/demo/sync.js"],
];

const run = (script) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [script, "--check"], { cwd: ROOT });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  p.on("error", reject);
  p.on("close", (code) => resolve({ code, out: out.trim() }));
});

for (const [what, script] of CHECKS) {
  test(`generated copy is fresh: ${what} (${script} --check)`, async () => {
    const { code, out } = await run(script);
    assert.equal(code, 0, out);
  });
}
