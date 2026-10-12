/* Fast static checks — `npm run check`. Zero dependencies.

   1. `node --check` every JavaScript file (a syntax error in app.js or a
      docs/ page script otherwise only shows up in the browser).
   2. Every JSON file parses.
   The file list is derived, not kept by hand (①): every *.js / *.json file
   git tracks or would add (git ls-files --cached --others --exclude-standard),
   so a new file is checked the day it appears. Outside a git checkout it
   falls back to walking the repo, skipping node_modules/ and what .gitignore
   lists. Exits non-zero with a list of every failure, not just the first. */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

function gitFiles() {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.js", "*.json"],
    { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : null;
}
/* No git: every file except node_modules/, .git/ and the simple .gitignore patterns. */
function walkFiles() {
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => new RegExp("^" + l.replace(/\/\*?$/, "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + (l.endsWith("/") || l.endsWith("/*") ? "" : "(/|$)")));
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.name === "node_modules" || e.name === ".git" || ignore.some((re) => re.test(e.isDirectory() ? rel + "/" : rel))) continue;
      if (e.isDirectory()) walk(rel);
      else if (/\.(js|json)$/.test(e.name)) out.push(rel);
    }
  };
  walk(".");
  return out.map((f) => f.replace(/^\.\//, ""));
}

const files = (gitFiles() || walkFiles()).filter((f) => fs.existsSync(path.join(ROOT, f))).sort();
const js = files.filter((f) => f.endsWith(".js"));
const json = files.filter((f) => f.endsWith(".json"));
const failures = [];

for (const f of json) {
  try { JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); }
  catch (e) { failures.push(`json    ${f}: ${e.message}`); }
}

/* node --check, a few at a time (one process per file) */
const syntax = (f) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["--check", path.join(ROOT, f)]);
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => resolve(code === 0 ? null : `syntax  ${f}\n${err.trim()}`));
});
(async () => {
  const queue = [...js];
  const worker = async () => { while (queue.length) { const r = await syntax(queue.shift()); if (r) failures.push(r); } };
  await Promise.all(Array.from({ length: Math.min(8, os.cpus().length || 1) }, worker));
  if (failures.length) {
    console.error(failures.sort().join("\n\n"));
    console.error(`\ncheck: ${failures.length} problem(s) — fix each file above (the message gives the line), then re-run: npm run check`);
    process.exit(1);
  }
  console.log(`check: ${js.length} JS files and ${json.length} JSON files OK`);
})();
