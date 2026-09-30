/* The test command Stryker runs once per mutant (stryker.config.json →
   commandRunner.command; `npm run mutation` starts Stryker). Exit 0 = the
   mutant survived, non-zero = a test killed it.

   Deterministic on purpose: the property tests run FC_NUM_RUNS=25 cases
   from one fixed FC_SEED, so a mutant's verdict never depends on which
   random cases fast-check drew (an FC_SEED / FC_PATH from a replay in your
   shell is ignored), and FABLECUT_NO_TIMING=1 skips the wall-clock
   assertions (test/support/timing.js): instrumented code on every core is
   slow, and a timing miss would count as a kill. The env is set here, not
   in the command, so it works in every shell.

   Runs test/core/ and test/props/, the suites that require core/ directly,
   minus test/core/dual-mode.test.js: Stryker declares its helpers at the top
   of each mutated file, which that test rightly reports as leaked browser
   globals (it checks the wrapper, not behavior). All files share one process
   (--test-isolation=none, where node has it): a fraction of the CPU per
   mutant, and none of these suites keeps cross-file state. The dot reporter
   keeps the output Stryker stores per killed mutant small (only failures are
   spelled out). Extra arguments go to `node --test`. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SEED = "424242"; // any fixed seed; changing it re-rolls every property's cases
const SKIP = new Set(["test/core/dual-mode.test.js"]);

const files = ["test/core", "test/props"].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".test.js")).sort().map((f) => `${dir}/${f}`))
  .filter((f) => !SKIP.has(f));
const isolation = process.allowedNodeEnvironmentFlags.has("--test-isolation") ? ["--test-isolation=none"] : [];
const env = { ...process.env, FC_NUM_RUNS: "25", FC_SEED: SEED, FABLECUT_NO_TIMING: "1" };
delete env.FC_PATH;
const args = ["--test", ...isolation, "--test-reporter=dot", ...process.argv.slice(2), ...files];
const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: "inherit" });
if (r.error) throw r.error;
process.exit(r.status ?? 1);
