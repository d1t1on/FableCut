/* INV-01 … INV-03: whatever the op sequence, the document stays loadable —
   no new validation errors, ids and references intact, every number finite
   and every clip long enough. Ops: every family (test/support/ops.js F.ALL). */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const O = require("../support/ops");
const I = require("../support/inv");
const { validateProject, newErrors, formatIssues, issueKey } = require("../../core/validate");
const { serializeProject } = require("../../core/project");

const saved = (doc) => I.json(serializeProject(doc));

function noNewErrors(st) {
  st.s.issues0 ??= validateProject(saved(st.before));
  const added = newErrors(st.s.issues0, validateProject(saved(st.doc)));
  assert.equal(added.length, 0, "new errors:\n" + formatIssues(added));
}
propTest("INV-01a: no op sequence adds a validation error (every op but the left-edge drag)", (fc) => {
  I.checkOps(fc, [...O.F.ALL.filter((n) => n !== "trimL"), "removeMedia", "setTiming"], noNewErrors);
});
propTest("INV-01b: dragging a left edge adds no validation error", (fc) => {
    I.checkOps(fc, ["trimL", ...O.F.HELPERS], noNewErrors, { scale: 3 }); // needs a clamp that rounds below 0
  });

/* D4 / D6: a split or trim leaves anchors the validator accepts (one key
   per side outside the clip) and transitions that fit the shorter clip, so
   the editing ops never create these warnings. (An inspector length edit
   keeps its keys as typed, so setTiming is not in the mix.) */
const TIDY = new Set(["KEYFRAME_OUT_OF_RANGE", "KEYFRAMES_UNSORTED", "TRANSITION_TOO_LONG"]);
const tidyKeys = (doc) => new Set(validateProject(saved(doc)).filter((i) => TIDY.has(i.code)).map(issueKey));
propTest("INV-01c: splits, trims and edge drags add no keyframe or transition warning (D4 anchors, D6)", (fc) => {
  I.checkOps(fc, O.F.ALL, (st) => {
    const before = tidyKeys(st.before);
    assert.deepEqual([...tidyKeys(st.doc)].filter((k) => !before.has(k)), [], "new keyframe / transition warnings");
  });
});

propTest("INV-02a: clip and media ids stay unique and every reference resolves", (fc) => {
  I.checkOps(fc, O.F.ALL, ({ doc }) => {
    const lanes = new Set(doc.tracks.map((t) => t.id));
    const media = new Set();
    for (const m of doc.media) { assert.ok(!media.has(m.id), `duplicate media ${m.id}`); media.add(m.id); }
    const ids = new Set();
    for (const c of doc.clips) {
      assert.ok(!ids.has(c.id), `duplicate clip id ${c.id}`);
      ids.add(c.id);
      if (c.kind === "text" || c.kind === "adjust") assert.equal(c.mediaId ?? null, null, `${c.id} mediaId`);
      else assert.ok(media.has(c.mediaId), `${c.id}: mediaId ${c.mediaId} resolves`);
      assert.ok(lanes.has(c.track), `${c.id}: lane ${c.track} exists`);
    }
    for (const id of doc.disabledTracks) assert.ok(lanes.has(id), `disabled lane ${id} exists`);
  });
});

/* Two clips must never share a mutable object: editing one would silently
   edit the other (and undo snapshots would disagree with the screen). */
propTest("INV-02b: no two clips share a mutable object (props, arrays, keyframes, transitions)", (fc) => {
    I.checkOps(fc, O.F.ALL, ({ doc }) => {
      const owner = new Map();
      const walk = (v, id, path) => {
        if (!v || typeof v !== "object") return;
        const prev = owner.get(v);
        assert.ok(prev === undefined || prev === id, `${path} of ${id} is the same object as in ${prev}`);
        owner.set(v, id);
        for (const [k, x] of Object.entries(v)) walk(x, id, `${path}.${k}`);
      };
      for (const c of doc.clips) for (const k of ["props", "keyframes", "transitionIn", "transitionOut"]) walk(c[k], c.id, k);
    }, { scale: 3 }); // array props are rare
  });

propTest("INV-03: every number is finite, start ≥ 0 and duration ≥ MIN_DUR", (fc) => {
  I.checkOps(fc, O.F.ALL, ({ doc }) => {
    const walk = (v, path) => {
      if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} = ${v}`);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(doc, "doc");
    for (const c of doc.clips) {
      assert.ok(c.start >= 0, `${c.id}.start = ${c.start}`);
      assert.ok(c.duration >= I.MIN_DUR - I.EPS, `${c.id}.duration = ${c.duration}`);
    }
  });
});
