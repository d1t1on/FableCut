/* core/links.js — AV links over an explicit clip array: partner lookup,
   group expansion, timing sync, relink on load and after a split.
   test/edit-ops.test.js runs these through app.js's wrappers; this file pins
   the pure API. (Phase 3 fixed every bug the "current behavior" tests used
   to pin; a new known bug gets a test marked the same way.) */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const L = require("../../core/links");

const clip = (id, over = {}) => ({ id, kind: "video", track: "V1", start: 0, in: 0, duration: 4, props: {}, ...over });
/* Picture + L/R stems sharing one linkGroup, a legacy pair, a loose clip. */
function clips() {
  return [
    clip("v", { mediaId: "m", linkGroup: "g" }),
    clip("l", { kind: "audio", track: "A1", mediaId: "m", linkGroup: "g" }),
    clip("r", { kind: "audio", track: "A2", mediaId: "m", linkGroup: "g" }),
    clip("pv", { mediaId: "p", linkedId: "pa", start: 10 }),
    clip("pa", { kind: "audio", track: "A3", mediaId: "p", linkedId: "pv", start: 10 }),
    clip("x", { kind: "text", track: "V2" }),
  ];
}
const ids = (list) => list.map((c) => c.id);
const counter = (prefix = "lg_n") => { let n = 0; const f = () => prefix + ++n; return f; };

test("linkedClip: the legacy partner by linkedId, else null / undefined", () => {
  const cs = clips();
  assert.equal(L.linkedClip(cs, cs[3]), cs[4]);
  assert.equal(L.linkedClip(cs, cs[0]), null, "linkGroup members have no pairwise partner");
  assert.equal(L.linkedClip(cs, null), null);
  assert.equal(L.linkedClip(cs, clip("q", { linkedId: "gone" })), undefined, "dangling id");
});

test("withLinked: expands linkGroups and legacy pairs, each clip once, list order first", () => {
  const cs = clips();
  assert.deepEqual(ids(L.withLinked(cs, [cs[1]])), ["l", "v", "r"]);
  assert.deepEqual(ids(L.withLinked(cs, [cs[4]])), ["pa", "pv"]);
  assert.deepEqual(ids(L.withLinked(cs, [cs[5], cs[2], cs[0]])), ["x", "r", "v", "l"]);
  assert.deepEqual(ids(L.withLinked(cs, [])), []);
  const r = L.withLinked(cs, [cs[0]]);
  assert.equal(r[0], cs[0], "the same clip objects, not copies");
  const stray = clip("s", { linkGroup: "g" }); // in the list but not in `clips`
  assert.deepEqual(ids(L.withLinked(cs, [stray])), ["s", "v", "l", "r"]);
});

test("syncLinkedTiming: partners take start / in / duration / props.speed", () => {
  const cs = clips();
  Object.assign(cs[0], { start: 2, in: 3, duration: 1.5 });
  cs[0].props.speed = 2;
  delete cs[2].props;
  L.syncLinkedTiming(cs, cs[0]);
  for (const c of [cs[1], cs[2]]) assert.deepEqual([c.start, c.in, c.duration, c.props.speed], [2, 3, 1.5, 2], c.id);
  assert.equal(cs[3].start, 10, "other groups untouched");

  const legacy = clips();
  legacy[4].props.speed = 3;
  Object.assign(legacy[3], { start: 11 });
  L.syncLinkedTiming(legacy, legacy[3]); // no props.speed on the source: the partner keeps its own
  assert.deepEqual([legacy[4].start, legacy[4].props.speed], [11, 3]);
});

test("syncLinkedTiming: partners take keyframes.speed too, each its own copy; their other channels stay (BUG-07)", () => {
  const cs = clips();
  cs[0].keyframes = { speed: [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }], x: [{ t: 1, v: 5 }] };
  cs[1].keyframes = { volume: [{ t: 1, v: 0 }] };
  L.syncLinkedTiming(cs, cs[0]);
  for (const c of [cs[1], cs[2]]) {
    assert.deepEqual(c.keyframes.speed, cs[0].keyframes.speed, c.id);
    assert.notEqual(c.keyframes.speed, cs[0].keyframes.speed, `${c.id}: not the same array`);
    assert.notEqual(c.keyframes.speed[1], cs[0].keyframes.speed[1], `${c.id}: not the same key objects`);
    assert.equal(c.keyframes.x, undefined, `${c.id}: only speed is shared`);
  }
  assert.deepEqual(cs[1].keyframes.volume, [{ t: 1, v: 0 }], "a stem keeps its own fade");
  assert.equal(cs[3].keyframes, undefined, "other groups untouched");
  const own = cs[0].keyframes, ramp = own.speed;
  L.syncLinkedTiming(cs, cs[0]);
  assert.ok(cs[0].keyframes === own && cs[0].keyframes.speed === ramp, "the source keeps its own objects");
  // a source without a props object: the partners keep their speed
  const bare = clips();
  bare[1].props.speed = 2;
  delete bare[0].props;
  L.syncLinkedTiming(bare, bare[0]);
  assert.equal(bare[1].props.speed, 2);
});

