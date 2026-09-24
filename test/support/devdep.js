/* Optional dev dependencies (ajv, fast-check, …).

   The runtime is zero-dependency; devDependencies are test-only tooling that
   `npm ci` installs. A test that needs one SKIPS locally when it is missing
   ("run npm ci"), so `git clone && npm test` still works. CI sets
   FABLECUT_REQUIRE_DEV=1: then nothing skips, and `need()` fails the test
   with the same hint instead.

     const dep = devDep("fast-check");
     test("…", { skip: dep.skip }, () => { const fc = dep.need(); … });

   `load` overrides how the module is required (e.g. a sub-path export). */
"use strict";
const assert = require("node:assert/strict");

const REQUIRE_DEV = process.env.FABLECUT_REQUIRE_DEV === "1";

function devDep(name, load = () => require(name)) {
  let mod = null;
  try { mod = load(); } catch { /* optional: reported through skip / need() */ }
  return {
    mod,
    skip: mod || REQUIRE_DEV ? false : `${name} is not installed — run npm ci`,
    need() {
      assert.ok(mod, `${name} is not installed and FABLECUT_REQUIRE_DEV=1 — run npm ci`);
      return mod;
    },
  };
}

module.exports = { devDep, REQUIRE_DEV };
