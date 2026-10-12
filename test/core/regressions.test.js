/* Regressions found by the property tests (test/props/) — each one the
   shrunk counterexample of an invariant, as a deterministic Given / When /
   Then. A bug not fixed yet carries node:test's `todo` option naming it:
   fixing it means removing the todo, watching it fail, then making it pass
   (the property named in the comment goes green with it). All are fixed.
   BUG-01…18 live in test/edit-ops.test.js. */
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const E = require("../../core/edit");
const K = require("../../core/keyframes");
const { MIN_DUR } = require("../../core/schema");
const { createEditDriver } = require("../drivers/edit");
const { build } = require("../fixtures");

const clip = (id, over = {}) => ({ id, mediaId: "m", kind: "video", track: "V1", start: 0, in: 0, duration: 4, props: {}, ...over });
function ctx() {
  let n = 0;
  return { newId: () => "c_n" + ++n, newLinkId: () => "lg_n" + ++n, isEnabled: () => true, beforeChange() {} };
}
function drag(doc, c, mode, dt) {
  E.dragTo(doc, E.beginDrag(doc, c, mode), dt, {});
}

/* INV-05b, INV-07c, INV-10b — every static-speed path of BUG-12 (split and
   trim-l drag are in edit-ops BUG-12a / BUG-12b). The ramp: 1× → 3× linear over
   2 s, then 3× (∫ over [0, 1] = 1.5, over [0, 2] = 4). */
const ramp = () => ({ speed: [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }, { t: 6, v: 3, ease: "linear" }] });
const media30 = () => [{ id: "m", kind: "video", duration: 30 }];
test("BUG-12: given a speed ramp, when its head is trimmed to the playhead, then in is the media time under the playhead",
  () => {
    const c = clip("c", { in: 1, duration: 6, keyframes: ramp() });
    const expected = K.mediaTimeAt(c, 2);
    E.trimClipTo({ media: media30(), clips: [c] }, c, 2, "in", ctx());
    assert.ok(Math.abs(expected - 5) < 1e-9, `mediaTimeAt ${expected}`);
    assert.equal(c.in, expected);
  });
test("BUG-12: given a speed ramp, when trimmed to an IN marker, then in is the media time at IN",
  () => {
    const c = clip("c", { in: 1, duration: 6, keyframes: ramp() });
    const expected = K.mediaTimeAt(c, 1);
    E.trimToRange({ media: media30(), clips: [c] }, 1, null, ctx());
    assert.ok(Math.abs(expected - 2.5) < 1e-9, `mediaTimeAt ${expected}`);
    assert.equal(c.in, expected);
  });
test("BUG-12: given a ramp that starts at 3×, when the left edge is dragged left, then in falls at 3× and the edge stops where in reaches 0",
  () => {
    const c = clip("c", { start: 5, in: 3, duration: 4, keyframes: { speed: [{ t: 1, v: 3 }, { t: 3, v: 1 }] } });
    const doc = { media: media30(), clips: [c] };
    const g = E.beginDrag(doc, c, "trim-l");
    E.dragTo(doc, g, -0.5, {});
    assert.ok(Math.abs(c.in - 1.5) < 1e-12, `in ${c.in}`);
    E.dragTo(doc, g, -3, {}); // static speed 1 would allow 3 s; at 3× the source runs out after 1 s
    assert.deepEqual([c.start, c.in, c.duration], [4, 0, 5]);
  });

/* INV-07f */
test("BUG-19: given a title, when split, then the right piece keeps in == 0",
  () => {
    const doc = { media: [], clips: [clip("t", { kind: "text", mediaId: null, track: "V2" })] };
    const [right] = E.splitAt(doc, 1, {}, ctx()).created;
    assert.equal(right.in, 0);
  });

/* INV-07d */
test("BUG-20: given an svg clip with in 1, when its left edge is dragged +1s, then in follows to 2 (D5)",
  () => {
    const c = clip("s", { kind: "svg", start: 2, in: 1 });
    const doc = { media: [{ id: "m", kind: "svg" }], clips: [c] };
    drag(doc, c, "trim-l", 1);
    assert.equal(c.in, 2);
  });
