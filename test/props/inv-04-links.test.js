/* INV-04: the members of a link group (a picture and its per-channel stems)
   always share start, in, duration, props.speed and keyframes.speed — the
   fields syncLinkedTiming owns and the validator's LINK_DESYNC compares —
   whichever lane is disabled and whichever member was edited (D2).
   Split by op family so a failure names exactly the ops that break it. */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const O = require("../support/ops");
const I = require("../support/inv");

function inSync({ doc }) {
  for (const [lg, members] of I.groups(doc.clips)) {
    const [ref, ...rest] = [members.find((c) => c.kind === "video") || members[0], ...members];
    for (const c of rest) {
      if (c === ref) continue;
      for (const k of ["start", "in", "duration"]) I.near(c[k], ref[k], I.EPS, `${lg}: ${c.id}.${k} vs ${ref.id}`);
      assert.equal(c.props?.speed, ref.props?.speed, `${lg}: ${c.id} props.speed vs ${ref.id}`);
      assert.deepEqual(I.speedKeys(c), I.speedKeys(ref), `${lg}: ${c.id} keyframes.speed vs ${ref.id}`);
    }
  }
}

propTest("INV-04a: split, split at IN/OUT, delete, move and inspector timing edits keep link groups in sync", (fc) => {
  I.checkOps(fc, ["split", "splitAtWorkArea", "delete", "move", "setTiming", ...O.F.HELPERS], inSync);
});
propTest("INV-04b: trim to playhead and edge drags keep link groups in sync, speed ramps included", (fc) => {
    I.checkOps(fc, ["trimToPlayhead", "trimL", "trimR", ...O.F.HELPERS], inSync);
  });
propTest("INV-04c: closing a gap keeps link groups in sync when a member sits on a disabled lane", (fc) => {
    I.checkOps(fc, ["closeGap", ...O.F.HELPERS], inSync);
  });
propTest("INV-04d: trim to IN/OUT keeps link groups in sync when a member sits on a disabled lane", (fc) => {
    I.checkOps(fc, ["trimToWorkArea", ...O.F.HELPERS], inSync);
  });
