/* core/patch.js: the op interpreter behind MCP fablecut_patch_project and
   REST POST /api/patch — in process, with deterministic id factories. The
   MCP/REST tests keep covering the wire; this pins the semantics. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { OPS, TIMELINE_OPS, describeOps, patchProject, formatPatch, gate, gateNotes, defaultIn } = require("../../core/patch");
const { PATCHABLE_PROJECT_FIELDS, MIN_DUR } = require("../../core/schema");
const { validateProject } = require("../../core/validate");
const { mediaTimeAt } = require("../../core/keyframes");
const E = require("../../core/edit");
const { loadFixture, build } = require("../fixtures");

/* a fresh counter per call: same ops + same doc → same ids */
const ids = () => { let n = 0; return { newId: (p = "c_") => p + ++n, newLinkId: () => "lg_" + ++n }; };
const seed = () => loadFixture("minimal"); // c_a on V1, media m_a (10 s)
const run = (ops, disk = seed(), ctx = ids()) => patchProject(disk, ops, ctx);
const ok = (ops, disk, ctx) => {
  const res = run(ops, disk, ctx);
  assert.equal(res.ok, true, res.error);
  return res;
};
const fails = (ops, re, disk) => {
  const res = run(ops, disk);
  assert.equal(res.ok, false, `should have failed: ${JSON.stringify(ops)}`);
  assert.match(res.error, re);
  return res;
};
const clip = (doc, id) => doc.clips.find((c) => c.id === id);

const NAMES = ["addClip", "updateClip", "removeClip", "addMedia", "removeMedia",
  "splitClip", "trimClip", "moveClip", "closeGap", "setTiming", "setProject"];
test("OPS: one row per op, and describeOps names every one with its params", () => {
  assert.deepEqual(OPS.map((o) => o.name), NAMES);
  assert.deepEqual(TIMELINE_OPS, ["splitClip", "trimClip", "moveClip", "closeGap", "setTiming"], "TIMELINE_OPS: the rows flagged timeline");
  assert.ok(Object.isFrozen(TIMELINE_OPS));
  const text = describeOps();
  for (const o of OPS) {
    assert.equal(typeof o.run, "function");
    assert.ok(o.doc && o.params, `${o.name} needs params and a one-line doc in core/patch.js OPS`);
    assert.ok(text.includes(`{op:'${o.name}', ${o.params}} — ${o.doc}`), `describeOps() is missing the ${o.name} row`);
  }
  assert.equal(text.split("\n").length, OPS.length);
  for (const k of PATCHABLE_PROJECT_FIELDS) assert.match(text, new RegExp(`\\b${k}\\b`));
});

test("addClip: fresh id from ctx, `in` defaulted and counted, payload copied", () => {
  const clipIn = { kind: "text", mediaId: null, track: "V2", start: 1, duration: 2, props: { text: "Hi" } };
  const res = ok([{ op: "addClip", clip: clipIn }, { op: "addClip", clip: { ...clipIn, id: "c_x", in: 0 } }]);
  assert.deepEqual(res.notes, ["+c_1", "+c_x"]);
  assert.equal(res.defaulted, 1);
  assert.deepEqual(clip(res.doc, "c_1"), { ...clipIn, id: "c_1", in: 0 });
  assert.equal(clipIn.id, undefined, "the caller's op is not mutated");
  clipIn.props.text = "changed later";
  assert.equal(clip(res.doc, "c_1").props.text, "Hi", "the doc does not alias the op");
  // footage clips need a registered media; text/adjust need none
  ok([{ op: "addClip", clip: { kind: "adjust", track: "V3", start: 0, duration: 1, props: { shake: 18 } } }]);
  ok([{ op: "addClip", clip: { kind: "video", mediaId: "m_a", track: "V2", start: 0, duration: 1 } }]);
});

test("addClip: generated ids skip any already in use", () => {
  const disk = seed();
  disk.clips.push(build.clip("c_1", { mediaId: "m_a", track: "V2" }));
  disk.clips[1].linkGroup = "c_2"; // a linkGroup counts as taken too
  const res = ok([{ op: "addClip", clip: { kind: "text", track: "V3", start: 0, duration: 1 } }], disk);
  assert.deepEqual(res.notes, ["+c_3"]);
});

test("updateClip: top-level keys replaced, props merged key by key, null deletes", () => {
  const disk = seed();
  Object.assign(disk.clips[0], {
    props: { scale: 2, filterPreset: "noir" }, keyframes: { opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }] }, name: "old",
  });
  const res = ok([{ op: "updateClip", id: "c_a", set: {
    start: 1, name: null, props: { scale: 3, filterPreset: null, opacity: 0.5 },
    keyframes: { scale: [{ t: 0, v: 1 }] }, transitionIn: { type: "fade", duration: 0.5 },
  } }], disk);
  const c = clip(res.doc, "c_a");
  assert.equal(c.start, 1);
  assert.ok(!("name" in c), "null deletes a top-level key");
  assert.deepEqual(c.props, { scale: 3, opacity: 0.5 });
  assert.deepEqual(c.keyframes, { scale: [{ t: 0, v: 1 }] }, "keyframes are replaced wholesale");
  assert.deepEqual(res.notes, ["~c_a"]);
  // a clip without props takes the object as is; echoing the id back is not a rename
  const bare = ok([{ op: "updateClip", id: "c_a", set: { id: "c_a", props: { volume: 0.5 } } }]);
  assert.deepEqual(clip(bare.doc, "c_a").props, { volume: 0.5 });
});

