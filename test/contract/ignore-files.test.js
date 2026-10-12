/* Contract: .mcpbignore keeps user data out of the MCPB bundle. The mcpb
   packer does not read .gitignore, so .mcpbignore repeats its user-data
   entries by hand (its header says so); this checks it still covers them (③).
   Source: these .gitignore blocks (a block = a "# <title>" comment and the
   lines under it, up to a blank line). */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const lines = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/);
const BLOCKS = ["Runtime user data", "Sound FX", "Test tooling output"];

/* `media/*` and `media/` exclude the same thing from a bundle. */
const norm = (p) => p.trim().replace(/\/\*$/, "/");
function block(all, title) {
  const at = all.findIndex((l) => l.startsWith("# " + title));
  if (at < 0) return null;
  const end = all.findIndex((l, i) => i > at && !l.trim());
  return all.slice(at + 1, end < 0 ? undefined : end);
}

test(".mcpbignore excludes every user-data pattern .gitignore ignores", () => {
  const git = lines(".gitignore");
  const mcpb = new Set(lines(".mcpbignore").filter((l) => l.trim() && !l.startsWith("#")).map(norm));
  const missing = [];
  for (const title of BLOCKS) {
    const b = block(git, title);
    assert.ok(b, `.gitignore has no "# ${title}" block — restore it, or update BLOCKS in ${path.relative(ROOT, __filename)}`);
    // a negation (!media/.gitkeep) re-includes a placeholder the bundle doesn't need
    for (const p of b.filter((l) => !l.startsWith("#") && !l.startsWith("!")).map(norm)) if (!mcpb.has(p)) missing.push(p);
  }
  assert.deepEqual(missing, [],
    `.mcpbignore lacks ${missing.join(", ")}: add each under the matching heading in .mcpbignore ` +
    "(the packer ignores .gitignore, so anything missing ships in fablecut.mcpb)");
});
