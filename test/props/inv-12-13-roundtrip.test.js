/* INV-12: save ∘ load is idempotent and lossless — what the editor saves
   (serializeProject) and reads back (normalizeProject) is a fixed point after
   one round, and every schema field of a valid project survives it.
   INV-13: determinism — the same input and the same id generator give the
   identical document, however many times it runs. */
"use strict";
const assert = require("node:assert/strict");
const { propTest } = require("../support/fc");
const A = require("../support/arb");
const O = require("../support/ops");
const { serializeProject } = require("../../core/project");

const json = (x) => JSON.parse(JSON.stringify(x));
const save = (doc) => json(serializeProject(doc));
const load = (raw) => A.loadProject(raw); // like a page reload
const sortIds = (list) => [...list].sort();

propTest("INV-12a: normalize ∘ serialize is idempotent — one save/load round reaches a fixed point, before and after edits", (fc) => {
  fc.assert(fc.property(A.arbProject(), O.arbOps(O.F.ALL, { maxLength: 6 }), (raw, ops) => {
    const s = O.play(raw, ops);
    const s1 = save(load(save(s.doc)));
    assert.deepEqual(save(load(s1)), s1);
  }));
});

/* Every field of the raw project, as the schema defines it, comes back from
   load + save. Normalizations the schema documents are allowed: missing props
   filled with defaults, tracks / disabledTracks / markers in display order. */
propTest("INV-12b: loading and saving a valid project preserves every schema field", (fc) => {
    fc.assert(fc.property(A.arbProject(), (raw) => {
      const out = save(load(raw));
      for (const k of ["name", "width", "height", "fps", "background", "revision", "inPoint", "outPoint", "exportFrame", "encodeProfile"])
        if (raw[k] !== undefined) assert.deepEqual(out[k], raw[k], k);
      assert.deepEqual(out.folders, raw.folders || [], "folders");
      assert.deepEqual(out.markers, raw.markers, "markers");
      if (raw.tracks) assert.deepEqual(sortIds(out.tracks.map((t) => `${t.id}:${t.kind}`)), sortIds(raw.tracks.map((t) => `${t.id}:${t.kind}`)), "tracks");
      assert.deepEqual(out.disabledTracks, raw.disabledTracks || [], "disabledTracks");
      assert.deepEqual(out.media, raw.media.map((m) => ({ folderId: null, ...m })), "media");
      assert.equal(out.clips.length, raw.clips.length, "clip count");
      raw.clips.forEach((c, i) => {
        const o = out.clips[i];
        for (const [k, v] of Object.entries(c)) {
          if (k === "props") for (const [p, pv] of Object.entries(v)) assert.deepEqual(o.props[p], pv, `${c.id}.props.${p}`);
          else assert.deepEqual(o[k], v, `${c.id}.${k}`);
        }
      });
    }));
  });

/* After edits, a save + reload must give back the same timeline (link-group
   ids compared up to renaming: which clips share a group must not change). */
function partition(doc) {
  const g = new Map();
  for (const c of doc.clips) if (c.linkGroup) g.set(c.linkGroup, [...(g.get(c.linkGroup) || []), c.id]);
  return sortIds([...g.values()].filter((ids) => ids.length > 1).map((ids) => sortIds(ids).join("+")));
}
const unlinked = (doc) => ({ ...doc, clips: doc.clips.map(({ linkGroup, ...c }) => c) });
propTest("INV-12c: an edited timeline survives save + reload, link groups included", (fc) => {
    // biased toward the ops that can leave a group out of step
    const mix = ["trimToWorkArea", "closeGap", "trimL", "trimR", "split", "move", ...O.F.HELPERS];
    fc.assert(fc.property(A.arbProject(), O.arbOps(mix, { maxLength: 6 }), (raw, ops) => {
      const s = O.play(raw, ops);
      const s1 = save(s.doc), s2 = save(load(s1));
      try {
        assert.deepEqual(unlinked(s2), unlinked(s1), "timeline changed on reload");
        assert.deepEqual(partition(s2), partition(s1), "link groups changed on reload");
      } catch (e) { throw O.explain(e, s); }
    }));
  });

propTest("INV-13: the same project, ops and id generator give the identical document", (fc) => {
  fc.assert(fc.property(A.arbProject(), O.arbOps([...O.F.ALL, "removeMedia", "setTiming"], { maxLength: 10 }), (raw, ops) => {
    const a = O.play(raw, ops), b = O.play(raw, ops);
    assert.deepEqual(b.log, a.log);
    assert.equal(JSON.stringify(b.doc), JSON.stringify(a.doc));
    assert.equal(JSON.stringify(b.history.size()), JSON.stringify(a.history.size()));
  }));
});