test("removeClip, addMedia, removeMedia", () => {
  const res = ok([
    { op: "removeClip", id: "c_a" },
    { op: "addMedia", media: { kind: "audio", src: "/library/sfx/big%20whoosh.mp3/" } },
    { op: "addMedia", media: { id: "m_b", kind: "image", src: "/media/b.png", name: "Named" } },
    { op: "removeMedia", id: "m_a" },
  ]);
  assert.deepEqual(res.notes, ["-c_a", "+m_1", "+m_b", "-m_a"]);
  assert.deepEqual(res.doc.clips, []);
  assert.deepEqual(res.doc.media.map((m) => [m.id, m.name]), [["m_1", "big whoosh.mp3"], ["m_b", "Named"]]);
});

test("setProject: every patchable field, null deletes, nothing else", () => {
  const set = { name: "New", tracks: [{ id: "V1", kind: "video" }, { id: "A1", kind: "audio" }], inPoint: 1, outPoint: 3 };
  const res = ok([{ op: "setProject", set }]);
  for (const [k, v] of Object.entries(set)) assert.deepEqual(res.doc[k], v);
  assert.deepEqual(res.notes, ["~project"]);
  set.tracks.push({ id: "V2", kind: "video" });
  assert.equal(res.doc.tracks.length, 2, "the doc does not alias the op");
  const cleared = ok([{ op: "setProject", set: { inPoint: null } }], res.doc);
  assert.ok(!("inPoint" in cleared.doc));
  for (const bad of ["revision", "clips", "media", "bogus"])
    fails([{ op: "setProject", set: { [bad]: 1 } }], new RegExp(`^setProject: '${bad}' not settable \\(allowed: ${PATCHABLE_PROJECT_FIELDS.join(", ")}\\)$`));
});

test("setProject: encodeProfile goes through ctx.checkProfile when there is one", () => {
  const checked = [];
  const checkProfile = (id) => { checked.push(id); if (id !== "hq") throw new Error(`Unknown encoding profile "${id}"`); };
  assert.equal(run([{ op: "setProject", set: { encodeProfile: "hq" } }], seed(), { ...ids(), checkProfile }).ok, true);
  const bad = run([{ op: "setProject", set: { encodeProfile: "nope" } }], seed(), { ...ids(), checkProfile });
  assert.equal(bad.error, 'Unknown encoding profile "nope"');
  assert.deepEqual(checked, ["hq", "nope"]);
  // null clears the pin without a lookup; no checkProfile (the browser) skips the check
  assert.equal(run([{ op: "setProject", set: { encodeProfile: null } }], seed(), { ...ids(), checkProfile }).ok, true);
  assert.equal(checked.length, 2);
  assert.equal(ok([{ op: "setProject", set: { encodeProfile: "any" } }]).doc.encodeProfile, "any");
});