test("syncLinkedSpeed: a partner of an unramped clip loses its ramp (and an emptied keyframes object)", () => {
  const cs = clips();
  cs[1].keyframes = { speed: [{ t: 0, v: 2 }], volume: [{ t: 1, v: 0 }] };
  cs[2].keyframes = { speed: [{ t: 0, v: 2 }] };
  cs[0].props.speed = 1.5;
  L.syncLinkedSpeed(cs, cs[0]);
  assert.deepEqual(cs[1].keyframes, { volume: [{ t: 1, v: 0 }] });
  assert.equal(cs[2].keyframes, undefined);
  assert.deepEqual([cs[1].props.speed, cs[2].props.speed], [1.5, 1.5]);
  const before = JSON.stringify(cs);
  L.syncLinkedSpeed(cs, cs[5]);
  assert.equal(JSON.stringify(cs), before, "an unlinked clip has no partners");
});

test("relinkClips: ungrouped video + audio with the same media and timing (±1e-3) get the group lg_<video id>", () => {
  const cs = [
    clip("v", { mediaId: "m" }),
    clip("a", { kind: "audio", mediaId: "m", start: 0.0005, in: "0" }),
    clip("b", { kind: "audio", mediaId: "m" }),
    clip("v2", { mediaId: "m" }),                        // same timing, but the stems are taken
    clip("w", { mediaId: "n", start: 5 }),
    clip("wa", { kind: "audio", mediaId: "n", start: 5, duration: 4.01 }), // too far off
    clip("t", { kind: "text", mediaId: null }),
    clip("na", { kind: "audio", mediaId: null }),
  ];
  L.relinkClips(cs);
  assert.deepEqual(cs.map((c) => c.linkGroup), ["lg_v", "lg_v", "lg_v", undefined, undefined, undefined, undefined, undefined]);
  for (const c of cs) if (!c.linkGroup) assert.equal(Object.hasOwn(c, "linkGroup"), false, `${c.id}: no empty linkGroup key`);
});

test("relinkClips: an audio clip joins a video only on the same media, within 1 ms (exclusive)", () => {
  const cs = [
    clip("v", { mediaId: "m" }),
    clip("bed", { kind: "audio", mediaId: "music" }),          // same timing, another file: a music bed
    clip("off", { kind: "audio", mediaId: "m", start: 0.001 }), // exactly 1 ms off
  ];
  L.relinkClips(cs);
  assert.deepEqual(cs.map((c) => c.linkGroup), [undefined, undefined, undefined]);
});

test("relinkClips: linkGroup ids on disk are kept, drifted members included (D1, BUG-11)", () => {
  const cs = clips().slice(0, 3);
  cs[2].start = 0.5;
  const before = JSON.stringify(cs);
  L.relinkClips(cs);
  assert.deepEqual(cs.map((c) => c.linkGroup), ["g", "g", "g"], "the on-disk id stays; a stem 0.5 s off stays linked");
  assert.equal(JSON.stringify(cs), before, "nothing else changes");
});

test("relinkClips: an ungrouped stem joins a grouped video with its timing; the group keeps its id", () => {
  const cs = [clip("v", { mediaId: "m", linkGroup: "g" }), clip("l", { kind: "audio", mediaId: "m" }), clip("r", { kind: "audio", mediaId: "m", linkGroup: "other" })];
  L.relinkClips(cs);
  assert.deepEqual(cs.map((c) => c.linkGroup), ["g", "g", "other"], "a stem that has a group keeps it");
});

test("relinkClips: a legacy linkedId pair becomes a group (and linkedId is dropped), whatever its timing", () => {
  const cs = [
    clip("pa", { kind: "audio", mediaId: "p", linkedId: "pv", start: 3 }), // drifted: still linked
    clip("pv", { mediaId: "p", linkedId: "pa" }),
    clip("qa", { kind: "audio", mediaId: "q", linkedId: "qv" }),        // partner already grouped: joins it
    clip("qv", { mediaId: "q", linkGroup: "gq" }),
    clip("x", { kind: "audio", mediaId: "p", linkedId: "gone", start: 9 }), // dangling: dropped
    clip("y", { kind: "audio", mediaId: "p", linkedId: undefined, start: 9 }),
  ];
  L.relinkClips(cs);
  assert.deepEqual(cs.map((c) => c.linkGroup), ["lg_pv", "lg_pv", "gq", "gq", undefined, undefined]);
  for (const c of cs) assert.equal(Object.hasOwn(c, "linkedId"), false, `${c.id}: linkedId dropped`);
});