test("BUG-20: given an svg clip with in 1, when trimmed to IN 3, then in follows to 2 (D5)",
  () => {
    const c = clip("s", { kind: "svg", start: 2, in: 1 });
    E.trimToRange({ media: [], clips: [c] }, 3, null, ctx());
    assert.equal(c.in, 2);
  });

/* INV-09c, INV-06b */
test("BUG-21: given a stem with a volume fade, when the linked picture's left edge is dragged, then the fade keeps its timeline position",
  () => {
    const v = clip("v", { linkGroup: "g" });
    const a = clip("a", { kind: "audio", track: "A1", linkGroup: "g", keyframes: { volume: [{ t: 1, v: 0 }, { t: 2, v: 1 }] } });
    const doc = { media: [{ id: "m", kind: "video", duration: 20 }], clips: [v, a] };
    drag(doc, v, "trim-l", 0.5);
    assert.equal(a.start, 0.5);
    assert.deepEqual(a.keyframes.volume.map((k) => k.t), [0.5, 1.5]);
  });
test("BUG-21: given a stem with late volume keys, when the linked picture's right edge is dragged shorter, then only the first key past the new end stays (its anchor, D4)",
  () => {
    const v = clip("v", { linkGroup: "g" });
    const a = clip("a", { kind: "audio", track: "A1", linkGroup: "g", keyframes: { volume: [{ t: 1, v: 1 }, { t: 3.5, v: 0 }, { t: 3.8, v: 0.5 }] } });
    const doc = { media: [{ id: "m", kind: "video", duration: 20 }], clips: [v, a] };
    drag(doc, v, "trim-r", -2);
    assert.equal(a.duration, 2);
    assert.deepEqual(a.keyframes.volume.map((k) => k.t), [1, 3.5]);
  });

/* INV-08c */
test("BUG-22: given a 2s out-transition, when the in-point is trimmed to leave 1s, then the transition fits the clip",
  () => {
    const c = clip("c", { transitionOut: { type: "fade", duration: 2 } });
    E.trimClipTo({ media: [{ id: "m", kind: "video", duration: 20 }], clips: [c] }, c, 3, "in", ctx());
    assert.equal(c.duration, 1);
    assert.ok(c.transitionOut.duration <= c.duration, `${c.transitionOut.duration} > ${c.duration}`);
  });

/* INV-10c */
test("BUG-23: given a constant 2× speed ramp on 10s of media, when the right edge is dragged far out, then the clip stops at the media end",
  () => {
    const c = clip("c", { keyframes: { speed: [{ t: 0, v: 2 }] } });
    const doc = { media: [{ id: "m", kind: "video", duration: 10 }], clips: [c] };
    drag(doc, c, "trim-r", 20);
    assert.ok(K.mediaTimeAt(c, c.start + c.duration) <= 10 + 1e-3, `source end ${K.mediaTimeAt(c, c.start + c.duration)}`);
    assert.ok(Math.abs(c.duration - 5) <= 1e-6, `duration ${c.duration}`);
  });
test("BUG-23: given a 1×→2.5× ramp on 3s of media, when the right edge is dragged far out, then the source window ends on the media end (±1e-6 s)",
  () => {
    // ∫₀^1.5 (1 + t) dt = 2.625, then 2.5× held: 2.625 + 2.5 × 0.15 = 3 at 1.65 s
    const c = clip("c", { duration: 1.5, keyframes: { speed: [{ t: 0, v: 1 }, { t: 1.5, v: 2.5, ease: "linear" }] } });
    const doc = { media: [{ id: "m", kind: "video", duration: 3 }], clips: [c] };
    drag(doc, c, "trim-r", 5);
    assert.ok(Math.abs(c.duration - 1.65) <= 1e-6, `duration ${c.duration}, static speed would give 3`);
    const end = K.mediaTimeAt(c, c.start + c.duration);
    assert.ok(end <= 3 + 1e-9 && end >= 3 - 1e-6, `source end ${end}`);
  });