test("op errors keep their exact messages", () => {
  const cases = [
    [{ op: "addClip", clip: { mediaId: "m_a", kind: "video", track: "V1" } }, "addClip needs clip{track, start, duration}"],
    [{ op: "addClip", clip: { id: "c_a", mediaId: "m_a", kind: "video", track: "V1", start: 0, duration: 1 } },
      "addClip: duplicate clip id c_a (DUP_CLIP_ID) — omit id to get a fresh one"],
    [{ op: "addClip", clip: { kind: "video", track: "V1", start: 0, duration: 1 } },
      "addClip: unknown mediaId undefined (MEDIA_REQUIRED) — addMedia it first, or use an id from fablecut_get_project {compact:true}"],
    [{ op: "addClip", clip: { kind: "video", mediaId: "m_x", track: "V1", start: 0, duration: 1 } },
      "addClip: unknown mediaId m_x (MEDIA_NOT_FOUND) — addMedia it first, or use an id from fablecut_get_project {compact:true}"],
    [{ op: "updateClip", id: "c_x", set: {} }, "updateClip: no clip c_x"],
    [{ op: "updateClip", id: "c_a", set: { id: "c_b" } },
      "updateClip: clip ids are immutable (can't change c_a to c_b) — removeClip it and addClip a copy under the new id"],
    [{ op: "removeClip", id: "c_x" }, "removeClip: no clip c_x"],
    [{ op: "addMedia", media: { kind: "video" } }, "addMedia needs media{src, kind}"],
    [{ op: "addMedia", media: { id: "m_a", kind: "video", src: "/media/a.mp4" } },
      "addMedia: duplicate media id m_a (DUP_MEDIA_ID) — omit id to get a fresh one"],
    [{ op: "removeMedia", id: "m_a" }, "removeMedia: media m_a is used by clip c_a"],
    [{ op: "removeMedia", id: "m_x" }, "removeMedia: no media m_x"],
    [{ op: "removeClip", id: "c_a", linked: "yes" }, "removeClip: linked must be true or false"],
    [{ op: "removeClip", id: "c_x", linked: true }, "removeClip: no clip c_x"],
    [{ op: "splitClip", t: 1 }, "splitClip needs exactly one of id, ids:[…] or all:true (every clip crossing t)"],
    [{ op: "splitClip", id: "c_a", all: true, t: 1 }, "splitClip needs exactly one of id, ids:[…] or all:true (every clip crossing t)"],
    [{ op: "splitClip", all: false, t: 1 }, "splitClip needs exactly one of id, ids:[…] or all:true (every clip crossing t)"],
    [{ op: "splitClip", ids: [], t: 1 }, "splitClip: ids must be a non-empty array of clip ids"],
    [{ op: "splitClip", ids: "c_a", t: 1 }, "splitClip: ids must be a non-empty array of clip ids"],
    [{ op: "splitClip", ids: ["c_a", "c_x"], t: 1 }, "splitClip: no clip c_x"],
    [{ op: "splitClip", id: "c_a" }, "splitClip needs t: a number of seconds (got undefined)"],
    [{ op: "splitClip", id: "c_a", t: "2" }, 'splitClip needs t: a number of seconds (got "2")'],
    [{ op: "splitClip", id: "c_a", t: 12 }, "splitClip: nothing to split at 12s — c_a spans 0s–5s; t must fall inside, more than 0.05s from its edges"],
    [{ op: "splitClip", all: true, t: 0.03 }, "splitClip: nothing to split at 0.03s — no clip crosses it; t must fall inside a clip, more than 0.05s from its edges"],
    [{ op: "trimClip", id: "c_x", side: "in", t: 1 }, "trimClip: no clip c_x"],
    [{ op: "trimClip", id: "c_a", side: "head", t: 1 }, 'trimClip needs side: "in" (the head moves to t) or "out" (the tail moves to t)'],
    [{ op: "trimClip", id: "c_a", side: "in", t: null }, "trimClip needs t: a number of seconds (got null)"],
    [{ op: "trimClip", id: "c_a", side: "in", t: 0 }, 'trimClip: 0s is at or before the start of c_a (0s) — "in" moves the head later; to move the clip use moveClip'],
    [{ op: "trimClip", id: "c_a", side: "in", t: 4.99 }, "trimClip: nothing to trim at 4.99s — c_a spans 0s–5s; t must fall inside it, more than 0.05s from its end (to lengthen a clip use setTiming)"],
    [{ op: "trimClip", id: "c_a", side: "out", t: 7 }, "trimClip: nothing to trim at 7s — c_a spans 0s–5s; t must fall inside it, more than 0.05s from its start (to lengthen a clip use setTiming)"],
    [{ op: "moveClip", id: "c_x", dt: 1 }, "moveClip: no clip c_x"],
    [{ op: "moveClip", id: "c_a", dt: 1, start: 2 }, "moveClip takes start or dt, not both"],
    [{ op: "moveClip", id: "c_a" }, "moveClip needs start or dt (seconds), and/or track"],
    [{ op: "moveClip", id: "c_a", start: "2" }, 'moveClip needs start: a number of seconds (got "2")'],
    [{ op: "moveClip", id: "c_a", dt: Infinity }, "moveClip needs dt: a number of seconds (got null)"],
    [{ op: "moveClip", id: "c_a", track: "A1" }, "moveClip: c_a is a video clip and A1 is an audio lane — audio clips go on A lanes, every other kind on V lanes"],
    [{ op: "closeGap" }, "closeGap needs t: a number of seconds (got undefined)"],
    [{ op: "closeGap", t: 7 }, "closeGap at 7s: Nothing to close at playhead (t must sit in a gap every targeted lane shares, with clips after it)"],
    [{ op: "setTiming", id: "c_x", start: 1 }, "setTiming: no clip c_x"],
    [{ op: "setTiming", id: "c_a" }, "setTiming needs start and/or duration (seconds)"],
    [{ op: "setTiming", id: "c_a", duration: "4" }, 'setTiming needs duration: a number of seconds (got "4")'],
    [{ op: "frobnicate" }, `Unknown op: frobnicate (${NAMES.join("|")})`],
    [null, `Unknown op: null (${NAMES.join("|")})`],
  ];
  for (const [op, message] of cases) {
    const res = run([op]);
    assert.equal(res.ok, false, JSON.stringify(op));
    assert.equal(res.error, message);
    assert.equal(res.doc, null);
    assert.deepEqual(res.notes, []);
  }
  for (const ops of [undefined, [], "addClip"]) assert.equal(run(ops).error, "`ops` must be a non-empty array");
});

