/* Wall-clock assertions ("validates in under 5 ms") are skipped when
   FABLECUT_NO_TIMING=1. scripts/mutation-tests.js sets it: Stryker's
   instrumented code runs slower, on every core at once, so a timing miss
   there would count as a killed mutant. A real hang still fails there, as
   a Stryker timeout.

     const { TIMING, skipTiming } = require("../support/timing");
     test("…fast", { skip: skipTiming }, () => { … });   // a timing-only test
     if (TIMING) assert.ok(ms < 100, "…");              // one assertion */
"use strict";
const TIMING = process.env.FABLECUT_NO_TIMING !== "1";
module.exports = { TIMING, skipTiming: TIMING ? false : "FABLECUT_NO_TIMING=1: no wall-clock assertions" };
