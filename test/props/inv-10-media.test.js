/* INV-10: the media bound — in ≥ 0 and in + ∫speed dt ≤ media.duration
   (+1e-3) — holds for every piece of a video/audio clip after an op whenever
   it held for that clip before. Static speed and speed ramps separately:
   a ramp piece kept its shape only once cuts kept anchor keys (BUG-13, D4). */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const O = require("../support/ops");
const I = require("../support/inv");

const EDITS = [...O.F.EDIT, ...O.F.HELPERS];
/* which(b, p): check piece p of pre-op clip b (default: every piece). */
function mediaBound(filter, which = () => true) {
  return (st) => {
    if (!O.F.EDIT.includes(st.name) || !st.r.changed) return;
    for (const [id, pieces] of O.lineage(st.doc)) {
      const b = st.before.byId.get(id);
      if (!b || !(b.kind === "video" || b.kind === "audio") || !filter(b)) continue;
      if (!I.withinMedia(st.before, b, "before")) continue; // only a bound that held
      const m = I.mediaOf(st.doc, b);
      for (const p of pieces) if (which(b, p)) assert.ok(I.withinMedia(st.doc, p), `${p.id} (from ${id}): in ${p.in} + ∫speed = ${I.mediaAt(p, I.end(p))} > media ${m && m.duration}`);
    }
  };
}
/* A shorter clip that lost a speed key past its new end plays a different
   ramp before that end unless the key stays as its anchor (D4, BUG-13). */
const cutsRampKey = (b, p) => (b.keyframes?.speed || []).some((k) => k.t > p.duration + I.KF_EPS);
propTest("INV-10a: every edit keeps a static-speed clip inside its media", (fc) => {
  I.checkOps(fc, EDITS, mediaBound((c) => !I.hasRamp(c)));
});
propTest("INV-10b: splits and left/IN/playhead trims keep a speed-ramped clip inside its media", (fc) => {
    I.checkOps(fc, ["split", "splitAtWorkArea", "trimToPlayhead", "trimToWorkArea", "trimL", ...O.F.HELPERS], mediaBound(I.hasRamp));
  });
propTest("INV-10c: a right-edge drag keeps a speed-ramped clip inside its media (ramp keys kept)", (fc) => {
  I.checkOps(fc, ["trimR", "closeGap", "delete", "move", ...O.F.HELPERS], mediaBound(I.hasRamp, (b, p) => !cutsRampKey(b, p)));
});
propTest("INV-10d: …and so does one that shortens it past a speed key", (fc) => {
    I.checkOps(fc, ["trimR", ...O.F.HELPERS], mediaBound(I.hasRamp, cutsRampKey));
  });