test("relinkClips: a one-sided legacy linkedId joins the partner's group, or names a new one after the earlier clip", () => {
  // timings differ, so only the linkedId can link these
  const grouped = [clip("v", { mediaId: "m", linkGroup: "keep" }), clip("a", { kind: "audio", mediaId: "x", start: 9, linkedId: "v" })];
  L.relinkClips(grouped);
  assert.deepEqual(grouped.map((c) => c.linkGroup), ["keep", "keep"]);
  // no video in the pair: lg_<first member in clip order>, whichever side holds the linkedId
  const fromLater = [clip("s1", { kind: "audio", mediaId: "x" }), clip("s2", { kind: "audio", mediaId: "y", start: 5, linkedId: "s1" })];
  const fromEarlier = [clip("s1", { kind: "audio", mediaId: "x", linkedId: "s2" }), clip("s2", { kind: "audio", mediaId: "y", start: 5 })];
  L.relinkClips(fromLater);
  L.relinkClips(fromEarlier);
  assert.deepEqual([...fromLater, ...fromEarlier].map((c) => c.linkGroup), ["lg_s1", "lg_s1", "lg_s1", "lg_s1"]);
});

test("relinkClips: a new id never takes one already on disk; the same input always gives the same ids", () => {
  const make = () => [
    clip("z", { kind: "text", mediaId: null, linkGroup: "lg_v" }), // an agent used the name
    clip("v", { mediaId: "m" }), clip("a", { kind: "audio", mediaId: "m" }),
  ];
  const a = make(), b = make();
  L.relinkClips(a);
  L.relinkClips(b);
  assert.deepEqual(a.map((c) => c.linkGroup), ["lg_v", "lg_v_2", "lg_v_2"]);
  assert.deepEqual(b, a);
  // lg_v and lg_v_2 on disk → lg_v_3; the new lg_v_3 is then taken for the next group too (a video named v_3)
  const taken = [
    clip("y", { kind: "text", mediaId: null, linkGroup: "lg_v" }), clip("z", { kind: "text", mediaId: null, linkGroup: "lg_v_2" }),
    clip("v", { mediaId: "m" }), clip("a", { kind: "audio", mediaId: "m" }),
    clip("v_3", { mediaId: "n", start: 5 }), clip("b", { kind: "audio", mediaId: "n", start: 5 }),
  ];
  L.relinkClips(taken);
  assert.deepEqual(taken.map((c) => c.linkGroup), ["lg_v", "lg_v_2", "lg_v_3", "lg_v_3", "lg_v_3_2", "lg_v_3_2"]);
});

test("relinkClips: a stale linkedId never merges two groups, and a clip linked to itself stays alone", () => {
  const cs = [
    clip("v", { mediaId: "m", linkGroup: "g1", linkedId: "w" }),
    clip("w", { mediaId: "n", start: 9, linkGroup: "g2" }),
    clip("self", { kind: "audio", mediaId: "x", start: 20, linkedId: "self" }),
  ];
  L.relinkClips(cs);
  assert.deepEqual(cs.map((c) => c.linkGroup), ["g1", "g2", undefined]);
  for (const c of cs) assert.equal(Object.hasOwn(c, "linkedId"), false, `${c.id}: linkedId dropped`);
});

test("relinkSplitRights: right halves get one new group per old group; legacy pairs re-pair", () => {
  const cs = clips();
  const right = (c) => ({ ...c, id: c.id + "'", linkGroup: undefined, linkedId: undefined });
  const newLink = new Map(cs.filter((c) => c.id !== "x").map((c) => [c.id, right(c)]));
  const lonely = clip("solo", { linkedId: "unsplit" });
  newLink.set("solo", right(lonely));
  const next = counter();
  L.relinkSplitRights([...cs, lonely], newLink, { newLinkId: next });
  const g = newLink.get("v").linkGroup;
  assert.equal(g, "lg_n1");
  assert.equal(newLink.get("l").linkGroup, g);
  assert.equal(newLink.get("r").linkGroup, g);
  assert.equal(next(), "lg_n2", "one id for the one group");
  assert.equal(newLink.get("pv").linkedId, "pa'");
  assert.equal(newLink.get("pa").linkedId, "pv'");
  assert.equal(Object.hasOwn(newLink.get("solo"), "linkedId"), false, "partner did not split: link dropped");
  assert.equal(cs[0].linkGroup, "g", "left halves keep theirs");
});

test("relinkSplitRights: an id factory is required — no silent default (relinkClips needs none)", () => {
  assert.throws(() => L.relinkSplitRights([], new Map()), /ctx\.newLinkId must be a function/);
  assert.doesNotThrow(() => L.relinkClips([]));
});

test("defaultPanForChannel: L hard left, R hard right, everything else centered", () => {
  assert.deepEqual([0, 1, 2, 5, -1, undefined].map(L.defaultPanForChannel), [-1, 1, 0, 0, 0, 0]);
});

test("module: frozen, and loads in a page with no other core script (no dependencies)", () => {
  assert.ok(Object.isFrozen(L));
  assert.deepEqual(Object.keys(L).sort(),
    ["defaultPanForChannel", "linkedClip", "relinkClips", "relinkSplitRights", "syncLinkedSpeed", "syncLinkedTiming", "withLinked"]);
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "core", "links.js"), "utf8"), ctx);
  assert.equal(typeof vm.runInContext("FableCore.links.withLinked", ctx), "function");
});
