/* core/links.js — AV links over an explicit clip array: partner lookup,
   group expansion, timing sync, relink on load and after a split.
   test/edit-ops.test.js runs these through app.js's wrappers; this file pins
   the pure API. Tests marked "current behavior; changes in Phase 3 (BUG-xx)"
   pin a known bug on purpose — update them when the bug is fixed. */
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

test("syncLinkedTiming: current behavior; changes in Phase 3 (BUG-07) — keyframes.speed is not copied", () => {
  const cs = clips();
  cs[0].keyframes = { speed: [{ t: 0, v: 1 }, { t: 2, v: 3 }] };
  L.syncLinkedTiming(cs, cs[0]);
  assert.equal(cs[1].keyframes, undefined);
});

test("relinkClips: video + audio with the same media and timing (±1e-3) share one fresh group", () => {
  const cs = [
    clip("v", { mediaId: "m", linkGroup: "old" }),
    clip("a", { kind: "audio", mediaId: "m", start: 0.0005, in: "0", linkedId: "v" }),
    clip("b", { kind: "audio", mediaId: "m" }),
    clip("v2", { mediaId: "m" }),                        // same timing, but the stems are taken
    clip("w", { mediaId: "n", start: 5 }),
    clip("wa", { kind: "audio", mediaId: "n", start: 5, duration: 4.01 }), // too far off
    clip("t", { kind: "text", mediaId: null }),
    clip("na", { kind: "audio", mediaId: null }),
  ];
  const made = [];
  L.relinkClips(cs, { newLinkId: () => { made.push("lg_" + made.length); return made.at(-1); } });
  assert.deepEqual(made, ["lg_0"], "one id per video that found partners");
  assert.deepEqual(cs.map((c) => c.linkGroup), ["lg_0", "lg_0", "lg_0", undefined, undefined, undefined, undefined, undefined]);
  for (const c of cs) {
    assert.equal(Object.hasOwn(c, "linkedId"), false, `${c.id}: linkedId dropped`);
    if (!c.linkGroup) assert.equal(Object.hasOwn(c, "linkGroup"), false, `${c.id}: no empty linkGroup key`);
  }
});

test("relinkClips: current behavior; changes in Phase 3 (BUG-11) — ids regenerate and drifted members unlink", () => {
  const cs = clips().slice(0, 3);
  cs[2].start = 0.5;
  L.relinkClips(cs, { newLinkId: counter() });
  assert.equal(cs[0].linkGroup, "lg_n1", "the on-disk id g is not kept");
  assert.equal(cs[1].linkGroup, "lg_n1");
  assert.equal(cs[2].linkGroup, undefined, "a stem 0.5 s off is silently unlinked");
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

test("relink*: an id factory is required — no silent default", () => {
  assert.throws(() => L.relinkClips([], {}), /ctx\.newLinkId must be a function/);
  assert.throws(() => L.relinkSplitRights([], new Map()), /ctx\.newLinkId must be a function/);
});

test("defaultPanForChannel: L hard left, R hard right, everything else centered", () => {
  assert.deepEqual([0, 1, 2, 5, -1, undefined].map(L.defaultPanForChannel), [-1, 1, 0, 0, 0, 0]);
});

test("module: frozen, and loads in a page with no other core script (no dependencies)", () => {
  assert.ok(Object.isFrozen(L));
  assert.deepEqual(Object.keys(L).sort(),
    ["defaultPanForChannel", "linkedClip", "relinkClips", "relinkSplitRights", "syncLinkedTiming", "withLinked"]);
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "core", "links.js"), "utf8"), ctx);
  assert.equal(typeof vm.runInContext("FableCore.links.withLinked", ctx), "function");
});
