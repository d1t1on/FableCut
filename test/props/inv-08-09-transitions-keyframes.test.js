/* INV-08: every transition fits its clip (duration ≤ clip duration).
   INV-09: keyframes are sorted by t, and every key lies in [0, dur] ± 1e-3,
   except at most ONE anchor before 0 and ONE after dur per channel (D4: an
   anchor keeps the cut segment interpolating exactly). */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const O = require("../support/ops");
const I = require("../support/inv");

const OTHERS = ["closeGap", "delete", "move", ...O.F.HELPERS];

function transitionsFit({ doc }) {
  for (const c of doc.clips) for (const side of ["transitionIn", "transitionOut"]) {
    const tr = c[side];
    if (tr) assert.ok(tr.duration <= c.duration + I.EPS, `${c.id}.${side} ${tr.duration} s > clip ${c.duration} s`);
  }
}
propTest("INV-08a: moves, deletes and gap closes keep transitions inside their clips", (fc) => {
  I.checkOps(fc, OTHERS, transitionsFit);
});
propTest("INV-08b: splits keep transitions inside the pieces", (fc) => {
    I.checkOps(fc, [...O.F.SPLIT, ...O.F.HELPERS], transitionsFit);
  });
propTest("INV-08c: trims keep transitions inside the trimmed clip", (fc) => {
    I.checkOps(fc, [...O.F.TRIM, ...O.F.HELPERS], transitionsFit);
  });

function keyframesFit({ doc }) {
  for (const c of doc.clips) for (const [k, keys] of Object.entries(c.keyframes || {})) {
    let before = 0, after = 0;
    keys.forEach((x, i) => {
      if (i) assert.ok(x.t >= keys[i - 1].t, `${c.id}.${k} unsorted at ${i}`);
      if (x.t < -I.KF_EPS) before++;
      else if (x.t > c.duration + I.KF_EPS) after++;
    });
    assert.ok(before <= 1 && after <= 1, `${c.id}.${k}: ${before} keys before 0 and ${after} past ${c.duration} (one anchor each at most) — t=${keys.map((x) => x.t)}`);
  }
}
propTest("INV-09a: splits, IN/OUT trims, moves, deletes and gap closes keep keyframes sorted and inside the clip", (fc) => {
  I.checkOps(fc, [...O.F.SPLIT, "trimToWorkArea", ...OTHERS], keyframesFit);
});
propTest("INV-09b: trim to playhead keeps keyframes sorted and inside the clip", (fc) => {
    I.checkOps(fc, ["trimToPlayhead", ...O.F.HELPERS], keyframesFit);
  });
propTest("INV-09c: edge drags keep every linked partner's keyframes inside the clip", (fc) => {
    I.checkOps(fc, ["trimL", "trimR", ...O.F.HELPERS], keyframesFit);
  });
