/* fast-check, configured once for every property test.

   Env (all optional):
     FC_NUM_RUNS  runs per property (default 100; `npm run test:props` uses 1000)
     FC_SEED      replay a failure: the seed fast-check printed
     FC_PATH      …and its shrink path, to jump straight to the counterexample
                  (a path belongs to one property — narrow the run to it:
                  npm run test:props -- --test-name-pattern=INV-14b test/props/inv-14-gap.test.js)

   A failing property throws fast-check's own report — seed, path, shrunk
   counterexample, and the assertion message (which carries the op log) — and
   nothing here catches it, so node:test prints all of it.

   fast-check is a devDependency: without it property tests skip ("run npm
   ci"), unless FABLECUT_REQUIRE_DEV=1 (CI), where they fail instead. */
"use strict";
const test = require("node:test");
const { devDep } = require("./devdep");

const dep = devDep("fast-check");
const fc = dep.mod;

const int = (v) => (v != null && v !== "" && Number.isFinite(+v) ? Math.trunc(+v) : null);
const NUM_RUNS = int(process.env.FC_NUM_RUNS) || 100;
const SEED = int(process.env.FC_SEED);
const PATH = process.env.FC_PATH || null;

if (fc) {
  fc.configureGlobal({
    numRuns: NUM_RUNS,
    ...(SEED != null ? { seed: SEED } : {}),
    ...(PATH ? { path: PATH, endOnFailure: true } : {}),
  });
}

/* test() for a property: skips without fast-check, else runs body(fc).
   opts pass through (a `todo` naming BUG-xx for a known failure). */
function propTest(title, opts, body) {
  if (typeof opts === "function") [body, opts] = [opts, {}];
  test(title, { ...opts, skip: dep.skip || opts.skip }, () => body(dep.need()));
}

module.exports = { fc, skip: dep.skip, need: dep.need, propTest, NUM_RUNS, SEED };
