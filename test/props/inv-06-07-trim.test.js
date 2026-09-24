/* INV-06b / INV-07: a trim only removes (or reveals) time at the edge it
   moves. The other edge stays put; over the time both versions share, timed
   clips (video/audio/svg — D5) show the same source time and every clip
   renders the same props; image/text/adjust keep in == 0.
   Trims: trim to playhead (in/out), trim to IN/OUT, left/right edge drags.
   Linked partners are trimmed with the clip, so every clip is checked. */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const O = require("../support/ops");
const I = require("../support/inv");

const TRIMS = [...O.F.TRIM, ...O.F.HELPERS];
const isTrim = (st) => O.F.TRIM.includes(st.name) && st.r.changed;
/* A clip whose link group already disagreed before the op (only another
   bug — BUG-09 / BUG-10 — makes one) is re-synced by any trim; that is not
   the trim's fault, so such clips are left out. */
function wasInSync(before, c) {
  if (!c.linkGroup) return true;
  const ms = before.clips.filter((x) => x.linkGroup === c.linkGroup);
  return ms.every((x) => ["start", "in", "duration"].every((k) => Math.abs(x[k] - ms[0][k]) <= I.EPS));
}
/* Clips present before and after the op: [before, after, retained span]. */
function* kept(st) {
  for (const c of st.doc.clips) {
    const b = st.before.byId.get(c.id);
    if (!b || !wasInSync(st.before, b)) continue;
    const t0 = Math.max(b.start, c.start), t1 = Math.min(I.end(b), I.end(c));
    if (t1 > t0) yield [b, c, t0, t1];
  }
}
function sameMediaTime(filter) {
  return (st) => {
    if (!isTrim(st)) return;
    for (const [b, c, t0, t1] of kept(st)) {
      if (!filter(b)) continue;
      for (const t of I.samples(t0, t1)) I.near(I.mediaAt(c, t), I.mediaAt(b, t, "before"), I.EPS_MEDIA, `${c.id} media time at ${t}`);
    }
  };
}
const av = (c) => c.kind === "video" || c.kind === "audio";

propTest("INV-07a: trims never move the fixed edge", (fc) => {
  I.checkOps(fc, TRIMS, (st) => {
    if (!isTrim(st)) return;
    const { inPoint, outPoint } = st.before;
    for (const [b, c] of kept(st)) {
      const moved = (x, y) => Math.abs(x - y) > I.EPS;
      if (st.name === "trimL" || (st.name === "trimToPlayhead" && st.info.side === "in"))
        assert.ok(!moved(I.end(c), I.end(b)), `${c.id}: end moved ${I.end(b)} → ${I.end(c)}`);
      else if (st.name === "trimR" || st.name === "trimToPlayhead")
        assert.ok(!moved(c.start, b.start), `${c.id}: start moved ${b.start} → ${c.start}`);
      else { // trim to IN/OUT: an edge stays or lands on its marker
        assert.ok(!moved(c.start, b.start) || (inPoint != null && !moved(c.start, inPoint)), `${c.id}: start ${b.start} → ${c.start}`);
        assert.ok(!moved(I.end(c), I.end(b)) || (outPoint != null && !moved(I.end(c), outPoint)), `${c.id}: end ${I.end(b)} → ${I.end(c)}`);
      }
    }
  });
});

propTest("INV-07b: trimmed video/audio at static speed keep the retained media mapping", (fc) => {
  I.checkOps(fc, TRIMS, sameMediaTime((c) => av(c) && !I.hasRamp(c)));
});

propTest("INV-07c: trimmed speed ramps keep the retained media mapping", (fc) => {
    I.checkOps(fc, TRIMS, sameMediaTime((c) => I.TIMED.has(c.kind) && I.hasRamp(c)));
  });

propTest("INV-07d: trimmed svg clips keep the retained animation time (D5)", (fc) => {
    I.checkOps(fc, TRIMS, sameMediaTime((c) => c.kind === "svg" && !I.hasRamp(c)));
  });

const inertInZero = (ops) => (st) => {
  if (!ops.includes(st.name) || !st.r.changed) return;
  for (const c of st.doc.clips) if (I.INERT.has(c.kind)) assert.equal(c.in, 0, `${c.kind} ${c.id}.in`);
};
propTest("INV-07e: trims keep in == 0 on image/text/adjust clips (D5)", (fc) => {
    I.checkOps(fc, TRIMS, inertInZero(O.F.TRIM));
  });
propTest("INV-07f: splits keep in == 0 on image/text/adjust pieces (D5)", (fc) => {
    I.checkOps(fc, [...O.F.SPLIT, ...O.F.HELPERS], inertInZero(O.F.SPLIT));
  });

propTest("INV-06b: trimmed clips render the same props at every retained time, for every ease", (fc) => {
    I.checkOps(fc, TRIMS, (st) => {
      if (!isTrim(st)) return;
      for (const [b, c, t0, t1] of kept(st)) {
        if (!b.keyframes && !c.keyframes) continue;
        for (const t of I.samples(t0, t1)) I.sameAnim(c, b, t, c.id);
      }
    });
  });