test("the unknown-op error lists the names from OPS", () => {
  assert.ok(run([{ op: "nope" }]).error.endsWith(`(${OPS.map((o) => o.name).join("|")})`));
});

test("all-or-nothing, and the document passed in is never touched", () => {
  const disk = seed();
  const copy = structuredClone(disk);
  const ops = [{ op: "setProject", set: { name: "Half done" } }, { op: "removeClip", id: "c_x" }];
  const res = fails(ops, /no clip c_x/, disk);
  assert.equal(res.doc, null);
  assert.deepEqual(disk, copy);
  ok([{ op: "updateClip", id: "c_a", set: { start: 3 } }], disk);
  assert.deepEqual(disk, copy, "a successful patch returns a new doc; it never writes into the input");
});

test("the validation gate: new errors refuse, errors already on disk never block", () => {
  const res = fails([{ op: "setProject", set: { name: "x" } }, { op: "updateClip", id: "c_a", set: { start: null } }],
    /^REJECTED — nothing saved\. This patch would add 1 validation error:\nerror SCHEMA_REQUIRED clips\[c_a\]\.start/);
  assert.match(res.error, /resend the whole patch — it is all-or-nothing/);
  assert.deepEqual(res.newErrors.map((i) => i.code), ["SCHEMA_REQUIRED"]);
  assert.ok(res.doc, "a refused result still carries the candidate, for dry runs and tests");

  const broken = seed();
  broken.clips.push(build.clip("c_short", { mediaId: "m_a", track: "V2", duration: 0.01 }));
  const renamed = ok([{ op: "setProject", set: { name: "Still editable" } }], broken);
  assert.deepEqual(renamed.newErrors, []);
  const second = fails([{ op: "addClip", clip: { id: "c_b", mediaId: "m_a", kind: "video", track: "V3", start: 0, duration: 0.02 } }],
    /DURATION_TOO_SHORT clips\[c_b\]\.duration/, broken);
  assert.doesNotMatch(second.error, /c_short/);
});

test("new warnings are the delta; gateNotes caps them and names the `in` default", () => {
  const disk = seed();
  disk.clips[0].props = { oldTypo: 1 };
  const res = ok([{ op: "updateClip", id: "c_a", set: { props: { speedd: 2 } } }], disk);
  assert.deepEqual(res.newWarnings.map((i) => i.path), ["clips[c_a].props.speedd"]);
  assert.equal(gateNotes({}), "");
  assert.match(gateNotes(res), /^\nNew warnings \(1\) — saved anyway, worth fixing:\nwarning UNKNOWN_PROP clips\[c_a\]\.props\.speedd: .* — did you mean "speed"\?$/);
  assert.match(gateNotes({ ...res, dryRun: true }), /New warnings \(1\) — would not block/);
  const many = Array.from({ length: 12 }, (_, i) => ({ severity: "warning", code: "UNKNOWN_PROP", path: `p${i}`, message: "m" }));
  assert.match(gateNotes({ defaulted: 2, newWarnings: many }), /^ Defaulted in:0 on 2 clips\.\nNew warnings \(12\)[^]*\n… \+2 more$/);
  assert.equal(gateNotes({ defaulted: 1 }), " Defaulted in:0 on 1 clip.");
});

test("gate on its own (set_project): a document refusal says to resend the document", () => {
  const doc = seed();
  doc.clips.push({ ...doc.clips[0] });
  const g = gate(validateProject(seed()), doc, "document");
  assert.deepEqual(g.newErrors.map((i) => i.code), ["DUP_CLIP_ID"]);
  assert.match(g.message, /resend the complete document\./);
  assert.equal(gate([], seed()).message, null, "no disk issues (unreadable file) is an empty baseline");
  assert.equal(defaultIn([{}, { in: 2 }, null, { in: null }]), 2);
});

