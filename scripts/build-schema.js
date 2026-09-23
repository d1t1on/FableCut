/* Publish PROJECT_SCHEMA (core/schema.js) as schema/project.schema.json — the
   contract other tools can validate project.json against. Zero dependencies.

   Run:  npm run schema              (write the file)
         npm run schema -- --check   (write nothing; exit 1 if the file is stale)

   Key order is the source order in core/schema.js (deterministic, and props
   stay in DEFAULT_PROPS order), so the output only changes when the schema does. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_SCHEMA } = require("../core/schema.js");

const OUT = path.join(__dirname, "..", "schema", "project.schema.json");
const rel = path.relative(process.cwd(), OUT) || OUT;
const json = JSON.stringify(PROJECT_SCHEMA, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (have !== json) {
    console.error(`${rel} is ${have === null ? "missing" : "stale"} — run: npm run schema`);
    process.exit(1);
  }
  console.log(`${rel} is up to date`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`wrote ${rel}`);
}
