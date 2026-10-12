/* `npm run test:props` — the property tests (test/props/) at 1000 runs each.

   `npm test` runs them too, at fast-check's 100 runs, to stay quick; this is
   the deeper pass CI runs on its own. The env is set here, not in the npm
   script, so it works in every shell (Windows cmd has no `VAR=1 cmd`).

     FC_NUM_RUNS  override the run count (default 1000)
     FC_SEED      replay a failure: the seed fast-check printed
     FC_PATH      …and its shrink path, straight to the counterexample
   Extra arguments go to `node --test`, e.g. one property to replay:
     FC_SEED=… FC_PATH=… npm run test:props -- --test-name-pattern=INV-14b test/props/inv-14-gap.test.js */
"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const env = { ...process.env, FC_NUM_RUNS: process.env.FC_NUM_RUNS || "1000" };
const r = spawnSync(process.execPath, ["--test", ...(args.length ? args : ["test/props/**/*.test.js"])], { cwd: ROOT, env, stdio: "inherit" });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
