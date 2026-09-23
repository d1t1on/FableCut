/* Fast static checks — `npm run check`. Zero dependencies.

   1. `node --check` every JavaScript file the project ships or tests with
      (a syntax error in app.js otherwise only shows up in the browser).
   2. Every JSON file that is read at runtime or by CI parses.
   Exits non-zero with a list of every failure, not just the first. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const rel = (f) => path.relative(ROOT, f);

/* *.js directly under each dir (non-recursive), then recurse into `deep` dirs. */
function jsFiles() {
  const out = [];
  const top = (dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const f of fs.readdirSync(abs)) if (f.endsWith(".js")) out.push(path.join(abs, f));
  };
  const deep = (dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) deep(path.join(dir, e.name));
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  top(".");
  for (const d of ["core", "scripts", "test"]) deep(d);
  return out;
}

const JSON_FILES = [
  "package.json", "server.json", "manifest.json", ".mcp.json", "encoding-profiles.json",
  ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json",
  "schema/project.schema.json",
];
function jsonFiles() {
  const fixtures = path.join(ROOT, "test", "fixtures");
  const extra = fs.existsSync(fixtures)
    ? fs.readdirSync(fixtures).filter((f) => f.endsWith(".json")).map((f) => path.join("test", "fixtures", f))
    : [];
  return [...JSON_FILES, ...extra].map((f) => path.join(ROOT, f));
}

const failures = [];

const js = jsFiles();
for (const f of js) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) failures.push(`syntax  ${rel(f)}\n${(r.stderr || "").trim()}`);
}

const json = jsonFiles();
for (const f of json) {
  try { JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { failures.push(`json    ${rel(f)}: ${e.message}`); }
}

if (failures.length) {
  console.error(failures.join("\n\n"));
  console.error(`\ncheck: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log(`check: ${js.length} JS files and ${json.length} JSON files OK`);
