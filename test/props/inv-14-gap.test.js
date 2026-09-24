/* INV-14: closing a gap shifts later clips left by the gap and nothing else:
   no clip lands before the gap's start, and the members of a link group keep
   their offsets to each other (they move together, disabled lanes or not —
   D2). Gap positions are picked among the aligned gaps (listAlignedGaps) or
   anywhere, in sequences that also toggle lanes and undo / redo. */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const O = require("../support/ops");
const I = require("../support/inv");
const { GAP_EPS } = require("../../core/edit");

const GAPS = ["closeGap", "delete", ...O.F.HELPERS];
const closed = (st) => st.name === "closeGap" && st.r.changed;

propTest("INV-14a: closing a gap never moves a clip before the gap's start", (fc) => {
  I.checkOps(fc, GAPS, (st) => {
    if (!closed(st)) return;
    for (const c of st.doc.clips) {
      const b = st.before.byId.get(c.id);
      if (!b || Math.abs(c.start - b.start) <= I.EPS) continue;
      I.near(b.start - c.start, st.r.gap, GAP_EPS, `${c.id} shifted by the gap`); // ± the clamp at 0
      assert.ok(c.start >= st.info.gapStart - GAP_EPS, `${c.id} moved to ${c.start}, before the gap start ${st.info.gapStart}`);
    }
  });
});

propTest("INV-14b: closing a gap keeps the offsets inside every link group", (fc) => {
    I.checkOps(fc, GAPS, (st) => {
      if (!closed(st)) return;
      for (const [lg, members] of I.groups(st.before.clips)) {
        const now = members.map((m) => st.doc.clips.find((c) => c.id === m.id));
        for (let i = 1; i < members.length; i++)
          I.near(now[i].start - now[0].start, members[i].start - members[0].start, I.EPS, `${lg}: ${members[i].id} offset to ${members[0].id}`);
      }
    });
  });