/* INV-10d — the shrunk counterexample; BUG-13's own test is in edit-ops */
test("BUG-13: given a lone 0.25× speed key at 0.132 s, when the right edge is dragged back to 0.13 s, then the clip keeps playing at 0.25× and fits its media",
  () => {
    const c = clip("c", { duration: 0.5, keyframes: { speed: [{ t: 0.132, v: 0.25 }] } });
    const doc = { media: [{ id: "m", kind: "video", duration: 0.125 }], clips: [c] };
    drag(doc, c, "trim-r", -0.37);
    assert.ok(Math.abs(c.duration - 0.13) < 1e-9, `duration ${c.duration}`);
    assert.ok(K.mediaTimeAt(c, c.start + c.duration) <= 0.125 + 1e-3, `source end ${K.mediaTimeAt(c, c.start + c.duration)}`);
  });

/* INV-06a, INV-05b — edit-ops BUG-13 is the opacity case */
test("BUG-13: given an eased speed ramp split mid-segment, when played, then each piece shows the original's media time and speed (D4 anchors)",
  () => {
    const c = clip("c", { duration: 6, keyframes: { speed: [{ t: 0, v: 1 }, { t: 4, v: 3, ease: "ease-in-out" }] } });
    const orig = { ...c, id: "orig", keyframes: JSON.parse(JSON.stringify(c.keyframes)) };
    const doc = { media: media30(), clips: [c] };
    const [right] = E.splitAt(doc, 1.5, {}, ctx()).created;
    assert.deepEqual([c.keyframes.speed.map((k) => k.t), right.keyframes.speed.map((k) => k.t)], [[0, 4], [-1.5, 2.5]]);
    for (const p of [c, right]) for (const t of [p.start, p.start + p.duration / 2, p.start + p.duration]) {
      assert.ok(Math.abs(K.mediaTimeAt(p, t) - K.mediaTimeAt(orig, t)) <= 1e-3, `${p.id} media time at ${t}`);
      assert.equal(K.kfChannel(p, "speed", t - p.start, 1), K.kfChannel(orig, "speed", t, 1), `${p.id} speed at ${t}`);
    }
  });
/* INV-07c, INV-10b — D4: extending a head re-reveals the ramp an anchor kept */
test("BUG-13: given the right piece of a split ramp, when its left edge is dragged back over the cut, then in follows the original ramp",
  () => {
    const c = clip("c", { in: 1, duration: 6, keyframes: ramp() });
    const orig = { ...c, id: "orig", keyframes: ramp() };
    const doc = { media: media30(), clips: [c] };
    const [right] = E.splitAt(doc, 1, {}, ctx()).created; // its anchor: the 1× key at −1
    drag(doc, right, "trim-l", -1);
    assert.equal(right.start, 0);
    // ∫₋₁⁰ (2 + t) dt = 1.5 → in 2.5 − 1.5; holding the 2× at the cut would give 0.5
    assert.ok(Math.abs(right.in - 1) <= 1e-4, `in ${right.in}, the original shows ${K.mediaTimeAt(orig, 0)} at 0 s`);
    for (const t of [0.5, 1, 4]) assert.ok(Math.abs(K.mediaTimeAt(right, t) - K.mediaTimeAt(orig, t)) <= 1e-3, `at ${t}`);
  });

/* INV-01b */
test("BUG-24: given in 0.425, when the left edge is dragged past the media start, then in stops at exactly 0",
  () => {
    const c = clip("c", { start: 0.96, in: 0.425, duration: 0.5 });
    drag({ media: [{ id: "m", kind: "video", duration: 0.925 }], clips: [c] }, c, "trim-l", -1.46);
    assert.equal(c.in, 0);
    assert.ok(Math.abs(c.start - 0.535) < 1e-12, `start ${c.start}`);
  });
test("BUG-24: given a clip dragged to its shortest, when the left edge goes far right, then duration is exactly MIN_DUR",
  () => {
    const c = clip("c", { start: 0.3, in: 1, duration: 0.7 });
    drag({ media: [{ id: "m", kind: "video", duration: 20 }], clips: [c] }, c, "trim-l", 5);
    assert.equal(c.duration, MIN_DUR);
  });

