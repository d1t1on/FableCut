/* INV-05 / INV-06: a split is invisible in playback. The pieces tile the
   original clip exactly, every timed piece (video/audio/svg — D5) shows the
   same source time the original showed at each instant, and the rendered
   props (evalProps without transitions) agree at every retained time.
   Checked after each split / split-at-IN/OUT, in sequences that also toggle
   lanes and undo / redo. */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const A = require("../support/arb");
const O = require("../support/ops");
const I = require("../support/inv");

const SPLITS = [...O.F.SPLIT, ...O.F.HELPERS];
const isSplit = (st) => (st.name === "split" || st.name === "splitAtWorkArea") && st.r.changed;
/* Each pre-split clip with the pieces that descend from it (≥ 1). */
function* splitPieces(st) {
  for (const [id, pieces] of O.lineage(st.doc)) {
    const orig = st.before.byId.get(id);
    if (orig && pieces.length > 1) yield [orig, pieces];
  }
}
function sameMediaTime(filter) {
  return (st) => {
    if (!isSplit(st)) return;
    for (const [orig, pieces] of splitPieces(st)) {
      if (!I.TIMED.has(orig.kind) || !filter(orig)) continue;
      for (const p of pieces) for (const t of I.samples(p.start, I.end(p))) {
        I.near(I.mediaAt(p, t), I.mediaAt(orig, t, "before"), I.EPS_MEDIA, `${p.id} (from ${orig.id}) media time at ${t}`);
      }
    }
  };
}

propTest("INV-05a: split pieces tile the original exactly and, at static speed, keep the media mapping", (fc) => {
  const tiles = (st) => {
    if (!isSplit(st)) return;
    for (const [orig, pieces] of splitPieces(st)) {
      I.near(pieces[0].start, orig.start, I.EPS, `${orig.id}: first piece starts where it did`);
      for (let i = 1; i < pieces.length; i++) I.near(pieces[i].start, I.end(pieces[i - 1]), I.EPS, `${orig.id}: piece ${i} abuts piece ${i - 1}`);
      I.near(I.end(pieces.at(-1)), I.end(orig), I.EPS, `${orig.id}: last piece ends where it did`);
      for (const p of pieces) for (const k of ["kind", "track", "mediaId"]) assert.equal(p[k], orig[k], `${p.id}.${k}`);
    }
  };
  const mapping = sameMediaTime((c) => !I.hasRamp(c));
  I.checkOps(fc, SPLITS, (st) => { tiles(st); mapping(st); });
});

propTest("INV-05b: split pieces of a speed ramp keep the media mapping", (fc) => {
    I.checkOps(fc, SPLITS, sameMediaTime(I.hasRamp));
  });

/* What INV-05, INV-07 and INV-10 lean on: mediaTimeAt of a ramp is
   in + ∫speed dt. The reference integrates exactly (arb.speedIntegral), so
   only mediaTimeAt's 1/120 s trapezoid grid differs from it. */
const exactMediaTime = (c, t) => c.in + A.speedIntegral(c, Math.min(c.duration, Math.max(0, t - c.start)));
propTest("INV-05c: mediaTimeAt of a speed ramp is in + ∫speed dt at every time in the clip", (fc) => {
    fc.assert(fc.property(A.arbProject(), (raw) => {
      for (const c of O.createSession(raw).doc.clips) {
        if (!I.TIMED.has(c.kind) || !I.hasRamp(c)) continue;
        for (const t of I.samples(c.start, I.end(c), 9)) I.near(I.mediaAt(c, t), exactMediaTime(c, t), I.EPS_MEDIA, `${c.id} (${c.duration} s) at ${t}`);
      }
    }));
  });

propTest("INV-06a: split pieces render the same props as the original at every retained time, for every ease", (fc) => {
    I.checkOps(fc, SPLITS, (st) => {
      if (!isSplit(st)) return;
      for (const [orig, pieces] of splitPieces(st)) {
        if (!orig.keyframes) continue;
        for (const p of pieces) for (const t of I.samples(p.start, I.end(p))) I.sameAnim(p, orig, t, `${p.id} (from ${orig.id})`);
      }
    });
  });
