/* Write manifest.json's `tools` (the MCPB bundle's tool list) from TOOLS in
   mcp-tools.js — each tool's name and its `summary`. Zero dependencies.

   Run:  npm run manifest              (write the file)
         npm run manifest -- --check   (write nothing; exit 1 if the file is stale)

   Only the top-level `tools` array is generated. The rest of the manifest is
   hand-edited and kept byte for byte: the array's text is spliced in place.
   The version fields are checked, not generated: test/contract/versions.test.js. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TOOLS } = require("../mcp-tools.js");

const FILE = path.join(__dirname, "..", "manifest.json");
const rel = path.relative(process.cwd(), FILE) || FILE;

function renderManifest(text = fs.readFileSync(FILE, "utf8")) {
  const tools = TOOLS.map((t) => {
    if (!t.summary) throw new Error(`mcp-tools.js: ${t.name} needs a one-line \`summary\` (manifest.json shows it)`);
    return { name: t.name, description: t.summary };
  });
  const body = "[\n" + tools.map((t) => `    { "name": ${JSON.stringify(t.name)}, "description": ${JSON.stringify(t.description)} }`).join(",\n") + "\n  ]";
  // the top-level key sits at two spaces; scan to its closing bracket, skipping strings
  const key = /\n  "tools":\s*\[/.exec(text);
  if (!key) throw new Error(`${rel} has no top-level "tools": [ … ] — add "tools": [] and run: npm run manifest`);
  const from = key.index + key[0].length - 1;
  let i = from + 1, depth = 1, inStr = false;
  for (; depth && i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  const out = text.slice(0, from) + body + text.slice(i);
  assert.deepEqual(JSON.parse(out).tools, tools, "build-manifest: the spliced tools array did not parse back");
  return out;
}

if (require.main === module) {
  const have = fs.readFileSync(FILE, "utf8");
  const want = renderManifest(have);
  if (process.argv.includes("--check")) {
    if (have !== want) {
      console.error(`${rel} is stale (its tools differ from mcp-tools.js TOOLS) — run: npm run manifest`);
      process.exit(1);
    }
    console.log(`${rel} is up to date`);
  } else {
    fs.writeFileSync(FILE, want);
    console.log(`wrote ${rel}`);
  }
}

module.exports = { renderManifest };