/* INV-11e — the gesture lives in app.js, so this goes through the edit driver */
test("BUG-25: given a clip at 0s, when it is dragged further left, then nothing changes and no undo is recorded",
  () => {
    const ed = createEditDriver(build.project({
      media: [build.media("m_x", "video", 20)],
      clips: [build.clip("c_x", { mediaId: "m_x" })],
    }));
    ed.drag("c_x", "move", 2, 0);
    assert.equal(ed.clip("c_x").start, 0);
    assert.equal(ed.history().undo, 0);
  });
test("BUG-25: given a clip at its media end, when its right edge is dragged further out, then no undo is recorded",
  () => {
    const ed = createEditDriver(build.project({
      media: [build.media("m_x", "video", 5)],
      clips: [build.clip("c_x", { mediaId: "m_x", duration: 5 })],
    }));
    ed.drag("c_x", "trim-r", 5, 8);
    assert.equal(ed.clip("c_x").duration, 5);
    assert.equal(ed.history().undo, 0);
  });

/* INV-05c */
test("BUG-26: given a constant 2× ramp on a 0.501 s clip, when sampled at its end, then media time is 1.002",
  () => {
    const c = clip("c", { duration: 0.501, keyframes: { speed: [{ t: 0, v: 2 }] } });
    K.clearSpeedCache("c");
    assert.ok(Math.abs(K.mediaTimeAt(c, 0.501) - 1.002) <= 1e-4, `media time ${K.mediaTimeAt(c, 0.501)}`);
  });

/* Found by review in step 3d (no property drives app.js's Source picker) */
test("BUG-27: given a linked speed ramp, when its media is replaced by a shorter file, then the group is cut where the ramp reaches the new end",
  () => {
    // 1× → 3× over 2 s, back to 1× at 3.5 s: from in 1, a 6 s file runs out 5 s of source later, at ≈ 2.3625 s
    const ramp = () => ({ speed: [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }, { t: 3.5, v: 1, ease: "linear" }, { t: 4, v: 1 }] });
    const lg = { linkGroup: "lg_v", keyframes: ramp() };
    const ed = createEditDriver(build.project({
      media: [build.media("m_long", "video", 20), build.media("m_short", "video", 6)],
      clips: [
        build.clip("c_v", { mediaId: "m_long", inn: 1, duration: 4, props: { volume: 0 }, ...lg,
          transitionIn: { type: "fade", duration: 0.5 }, transitionOut: { type: "fade", duration: 3 } }),
        build.clip("c_l", { mediaId: "m_long", kind: "audio", track: "A1", inn: 1, duration: 4, props: { audioChannel: 0, pan: -1 }, ...lg }),
        build.clip("c_r", { mediaId: "m_long", kind: "audio", track: "A2", inn: 1, duration: 4, props: { audioChannel: 1, pan: 1 }, ...lg }),
      ],
    }));
    ed.replaceMedia("c_v", "m_short");
    const v = ed.clip("c_v");
    assert.ok(Math.abs(v.duration - 2.3625) < 1e-3, `duration ${v.duration}; static speed 1 kept all 4 s`);
    const end = K.mediaTimeAt(v, v.start + v.duration);
    assert.ok(end <= 6 + 1e-3 && end >= 6 - 1e-3, `source end ${end}`);
    assert.deepEqual(v.keyframes.speed.map((k) => k.t), [0, 2, 3.5], "the key past the new end stays as its anchor, the one beyond goes");
    assert.ok(v.transitionIn.duration + v.transitionOut.duration <= v.duration + 1e-9, "transitions fit");
    for (const id of ["c_l", "c_r"]) {
      const x = ed.clip(id);
      assert.deepEqual([x.mediaId, x.in, x.duration, x.keyframes.speed], [v.mediaId, v.in, v.duration, v.keyframes.speed], id);
    }
    assert.ok(ed.log.toasts.includes("Media replaced — trimmed to fit shorter source"));
  });