test("diff and formatted result; dryRun only changes the wording", () => {
  const ops = [{ op: "updateClip", id: "c_a", set: { start: 2 } },
    { op: "addClip", clip: { kind: "text", track: "V2", start: 0, duration: 1, props: { text: "Hi" } } }];
  const res = ok(ops);
  assert.deepEqual(res.diff, ["~c_a start: 0→2", '+c_1 V2 0s+1s text {"text":"Hi"}']);
  assert.equal(formatPatch(res, { revision: 2 }),
    "Patched (revision 2): ~c_a; +c_1. Now 2 clip(s), 1 media. UI hot-reloaded. Defaulted in:0 on 1 clip.\n" +
    "Changes:\n  ~c_a start: 0→2\n  +c_1 V2 0s+1s text {\"text\":\"Hi\"}");
  const dry = run(ops, seed(), { ...ids(), dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.doc, res.doc, "a dry run computes the same document");
  assert.match(formatPatch(dry, { revision: 2 }), /^DRY RUN — nothing saved\.\nPatched \(revision 2\): ~c_a; \+c_1\. Now 2 clip\(s\), 1 media\. Defaulted/);
  const same = ok([{ op: "updateClip", id: "c_a", set: { start: 0 } }]);
  assert.match(formatPatch(same, { revision: 2 }), /\nChanges: none$/);
  const adds = Array.from({ length: 25 }, (_, i) => ({ op: "addClip", clip: { kind: "text", track: "V2", start: i, duration: 1 } }));
  const many = ok(adds);
  assert.equal(many.diff.length, 21, "the diff is capped at 20 lines by default");
  assert.equal(many.diff[20], "… +5 more");
  assert.equal(run(adds, seed(), { ...ids(), diffLimit: 50 }).diff.length, 25);
});

test("deterministic: the same ops on the same doc with fresh counters give the same result", () => {
  const ops = [{ op: "addMedia", media: { kind: "audio", src: "/media/s.mp3", duration: 4 } },
    { op: "addClip", clip: { kind: "audio", mediaId: "m_1", track: "A1", start: 0, duration: 4 } }];
  assert.deepEqual(run(ops), run(ops));
  assert.deepEqual(run(ops).notes, ["+m_1", "+c_2"]);
});

test("ctx id factories: required only when an op needs one, and must make progress", () => {
  const addText = [{ op: "addClip", clip: { kind: "text", track: "V2", start: 0, duration: 1 } }];
  assert.equal(patchProject(seed(), [{ op: "setProject", set: { name: "x" } }]).ok, true, "no ctx is fine for ops that create nothing");
  assert.equal(patchProject(seed(), addText).error, "FableCore.patch: ctx.newId must be a function");
  assert.equal(patchProject(seed(), addText, { newId: () => "c_a" }).error, "FableCore.patch: ctx.newId returned 100 ids already in use");
});

/* ── Timeline ops: the editor's own edits (core/edit) ──
   test/props/inv-15-patch-equivalence.test.js checks each against the UI path
   on generated projects; these pin the notes, the errors and the edge cases. */
const av = () => loadFixture("linked-av"); // c_v/c_l/c_r [0, 8] in 2 (lg_cam), a gap, c_v2/c_l2/c_r2 [10, 14], c_song A3 [0, 14]
const timing = (doc, id) => { const c = clip(doc, id); return [c.start, c.in, c.duration]; };

test("splitClip id: the clip and its link group, right pieces linked to each other; the note maps each cut", () => {
  const res = ok([{ op: "splitClip", id: "c_l", t: 3 }], av());
  assert.deepEqual(res.notes, ["split at 3s: c_l→+c_1, c_v→+c_2, c_r→+c_3"], "the selection first, then its partners, like the editor's split");
  for (const id of ["c_v", "c_l", "c_r"]) assert.deepEqual(timing(res.doc, id), [0, 2, 3], id);
  for (const id of ["c_1", "c_2", "c_3"]) {
    assert.deepEqual(timing(res.doc, id), [3, 5, 5], id);
    assert.equal(clip(res.doc, id).linkGroup, "lg_4", "the right pieces form a new group");
  }
  assert.equal(clip(res.doc, "c_song").duration, 14, "a selection leaves other clips alone");
  assert.deepEqual(res.diff, [
    "~c_v duration: 8→3", "~c_l duration: 8→3", "~c_r duration: 8→3",
    '+c_1 A1 3s+5s audio(m_cam in:5) link:lg_4 "cam" {"audioChannel":0,"pan":-1}',
    '+c_2 V1 3s+5s video(m_cam in:5) link:lg_4 "cam" {"volume":0}',
    '+c_3 A2 3s+5s audio(m_cam in:5) link:lg_4 "cam" {"audioChannel":1,"pan":1}',
  ], "the diff alone shows the cut: new lengths, new pieces, their link group");
  assert.deepEqual(res.newWarnings, []);
});

test("splitClip ids / all: a selection, or every clip crossing t (clips t misses are skipped)", () => {
  const sel = ok([{ op: "splitClip", ids: ["c_song", "c_v2"], t: 4 }], av());
  assert.deepEqual(sel.notes, ["split at 4s: c_song→+c_1"], "c_v2 doesn't cross 4 s: skipped, like the editor");
  const all = ok([{ op: "splitClip", all: true, t: 4 }], av());
  assert.deepEqual(all.notes, ["split at 4s: c_v→+c_1, c_l→+c_2, c_r→+c_3, c_song→+c_4"]);
  assert.equal(clip(all.doc, "c_4").linkGroup, undefined, "an unlinked clip stays unlinked");
  // "all" is the editor's split with nothing selected
  const d = av(), n = { v: 0 };
  const r = E.splitAt(d, 4, {}, { newId: () => "c_" + ++n.v, newLinkId: () => "lg_" + ++n.v, isEnabled: () => true });
  assert.deepEqual(all.doc.clips, JSON.parse(JSON.stringify(d.clips)));
  assert.equal(r.created.length, 4);
});

test("splitClip on a ramped linked clip: in follows the ramp, keyframes keep anchors, transitions fit", () => {
  const disk = loadFixture("keyframes-transitions");
  const res = ok([{ op: "splitClip", id: "c_b", t: 8.8 }], disk);
  const [left, right] = [clip(res.doc, "c_b"), clip(res.doc, "c_1")];
  assert.equal(left.transitionOut, undefined, "the cut edge has no transition");
  assert.equal(left.transitionIn.duration, 1);
  assert.equal(right.transitionOut.type, "fade");
  assert.ok(Math.abs(right.transitionOut.duration - 0.2) < 1e-9, "the outer transition fits the 0.2 s piece");
  assert.deepEqual(res.newWarnings, []);
});

test("trimClip: head or tail of the whole group, keyframes re-based, the trimmed edge's transition dropped", () => {
  const res = ok([{ op: "trimClip", id: "c_l", side: "in", t: 3 }, { op: "trimClip", id: "c_v", side: "out", t: 6 }], av());
  assert.deepEqual(res.notes, ["trimmed c_l in to 3s: ~c_l ~c_v ~c_r", "trimmed c_v out to 6s: ~c_v ~c_l ~c_r"]);
  for (const id of ["c_v", "c_l", "c_r"]) assert.deepEqual(timing(res.doc, id), [3, 5, 3], id);
  const kt = ok([{ op: "trimClip", id: "c_a", side: "out", t: 4.5 }], loadFixture("keyframes-transitions"));
  const a = clip(kt.doc, "c_a");
  assert.equal(a.transitionOut, undefined, "trim to playhead drops the trimmed edge's transition (D6)");
  assert.deepEqual(a.keyframes.scale.map((k) => k.t), [0, 5], "one anchor past the new end (D4)");
  assert.deepEqual(kt.diff, ["~c_a duration: 5→4.5, transitionOut: whip/0.25→∅"]);
});

test("moveClip: start / dt shift the whole link group (clamped at 0); track moves only the named clip", () => {
  const res = ok([{ op: "moveClip", id: "c_v", dt: 1.5 }, { op: "moveClip", id: "c_l2", start: 12 }], av());
  assert.deepEqual(res.notes, ["moved c_v by +1.5s to 1.5s: ~c_v ~c_l ~c_r", "moved c_l2 by +2s to 12s: ~c_l2 ~c_v2 ~c_r2"]);
  for (const id of ["c_v", "c_l", "c_r"]) assert.equal(clip(res.doc, id).start, 1.5, id);
  for (const id of ["c_v2", "c_l2", "c_r2"]) assert.equal(clip(res.doc, id).start, 12, id);
  assert.equal(clip(res.doc, "c_song").start, 0);

  const clamped = ok([{ op: "moveClip", id: "c_v2", dt: -20 }], av());
  assert.deepEqual(clamped.notes, ["moved c_v2 by -10s to 0s (clamped at 0): ~c_v2 ~c_l2 ~c_r2"]);

  const lane = ok([{ op: "moveClip", id: "c_v", track: "V2", dt: 1 }], av());
  assert.deepEqual(lane.notes, ["moved c_v by +1s to 1s, lane V1→V2: ~c_v ~c_l ~c_r"]);
  assert.deepEqual([clip(lane.doc, "c_v").track, clip(lane.doc, "c_l").track], ["V2", "A1"], "partners keep their lanes, like a drop");
  assert.deepEqual(ok([{ op: "moveClip", id: "c_l", track: "A4" }], av()).notes, ["moved c_l lane A1→A4: ~c_l"]);
  for (const op of [{ dt: 0 }, { start: 0 }, { track: "V1" }, { dt: -3 }])
    assert.deepEqual(ok([{ op: "moveClip", id: "c_v", ...op }], av()).notes, ["c_v unchanged"], JSON.stringify(op));
});

test("moveClip track: only a lane the editor shows (declare a new one first), and only of the clip's kind", () => {
  const res = run([{ op: "moveClip", id: "c_v", track: "V6" }], av());
  const hint = '{op:"setProject", set:{tracks:[{"id":"V3","kind":"video"},{"id":"V2","kind":"video"},{"id":"V1","kind":"video"},' +
    '{"id":"A1","kind":"audio"},{"id":"A2","kind":"audio"},{"id":"A3","kind":"audio"},{"id":"A4","kind":"audio"},{"id":"V6","kind":"video"}]}}';
  assert.equal(res.error, `moveClip: no lane "V6" (lanes: V3 V2 V1 A1 A2 A3 A4) — declare it first, in the same patch: ${hint}`);
  // the hint works as written, and leaves no TRACK_UNDECLARED behind
  const set = JSON.parse(hint.replace("op:", '"op":').replace("set:", '"set":').replace("tracks:", '"tracks":'));
  const declared = ok([set, { op: "moveClip", id: "c_v", track: "V6" }], av());
  assert.equal(clip(declared.doc, "c_v").track, "V6");
  assert.deepEqual(declared.newWarnings, []);
  // a lane some clip already sits on is shown by the editor even when undeclared (legacy: c_far on V5)
  const legacy = ok([{ op: "moveClip", id: "c_bare", track: "V5" }], loadFixture("legacy"));
  assert.equal(clip(legacy.doc, "c_bare").track, "V5");
  assert.match(run([{ op: "moveClip", id: "c_ob", track: "V5" }], loadFixture("legacy")).error,
    /^moveClip: c_ob is an audio clip and V5 is a video lane/);
  assert.match(run([{ op: "moveClip", id: "c_a", track: 3 }]).error, /^moveClip: no lane 3 \(lanes: /);
});

test("closeGap: the editor's close gap — sync-safe over enabled lanes, link groups move whole, the toast's wording on refusal", () => {
  const disk = av();
  const covered = run([{ op: "closeGap", t: 9 }], disk);
  assert.equal(covered.error, "closeGap at 9s: No gap on A3 — untarget the track or move the playhead " +
    "(untarget it with setProject untargetedTracks, or pick another t)");
  assert.match(run([{ op: "closeGap", t: 4 }], disk).error, /^closeGap at 4s: No gap on V1 — /, "the first covered lane in display order (V3…V1, A1…)");
  const res = ok([{ op: "setProject", set: { untargetedTracks: ["A3"] } }, { op: "closeGap", t: 9 }], disk);
  assert.deepEqual(res.notes, ["~project", "closed 2s gap at 9s: ~c_v2 ~c_l2 ~c_r2"]);
  for (const id of ["c_v2", "c_l2", "c_r2"]) assert.equal(clip(res.doc, id).start, 8, id);
  const none = run([{ op: "setProject", set: { untargetedTracks: ["V3", "V2", "V1", "A1", "A2", "A3", "A4"] } }, { op: "closeGap", t: 9 }], disk);
  assert.equal(none.error, "closeGap at 9s: No targeted tracks (every lane is untargeted or locked)");
  // same words as the editor's toast (core/edit closeGapMessage, one source)
  assert.ok(covered.error.includes(E.closeGapMessage({ changed: false, reason: "covered", trackId: "A3" })));
});

test("setTiming: the inspector's start / length for the whole group, clamped like the inspector", () => {
  const res = ok([{ op: "setTiming", id: "c_l", start: 1, duration: 5 }], av());
  assert.deepEqual(res.notes, ["timing c_l: ~c_l ~c_v ~c_r"]);
  for (const id of ["c_v", "c_l", "c_r"]) assert.deepEqual(timing(res.doc, id), [1, 2, 5], id);
  const clamped = ok([{ op: "setTiming", id: "c_v", start: -2, duration: 0.001 }], av());
  assert.deepEqual(clamped.notes, ["timing c_v (start, duration clamped): ~c_v ~c_l ~c_r"]);
  assert.deepEqual(timing(clamped.doc, "c_r"), [0, 2, MIN_DUR]);
  assert.deepEqual(ok([{ op: "setTiming", id: "c_v", start: 0 }], av()).notes, ["c_v unchanged"]);
  // a drifted partner is re-synced to the clip that was set (in and speed too)
  const drift = av();
  clip(drift, "c_r").in = 3;
  const synced = ok([{ op: "setTiming", id: "c_v", duration: 7 }], drift);
  assert.deepEqual(timing(synced.doc, "c_r"), [0, 2, 7]);
});

test("removeClip linked:true deletes the whole link group; without it only that clip goes", () => {
  const res = ok([{ op: "removeClip", id: "c_l", linked: true }], av());
  assert.deepEqual(res.notes, ["-c_l -c_v -c_r"]);
  assert.deepEqual(res.doc.clips.map((c) => c.id), ["c_v2", "c_l2", "c_r2", "c_song"]);
  assert.deepEqual(ok([{ op: "removeClip", id: "c_l", linked: false }], av()).notes, ["-c_l"]);
  assert.deepEqual(res.diff, ["-c_v", "-c_l", "-c_r"]);
});

test("timeline ops read the doc as the editor loads it: `in` defaulted, links completed (D1)", () => {
  // legacy: c_ov/c_oa pairwise linkedId, c_ob matches their media and timing unlinked, c_bare has no `in`
  const res = ok([{ op: "splitClip", id: "c_ov", t: 3 }], loadFixture("legacy"));
  assert.deepEqual(res.notes, ["split at 3s: c_ov→+c_1, c_oa→+c_2, c_ob→+c_3"], "the stem the editor would link is cut too");
  assert.equal(res.defaulted, 1);
  for (const id of ["c_ov", "c_oa", "c_ob"]) assert.equal(clip(res.doc, id).linkGroup, "lg_c_ov", id);
  assert.ok(res.doc.clips.every((c) => !("linkedId" in c)));
  assert.ok(res.diff.includes('~c_ov duration: 6→3, linkGroup: ∅→"lg_c_ov", linkedId: "c_oa"→∅'), res.diff.join("\n"));
  // the plain ops never relink (their behavior is unchanged)
  const plain = ok([{ op: "removeClip", id: "c_bare" }], loadFixture("legacy"));
  assert.equal(clip(plain.doc, "c_ov").linkedId, "c_oa");
  // a doc whose clips aren't objects is refused up front, not half-edited
  const junk = seed();
  junk.clips.push(null);
  assert.equal(run([{ op: "closeGap", t: 7 }], junk).error,
    "closeGap: project.clips must be an array of clip objects — fablecut_validate names the bad entry");
});

test("timeline ops are deterministic for injected ids, and all-or-nothing", () => {
  const ops = [{ op: "splitClip", all: true, t: 4 }, { op: "moveClip", id: "c_v2", dt: -1 }, { op: "trimClip", id: "c_3", side: "out", t: 6 },
    { op: "setProject", set: { untargetedTracks: ["A3"] } }, { op: "closeGap", t: 8.5 }, { op: "setTiming", id: "c_song", duration: 12 },
    { op: "removeClip", id: "c_2", linked: true }];
  const a = ok(ops, av()), b = ok(ops, av());
  assert.deepEqual(a, b);
  assert.deepEqual(a.notes, [
    "split at 4s: c_v→+c_1, c_l→+c_2, c_r→+c_3, c_song→+c_4",
    "moved c_v2 by -1s to 9s: ~c_v2 ~c_l2 ~c_r2",
    "trimmed c_3 out to 6s: ~c_3 ~c_1 ~c_2",
    "~project",
    "closed 3s gap at 8.5s: ~c_v2 ~c_l2 ~c_r2",
    "timing c_song: ~c_song",
    "-c_2 -c_1 -c_3",
  ]);
  assert.deepEqual(validateProject(a.doc).filter((i) => i.severity === "error"), []);
  const disk = av(), copy = structuredClone(disk);
  const half = run([{ op: "splitClip", id: "c_v", t: 4 }, { op: "splitClip", id: "c_v2", t: 4 }], disk);
  assert.equal(half.ok, false);
  assert.equal(half.doc, null, "the first split is not kept");
  assert.deepEqual(disk, copy);
});

/* Exit criterion of Phase 4: on a speed-ramped linked AV clip, a split, a trim
   and a move are each ONE op, with zero validation errors, the link group in
   sync (INV-04) and the media mapping kept (INV-05: mediaTimeAt ± 1e-3). */
test("exit criterion: splitClip / trimClip / moveClip on a speed-ramped linked AV clip — one op each, valid, in sync, media mapping kept", () => {
  const disk = loadFixture("speed-ramp"); // c_ramp (V1) + c_ramp_l / c_ramp_r stems, lg_run, [0, 6] from in 1, speed 1 → 3
  const orig = clip(disk, "c_ramp");
  const media = (c, t) => mediaTimeAt({ ...c, id: Symbol("probe") }, t);
  const inSync = (doc) => {
    const groups = new Map();
    for (const c of doc.clips) if (c.linkGroup) groups.set(c.linkGroup, [...(groups.get(c.linkGroup) || []), c]);
    for (const [g, members] of groups) {
      const key = (c) => JSON.stringify([c.start, c.in, c.duration, c.props?.speed ?? 1, c.keyframes?.speed ?? null]);
      assert.equal(new Set(members.map(key)).size, 1, `INV-04: ${g} out of sync`);
    }
    return groups;
  };
  const noErrors = (doc) => assert.deepEqual(validateProject(doc).filter((i) => i.severity === "error"), []);
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-3, `${msg}: ${a} vs ${b}`);

  const split = ok([{ op: "splitClip", id: "c_ramp_l", t: 2.5 }], disk);
  assert.equal(split.notes.length, 1);
  noErrors(split.doc);
  const groups = inSync(split.doc);
  assert.equal(groups.size, 2, "the left pieces keep lg_run, the right pieces share a new group");
  const pieces = split.doc.clips.filter((c) => c.kind === "video" && c.mediaId === "m_run" && c.id !== "c_fast");
  assert.deepEqual(pieces.map((c) => [c.start, c.duration]), [[0, 2.5], [2.5, 3.5]]);
  for (const p of pieces)
    for (let t = p.start; t <= p.start + p.duration + 1e-9; t += p.duration / 8) near(media(p, t), media(orig, t), `INV-05 ${p.id} at ${t}`);

  const trim = ok([{ op: "trimClip", id: "c_ramp_r", side: "in", t: 1.5 }], disk);
  noErrors(trim.doc);
  inSync(trim.doc);
  const trimmed = clip(trim.doc, "c_ramp");
  assert.deepEqual([trimmed.start, trimmed.duration], [1.5, 4.5]);
  for (let t = 1.5; t <= 6; t += 0.5) near(media(trimmed, t), media(orig, t), `trimmed at ${t}`);

  const move = ok([{ op: "moveClip", id: "c_ramp", dt: 1.25 }], disk);
  noErrors(move.doc);
  inSync(move.doc);
  const moved = clip(move.doc, "c_ramp");
  for (let t = 0; t <= 6; t += 0.5) near(media(moved, t + 1.25), media(orig, t), `moved at ${t}`);
  for (const res of [split, trim, move]) assert.deepEqual(res.newWarnings, []);
});
