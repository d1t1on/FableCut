/* Timeline edit operations — characterization tests.

   These pin down how the editor's edit operations behave today, through the
   edit driver (test/drivers/edit.js), so the timeline core can be extracted
   out of app.js without changing behavior. Titles read Given / When / Then.

   Known bugs are written as the behavior we WANT, each titled BUG-xx. Until
   one was fixed it carried node:test's `todo` option: it ran and reported,
   but did not fail the suite. Fixing one = delete the todo, watch it go red, fix,
   green. Every BUG-01…18 here is fixed now (Phase 3); later ones live in
   test/core/regressions.test.js.
   Inspector edits go through app.js applyInspectorField (driver: inspect);
   + Title / + Adjust through addTitle / addAdjust, the track header's Remove
   track through removeTimelineTrack, the Source picker through
   replaceClipMedia. */
"use strict";
const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { createEditDriver, DEFAULT_PROPS, MIN_DUR } = require("./drivers/edit");
const { listFixtures, loadFixture, build } = require("./fixtures");

const load = (name, mutate) => {
  const doc = loadFixture(name);
  if (mutate) mutate(doc);
  return createEditDriver(doc);
};
const find = (doc, id) => doc.clips.find((c) => c.id === id);
const near = (actual, expected, eps = 1e-6, msg = "") =>
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} expected ≈${expected}, got ${actual}`);
const startsOn = (ed, track) => ed.clips().filter((c) => c.track === track).map((c) => c.start).sort((a, b) => a - b);
const pieceAt = (ed, track, start) => ed.clips().find((c) => c.track === track && Math.abs(c.start - start) < 1e-9);
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ── Load ───────────────────────────────────────────────────────────────── */
describe("load (applyProject)", () => {
  test("given sparse agent-written props, when loaded, then every clip carries the full default props", () => {
    const ed = load("minimal");
    for (const k of Object.keys(DEFAULT_PROPS)) assert.ok(k in ed.clip("c_a").props, `missing ${k}`);
  });

  test("given no tracks, when loaded, then the default lanes V3…V1 + A1…A4 exist", () => {
    assert.deepEqual(load("minimal").tracks(), ["V3", "V2", "V1", "A1", "A2", "A3", "A4"]);
  });

  test("given keys outside their clips from before anchors (D4), when loaded, then they are kept as written and render the same", () => {
    const src = loadFixture("keyframe-anchors");
    const ed = load("keyframe-anchors");
    for (const c of src.clips) assert.deepEqual(ed.clip(c.id).keyframes, c.keyframes, c.id);
    near(ed.valueAt("c_mid", "opacity", 0, 1), 1 - (1 - 0.5 / 1.3) ** 2, 1e-9, "starts mid-fade (ease-out)");
    near(ed.mediaTimeAt("c_ramp", 0), 2, 1e-9);
    near(ed.mediaTimeAt("c_ramp", 1), 2 + 2.5, 1e-3, "the ramp from the key before 0: ∫₀¹ (2 + t) dt");
  });

  test("given a clip on an undeclared lane, when loaded, then that lane is created in order", () => {
    const ed = load("legacy");
    assert.equal(ed.tracks()[0], "V5");
    assert.equal(ed.api.tracks().find((t) => t.id === "V5").kind, "video");
  });

  test("given stems without pan and no panSchema, when loaded, then L/R pans migrate once and a save is scheduled", () => {
    const ed = load("legacy");
    assert.equal(ed.clip("c_oa").props.pan, -1);
    assert.equal(ed.clip("c_ob").props.pan, 1);
    assert.equal(ed.project.panSchema, 1);
    assert.equal(ed.loadSaves, 1);
  });

  test("given panSchema 1 and a deliberately centered stem, when loaded, then its pan stays 0", () => {
    const ed = load("linked-av", (d) => { find(d, "c_l").props.pan = 0; });
    assert.equal(ed.clip("c_l").props.pan, 0);
    assert.equal(ed.loadSaves, 0);
  });

  test("given video + audio with matching media and timing, when loaded, then they share one linkGroup and linkedId is dropped", () => {
    const ed = load("legacy");
    const g = ed.clip("c_ov").linkGroup;
    assert.ok(g);
    assert.equal(ed.clip("c_oa").linkGroup, g);
    assert.equal(ed.clip("c_ob").linkGroup, g);
    for (const c of ed.clips()) assert.equal(c.linkedId, undefined);
  });

  test("given unsorted keyframes, when loaded, then each channel is sorted by time", () => {
    const ed = load("minimal", (d) => {
      d.clips[0].keyframes = { opacity: [{ t: 3, v: 1 }, { t: 0, v: 0 }] };
    });
    assert.deepEqual(ed.clip("c_a").keyframes.opacity.map((k) => k.t), [0, 3]);
  });

  test("given OUT at or before IN, when loaded, then both work-area markers are cleared", () => {
    const ed = load("minimal", (d) => { d.inPoint = 5; d.outPoint = 2; });
    assert.equal(ed.project.inPoint, null);
    assert.equal(ed.project.outPoint, null);
  });
});

/* ── Save ───────────────────────────────────────────────────────────────── */
describe("save (projectJSON)", () => {
  for (const name of listFixtures()) {
    test(`given ${name}, when loaded and saved, then clip ids, timing and panSchema survive`, () => {
      const src = loadFixture(name);
      const out = createEditDriver(clone(src)).save();
      assert.equal(out.panSchema, 1);
      assert.deepEqual(out.clips.map((c) => c.id).sort(), src.clips.map((c) => c.id).sort());
      for (const c of src.clips) {
        const s = find(out, c.id);
        assert.equal(s.start, c.start);
        assert.equal(s.duration, c.duration);
        if (Number.isFinite(c.in)) assert.equal(s.in, c.in);
      }
    });
  }

  test("given lanes, folders and an export frame, when saved, then they are normalized and kept", () => {
    const out = load("lanes-bin").save();
    assert.deepEqual(out.exportFrame, { x: 438, y: 0, w: 404, h: 720 });
    assert.equal(out.encodeProfile, "delivery");
    assert.deepEqual(out.disabledTracks, ["A5"]);
    assert.ok(out.tracks.some((t) => t.id === "V4") && out.tracks.some((t) => t.id === "A5"));
    assert.equal(out.folders.find((f) => f.id === "f_gfx").open, false);
  });
});

/* ── Split at playhead ──────────────────────────────────────────────────── */
describe("split at playhead", () => {
  test("given no selection, when split at 4s, then every clip crossing 4s is cut on every lane", () => {
    const ed = load("linked-av").at(4);
    ed.split();
    assert.equal(ed.clips().length, 11);
    assert.equal(ed.clip("c_v").duration, 4);
    const right = pieceAt(ed, "V1", 4);
    assert.equal(right.in, 6);
    assert.equal(right.duration, 4);
    const song = pieceAt(ed, "A3", 4);
    assert.equal(song.in, 4);
    assert.equal(song.duration, 10);
  });

  test("given a selected video, when split, then only it and its linked stems are cut", () => {
    const ed = load("linked-av").select("c_v").at(4);
    ed.split();
    assert.equal(ed.clips().length, 10);
    assert.equal(ed.clip("c_song").duration, 14);
    assert.equal(ed.clip("c_l").duration, 4);
    assert.equal(ed.clip("c_r").duration, 4);
  });

  test("given a linked group, when split, then the right halves share a fresh linkGroup", () => {
    const ed = load("linked-av").select("c_v").at(4);
    ed.split();
    const rights = ["V1", "A1", "A2"].map((tr) => pieceAt(ed, tr, 4));
    const g = rights[0].linkGroup;
    assert.ok(g);
    for (const r of rights) assert.equal(r.linkGroup, g);
    assert.notEqual(g, ed.clip("c_v").linkGroup);
  });

  test("given the playhead within MIN_DUR of a clip edge, when split, then nothing changes and no undo is recorded", () => {
    const ed = load("linked-av").select("c_v").at(MIN_DUR / 2);
    ed.split();
    assert.equal(ed.clips().length, 7);
    assert.equal(ed.history().undo, 0);
  });

  test("given in/out transitions, when split, then only the transitions at the cut are cleared", () => {
    const ed = load("keyframes-transitions").select("c_b").at(6);
    ed.split();
    const left = ed.clip("c_b"), right = pieceAt(ed, "V1", 6);
    assert.deepEqual(left.transitionIn, { type: "fade", duration: 1 });
    assert.equal(left.transitionOut, undefined);
    assert.equal(right.transitionIn, undefined);
    assert.deepEqual(right.transitionOut, { type: "fade", duration: 0.5 });
  });

  test("given keyframes, when split, then the right piece's keyframe times are re-based to its start, the key before the cut kept as an anchor (D4)", () => {
    const ed = load("keyframes-transitions").select("c_a").at(2);
    ed.split();
    const right = pieceAt(ed, "V1", 2);
    assert.deepEqual(right.keyframes.opacity.map((k) => k.t), [-2, 2]);
    assert.deepEqual(ed.clip("c_a").keyframes.opacity.map((k) => k.t), [0, 4], "the left piece keeps the key past the cut");
  });

  test("given a split, when undone and redone, then the clips round-trip exactly", () => {
    const ed = load("linked-av").at(4);
    const before = clone(ed.clips());
    ed.split();
    const after = clone(ed.clips());
    ed.undo();
    assert.deepEqual(clone(ed.clips()), before);
    ed.redo();
    assert.deepEqual(clone(ed.clips()), after);
  });
});

/* ── Split at IN/OUT ────────────────────────────────────────────────────── */
describe("split at IN/OUT", () => {
  test("given IN 1 and OUT 9, when split at the work area, then crossing clips are cut at both markers", () => {
    const ed = load("linked-av");
    ed.splitAtWorkArea();
    assert.deepEqual(startsOn(ed, "A3"), [0, 1, 9]);
    assert.deepEqual(startsOn(ed, "V1"), [0, 1, 10]);
  });

  test("given no IN/OUT markers, when split at the work area, then it only explains why", () => {
    const ed = load("minimal");
    ed.splitAtWorkArea();
    assert.deepEqual(ed.log.toasts, ["Set an IN or OUT marker first (I / O)"]);
    assert.equal(ed.clips().length, 1);
  });
});

/* ── Trim to playhead ───────────────────────────────────────────────────── */
describe("trim to playhead", () => {
  test("given a linked video, when its in-point is trimmed to 3s, then start/in/duration move and stems follow", () => {
    const ed = load("linked-av").select("c_v").at(3);
    ed.trimToPlayhead("in");
    for (const id of ["c_v", "c_l", "c_r"]) {
      const c = ed.clip(id);
      assert.deepEqual([c.start, c.in, c.duration], [3, 5, 5], id);
    }
  });

  test("given a linked video, when its out-point is trimmed to 6s, then the stems follow", () => {
    const ed = load("linked-av").select("c_v").at(6);
    ed.trimToPlayhead("out");
    for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id).duration, 6, id);
  });
});

/* ── Trim to IN/OUT ─────────────────────────────────────────────────────── */
describe("trim to IN/OUT", () => {
  test("given IN 1 and OUT 9, when trimmed to the work area, then heads/tails go and outside clips are removed", () => {
    const ed = load("linked-av");
    ed.trimToWorkArea();
    const v = ed.clip("c_v");
    assert.deepEqual([v.start, v.in, v.duration], [1, 3, 7]);
    const song = ed.clip("c_song");
    assert.deepEqual([song.start, song.in, song.duration], [1, 1, 8]);
    for (const id of ["c_v2", "c_l2", "c_r2"]) assert.equal(ed.clip(id), undefined, id);
  });

  test("given a keyframed title, when trimmed to the work area, then in stays 0, keyframes shift and the trimmed edges lose their transitions", () => {
    const ed = load("keyframes-transitions", (d) => { d.inPoint = 2; d.outPoint = 3.5; });
    ed.trimToWorkArea();
    const t = ed.clip("c_t");
    assert.deepEqual([t.start, t.in, t.duration], [2, 0, 1.5]);
    assert.deepEqual(t.keyframes.x, [{ t: -1, v: -200 }, { t: 0, v: 0, ease: "ease-out" }], "the key before IN stays as an anchor (D4)");
    assert.equal(t.transitionIn, undefined);
    assert.equal(ed.clip("c_b"), undefined);
  });

  test("given no IN/OUT markers, when trimmed to the work area, then it only explains why", () => {
    const ed = load("minimal");
    ed.trimToWorkArea();
    assert.deepEqual(ed.log.toasts, ["Set an IN or OUT marker first (I / O)"]);
  });
});

/* ── Close gap ──────────────────────────────────────────────────────────── */
describe("close gap at playhead", () => {
  test("given a 2s gap on every enabled lane, when closed, then later clips on those lanes shift left by 2s", () => {
    const ed = load("linked-av").untarget("A3").at(9);
    ed.closeGap();
    for (const id of ["c_v2", "c_l2", "c_r2"]) assert.equal(ed.clip(id).start, 8, id);
    assert.equal(ed.clip("c_song").start, 0);
    assert.deepEqual(ed.log.toasts, ["Closed 2.00s gap"]);
    assert.equal(ed.history().undo, 1);
  });

  test("given an enabled lane with no gap at the playhead, when closed, then nothing moves and the lane is named", () => {
    const ed = load("linked-av").at(9);
    ed.closeGap();
    assert.deepEqual(ed.log.toasts, ["No gap on A3 — untarget the track or move the playhead"]);
    assert.equal(ed.clip("c_v2").start, 10);
    assert.equal(ed.history().undo, 0);
  });

  test("given the playhead over a clip, when closed, then the first covered lane is reported", () => {
    const ed = load("linked-av").at(4);
    ed.closeGap();
    assert.deepEqual(ed.log.toasts, ["No gap on V1 — untarget the track or move the playhead"]);
  });
});

/* ── Delete ─────────────────────────────────────────────────────────────── */
describe("delete selection", () => {
  test("given a selected linked video, when deleted, then its stems go too and the selection clears", () => {
    const ed = load("linked-av").select("c_v");
    ed.deleteSelected();
    for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id), undefined, id);
    assert.equal(ed.clips().length, 4);
    assert.equal(ed.state.selIds.size, 0);
  });
});

/* ── Pointer gestures ───────────────────────────────────────────────────── */
describe("clip drag gestures", () => {
  test("given a linked video, when dragged +1s, then the whole group moves and one undo entry is recorded", () => {
    const ed = load("linked-av");
    ed.drag("c_v", "move", 1, 2);
    for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id).start, 1, id);
    assert.equal(ed.clip("c_song").start, 0);
    assert.equal(ed.history().undo, 1);
  });

  test("given a drag far past zero, when released, then the group stops at 0s", () => {
    const ed = load("linked-av");
    ed.drag("c_v2", "move", 11, -20);
    for (const id of ["c_v2", "c_l2", "c_r2"]) assert.equal(ed.clip(id).start, 0, id);
  });

  test("given a linked video, when its left edge is dragged to 1s, then start/in/duration move and stems follow", () => {
    const ed = load("linked-av");
    ed.drag("c_v", "trim-l", 0, 1);
    for (const id of ["c_v", "c_l", "c_r"]) {
      const c = ed.clip(id);
      assert.deepEqual([c.start, c.in, c.duration], [1, 3, 7], id);
    }
  });

  test("given a right-edge drag beyond the media, when released, then the duration stops at the media end", () => {
    const ed = load("linked-av");
    ed.drag("c_v2", "trim-r", 14, 100);
    assert.equal(ed.clip("c_v2").duration, 8);
    assert.equal(ed.clip("c_l2").duration, 8);
  });

  test("given a click without movement, when released, then nothing changes and no undo is recorded", () => {
    const ed = load("linked-av");
    ed.click("c_v");
    assert.equal(ed.clip("c_v").start, 0);
    assert.equal(ed.history().undo, 0);
  });

  test("given a drag onto another lane, when the lane kind matches, then only the dragged clip changes lane", () => {
    const ed = load("linked-av");
    ed.drag("c_v", "move", 1, 1, { track: "V2" });
    assert.equal(ed.clip("c_v").track, "V2");
    assert.equal(ed.clip("c_l").track, "A1");
    ed.drag("c_v", "move", 1, 1, { track: "A4" });
    assert.equal(ed.clip("c_v").track, "V2");
  });
});

/* ── History ────────────────────────────────────────────────────────────── */
describe("undo history", () => {
  test("given two edits, when undone twice and redone twice, then each step is restored in order", () => {
    const ed = load("linked-av");
    const n0 = ed.clips().length;
    ed.at(4).split();
    const n1 = ed.clips().length;
    ed.at(12).split();
    const n2 = ed.clips().length;
    ed.undo(); assert.equal(ed.clips().length, n1);
    ed.undo(); assert.equal(ed.clips().length, n0);
    ed.redo(); assert.equal(ed.clips().length, n1);
    ed.redo(); assert.equal(ed.clips().length, n2);
  });

  test("given more than 100 recorded edits, when recording another, then only the latest 100 are kept", () => {
    const ed = load("minimal");
    for (let i = 0; i < 105; i++) ed.pushUndo();
    assert.equal(ed.history().undo, 100);
  });
});

/* ── Time remapping ─────────────────────────────────────────────────────── */
describe("media time (speed and ramps)", () => {
  test("given a static 2× clip, when 2s into it, then 4s of media have played", () => {
    assert.equal(load("speed-ramp").mediaTimeAt("c_fast", 10), 4);
  });

  test("given a 1→3 linear speed ramp, when sampled, then media time is the integral of speed", () => {
    const ed = load("speed-ramp");
    near(ed.mediaTimeAt("c_ramp", 2), 1 + 4, 1e-3, "after the ramp");
    near(ed.mediaTimeAt("c_ramp", 6), 1 + 4 + 12, 1e-3, "at the end");
  });
});

/* ── External writes (agent / MCP) ──────────────────────────────────────── */
describe("external project writes", () => {
  test("given a newer revision on disk, when the change event syncs, then the project is replaced wholesale", async () => {
    const ed = load("linked-av");
    await ed.externalWrite({ ...loadFixture("minimal"), revision: 99 });
    assert.deepEqual(ed.clips().map((c) => c.id), ["c_a"]);
    assert.equal(ed.project.revision, 99);
  });

  test("given the same revision (our own save echoing back), when synced, then nothing is applied", async () => {
    const ed = load("linked-av");
    await ed.externalWrite({ ...loadFixture("minimal"), revision: 3 });
    assert.equal(ed.clips().length, 7);
  });

  test("given a drag in progress, when a change event arrives, then the sync is deferred", async () => {
    const ed = load("linked-av");
    ed.state.gesture = true;
    await ed.externalWrite({ ...loadFixture("minimal"), revision: 99 });
    assert.equal(ed.runtime.pendingSync, true);
    assert.equal(ed.clips().length, 7);
  });
});

/* ── Known bugs: desired behavior, not yet implemented ──────────────────── */
describe("known bugs (fixed; each was a todo until then)", () => {
  test("BUG-01: given media now shorter than the clip's in-point, when the right edge is dragged, then duration stays ≥ MIN_DUR",
    () => {
      const ed = createEditDriver(build.project({
        media: [build.media("m_x", "video", 20)],
        clips: [build.clip("c_x", { mediaId: "m_x", inn: 16, duration: 4 })],
      }));
      ed.api.getMedia("m_x").duration = 15.9; // source replaced by a shorter file
      ed.drag("c_x", "trim-r", 4, 6);
      assert.ok(ed.clip("c_x").duration >= MIN_DUR, `duration ${ed.clip("c_x").duration}`);
    });

  test("BUG-02: given a clip saved without `in`, when loaded and split, then in is 0 and stays finite",
    () => {
      const ed = load("legacy");
      assert.equal(ed.clip("c_bare").in, 0);
      ed.select("c_bare").at(2).split();
      assert.ok(Number.isFinite(pieceAt(ed, "V2", 2).in));
    });

  test("BUG-03: given a UI edit then an agent write, when the user undoes, then the agent's edit is not reverted",
    async () => {
      const ed = load("linked-av").at(4);
      ed.split();
      const agent = loadFixture("linked-av");
      agent.revision = 10;
      find(agent, "c_song").props.volume = 1;
      await ed.externalWrite(agent);
      ed.undo();
      assert.equal(ed.clip("c_song").props.volume, 1);
    });

  test("BUG-04: given a media entry removed with its clips, when undone, then the media entry comes back too",
    () => {
      const ed = load("linked-av");
      ed.pushUndo(); // what the bin's delete button does, then:
      ed.project.media = ed.project.media.filter((m) => m.id !== "m_song");
      ed.project.clips = ed.project.clips.filter((c) => c.mediaId !== "m_song");
      ed.undo();
      assert.ok(ed.project.media.some((m) => m.id === "m_song"));
    });

  test("BUG-04: given the bin's remove on a media entry, when undone and redone, then media and clips come back and go again as one step",
    () => {
      const ed = load("linked-av").select("c_song");
      const before = clone({ media: ed.project.media, clips: ed.clips() });
      ed.removeMedia("m_song");
      assert.equal(ed.clip("c_song"), undefined);
      assert.equal(ed.history().undo, 1, "one undo step");
      ed.undo();
      assert.deepEqual(clone({ media: ed.project.media, clips: ed.clips() }), before);
      ed.redo();
      assert.ok(!ed.project.media.some((m) => m.id === "m_song"));
      assert.equal(ed.clip("c_song"), undefined);
      assert.equal(ed.state.selIds.size, 0, "the removed clip is no longer selected");
    });

  test("BUG-04: given clips deleted and their lane removed, when undone, then the lane comes back for them",
    () => {
      const ed = load("linked-av").select("c_song");
      ed.deleteSelected();
      const lanes = ed.api.tracks();
      lanes.splice(lanes.findIndex((t) => t.id === "A3"), 1); // what Remove track does to an empty lane
      ed.project.tracks = ed.project.tracks.filter((t) => t.id !== "A3");
      ed.undo();
      assert.equal(ed.clip("c_song").track, "A3");
      assert.ok(ed.tracks().includes("A3"));
      assert.ok(ed.save().tracks.some((t) => t.id === "A3"), "and it is saved");
    });

  test("D3: given a lane toggle, IN/OUT and a marker change after an edit, when the edit is undone, then those later changes stay",
    () => {
      const ed = load("linked-av").at(4);
      ed.split();
      ed.disable("A3");
      ed.project.inPoint = 2;
      ed.project.markers.push({ t: 7 });
      ed.undo();
      assert.equal(ed.clips().length, 7, "the split is undone");
      assert.deepEqual(ed.project.disabledTracks, ["A3"]);
      assert.equal(ed.project.inPoint, 2);
      assert.equal(ed.project.markers.length, 3);
    });

  test("BUG-05: given a styled title, when saved, then styleName survives",
    () => {
      assert.equal(find(load("keyframes-transitions").save(), "c_t").styleName, "impact");
    });

  test("BUG-06: given a linked video, when its start is edited in the inspector, then the stems move with it (clamped at 0) in one undo step",
    () => {
      const ed = load("linked-av");
      ed.inspect("c_v", "start", 2);
      for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id).start, 2, id);
      ed.inspect("c_v", "start", -3);
      for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id).start, 0, id);
      ed.undo();
      for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id).start, 2, id);
    });

  test("BUG-06: given a linked stem, when its length is edited in the inspector, then the picture and the other stem follow (≥ MIN_DUR)",
    () => {
      const ed = load("linked-av");
      ed.inspect("c_l", "duration", 5);
      for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id).duration, 5, id);
      ed.inspect("c_l", "duration", 0);
      for (const id of ["c_v", "c_l", "c_r"]) assert.equal(ed.clip(id).duration, MIN_DUR, id);
    });

  test("BUG-06: given a linked video, when its static speed is edited in the inspector, then the stems play at that speed too",
    () => {
      const ed = load("linked-av");
      ed.inspect("c_v", "speed", 2);
      for (const id of ["c_l", "c_r"]) assert.equal(ed.clip(id).props.speed, 2, id);
    });

  test("BUG-06: given a ramped linked video, when a speed key is edited at the playhead, then the stems get the same ramp (own copies)",
    () => {
      const ed = load("speed-ramp").at(1);
      assert.equal(ed.inspect("c_ramp", "speed", 2), true);
      const ramp = ed.clip("c_ramp").keyframes.speed;
      assert.ok(ramp.some((k) => Math.abs(k.t - 1) < 1e-9 && k.v === 2), "a key at the playhead");
      for (const id of ["c_ramp_l", "c_ramp_r"]) {
        assert.deepEqual(ed.clip(id).keyframes.speed, ramp, id);
        assert.notEqual(ed.clip(id).keyframes.speed, ramp, `${id}: not the same array`);
      }
    });

  test("BUG-07: given a ramped linked video, when its left edge is dragged, then the stems keep identical speed keyframes",
    () => {
      const ed = load("speed-ramp");
      ed.drag("c_ramp", "trim-l", 0, 1);
      for (const id of ["c_ramp_l", "c_ramp_r"])
        assert.deepEqual(ed.clip(id).keyframes?.speed, ed.clip("c_ramp").keyframes?.speed, id);
    });

  test("BUG-08: given a 2× linked video with a 3-channel source, when channels reconcile, then the new stem is 2× too",
    async () => {
      const m = { ...build.media("m_3ch", "video", 20), channels: 3 };
      const v = build.clip("c_v", { mediaId: "m_3ch", duration: 4, props: { speed: 2, volume: 0 } });
      const stem = (id, ch, track) => build.clip(id, {
        mediaId: "m_3ch", kind: "audio", track, duration: 4, props: { speed: 2, audioChannel: ch, pan: ch ? 1 : -1 },
      });
      const ed = createEditDriver(build.project({ media: [m], clips: [v, stem("c_s0", 0, "A1"), stem("c_s1", 1, "A2")] }));
      await ed.reconcileAudio("c_v");
      const added = ed.clips().find((c) => c.kind === "audio" && c.props.audioChannel === 2);
      assert.ok(added, "third stem created");
      assert.equal(added.props.speed, 2);
    });

  test("BUG-08: given a ramped linked video with a 3-channel source, when channels reconcile, then the new stem has the same ramp",
    async () => {
      const m = { ...build.media("m_3ch", "video", 20), channels: 3 };
      const ramp = () => ({ speed: [{ t: 0, v: 1 }, { t: 2, v: 3, ease: "linear" }] });
      const v = build.clip("c_v", { mediaId: "m_3ch", duration: 4, props: { volume: 0 }, keyframes: ramp() });
      const stem = (id, ch, track) => build.clip(id, {
        mediaId: "m_3ch", kind: "audio", track, duration: 4, props: { audioChannel: ch, pan: ch ? 1 : -1 }, keyframes: ramp(),
      });
      const ed = createEditDriver(build.project({ media: [m], clips: [v, stem("c_s0", 0, "A1"), stem("c_s1", 1, "A2")] }));
      await ed.reconcileAudio("c_v");
      const added = ed.clips().find((c) => c.kind === "audio" && c.props.audioChannel === 2);
      assert.deepEqual(added.keyframes?.speed, ed.clip("c_v").keyframes.speed);
      assert.notEqual(added.keyframes.speed, ed.clip("c_v").keyframes.speed, "its own copy");
      assert.equal(added.props.pan, 0, "center channel: centered");
    });

  test("BUG-09: given a stem on a disabled lane, when a gap is closed, then it moves with its linked group",
    () => {
      const ed = load("linked-av").disable("A2").untarget("A3").at(9);
      ed.closeGap();
      assert.equal(ed.clip("c_v2").start, 8);
      assert.equal(ed.clip("c_r2").start, 8);
    });

  test("BUG-10: given a stem on a disabled lane, when trimmed to IN/OUT, then it is trimmed with its linked group",
    () => {
      const ed = load("linked-av").disable("A2");
      ed.trimToWorkArea();
      assert.equal(ed.clip("c_v").start, 1);
      assert.equal(ed.clip("c_r").start, 1);
      assert.equal(ed.clip("c_r2"), undefined);
    });

  test("BUG-11a: given linkGroup ids on disk, when loaded, then they are kept",
    () => {
      assert.equal(load("linked-av").clip("c_v").linkGroup, "lg_cam");
    });

  test("BUG-11b: given a linked stem whose timing drifted, when loaded, then it stays linked (to be flagged, not dropped)",
    () => {
      const ed = load("linked-av", (d) => { find(d, "c_r").start = 0.5; });
      assert.equal(ed.clip("c_r").linkGroup, ed.clip("c_v").linkGroup);
    });

  test("BUG-11: given a picture and stems without a group, when loaded twice, then they get the same id lg_<video id> both times",
    () => {
      const strip = (d) => { for (const c of d.clips) delete c.linkGroup; };
      const a = load("linked-av", strip), b = load("linked-av", strip);
      for (const ed of [a, b]) {
        assert.deepEqual(["c_v", "c_l", "c_r"].map((id) => ed.clip(id).linkGroup), ["lg_c_v", "lg_c_v", "lg_c_v"]);
        assert.deepEqual(["c_v2", "c_l2", "c_r2"].map((id) => ed.clip(id).linkGroup), ["lg_c_v2", "lg_c_v2", "lg_c_v2"]);
      }
    });

  test("BUG-11: given a legacy linkedId pair, when loaded and saved, then it is one linkGroup and linkedId is gone",
    () => {
      const out = load("legacy").save();
      assert.deepEqual(["c_ov", "c_oa", "c_ob"].map((id) => find(out, id).linkGroup), ["lg_c_ov", "lg_c_ov", "lg_c_ov"]);
      for (const c of out.clips) assert.equal(c.linkedId, undefined, c.id);
    });

  test("BUG-12a: given a speed ramp, when split, then the right piece starts at the media time under the cut",
    () => {
      const ed = load("speed-ramp").select("c_ramp").at(3);
      const expected = ed.mediaTimeAt("c_ramp", 3);
      ed.split();
      near(pieceAt(ed, "V1", 3).in, expected, 1e-3);
    });

  test("BUG-12b: given a speed ramp, when the left edge is dragged, then the new in-point is the media time under it",
    () => {
      const ed = load("speed-ramp");
      const expected = ed.mediaTimeAt("c_ramp", 1);
      ed.drag("c_ramp", "trim-l", 0, 1);
      near(ed.clip("c_ramp").in, expected, 1e-3);
    });

  test("BUG-13: given a keyframed ramp, when split mid-ramp, then both pieces keep the value at the cut",
    () => {
      const ed = load("keyframes-transitions").select("c_a").at(2);
      ed.split();
      near(ed.valueAt("c_a", "opacity", 2, 1), 0.5, 1e-6, "left end");
      near(ed.api.kfChannel(pieceAt(ed, "V1", 2), "opacity", 0, 1), 0.5, 1e-6, "right start");
    });

  test("BUG-13: given keys past a shortened clip's end, when its tail is trimmed to the playhead, then the first one stays as the anchor and the rest go",
    () => {
      const ed = load("keyframe-anchors").select("c_len").at(2.5);
      const before = [0.5, 1, 2, 2.4].map((t) => ed.valueAt("c_len", "opacity", t, 1));
      ed.trimToPlayhead("out");
      assert.deepEqual(ed.clip("c_len").keyframes.opacity.map((k) => k.t), [0, 2, 4]);
      assert.deepEqual([0.5, 1, 2, 2.4].map((t) => ed.valueAt("c_len", "opacity", t, 1)), before);
    });

  test("BUG-14a: given keyframes, when the in-point is trimmed to the playhead, then keyframes keep their absolute times",
    () => {
      const ed = load("keyframes-transitions").select("c_a").at(1);
      ed.trimToPlayhead("in");
      assert.ok(ed.clip("c_a").keyframes.opacity.some((k) => Math.abs(k.t - 3) < 1e-3));
    });

  test("BUG-14b: given an in-transition, when the in-point is trimmed to the playhead, then the transition is cleared",
    () => {
      const ed = load("keyframes-transitions").select("c_b").at(5);
      ed.trimToPlayhead("in");
      assert.equal(ed.clip("c_b").transitionIn, undefined);
    });

  test("BUG-14c: given a title, when the in-point is trimmed to the playhead, then in stays 0",
    () => {
      const ed = load("keyframes-transitions").select("c_t").at(2);
      ed.trimToPlayhead("in");
      assert.equal(ed.clip("c_t").in, 0);
    });

  test("BUG-14d: given a playhead outside the clip, when trimmed, then no undo entry is recorded",
    () => {
      const ed = load("keyframes-transitions").select("c_a").at(10);
      ed.trimToPlayhead("out");
      assert.equal(ed.history().undo, 0);
    });

  test("BUG-15: given array props, when split, then the pieces do not share the arrays",
    () => {
      const ed = load("keyframes-transitions").select("c_t").at(2);
      ed.split();
      assert.notEqual(pieceAt(ed, "V2", 2).props.fontCutSet, ed.clip("c_t").props.fontCutSet);
    });

  test("BUG-16: given a long in-transition, when split close to the start, then the transition fits the shorter piece",
    () => {
      const ed = load("keyframes-transitions").select("c_b").at(4.5);
      ed.split();
      const left = ed.clip("c_b");
      assert.ok(left.transitionIn.duration <= left.duration, `${left.transitionIn.duration} > ${left.duration}`);
    });

  test("BUG-17: given lane V2 removed, when a title is added, then it lands on the highest video lane, as one undo step",
    () => {
      const ed = load("minimal");
      assert.equal(ed.removeTrack("V2"), true, "V2 is empty, so the UI removes it");
      assert.deepEqual(ed.tracks(), ["V3", "V1", "A1", "A2", "A3", "A4"]);
      const t = ed.at(2).addTitle();
      assert.deepEqual([t.kind, t.track, t.start], ["text", "V3", 2]);
      assert.equal(ed.history().undo, 1);
      ed.undo();
      assert.equal(ed.clip(t.id), undefined);
      ed.redo();
      assert.equal(ed.clip(t.id).track, "V3");
    });

  test("BUG-17: given lanes V5 and V1 only, when a title and an adjustment layer are added, then both land on V5; with V2 / V3 present they keep their usual lanes",
    () => {
      const tracks = [{ id: "V5", kind: "video" }, { id: "V1", kind: "video" }, { id: "A1", kind: "audio" }];
      const ed = createEditDriver(build.project({ tracks, media: [build.media("m_x")], clips: [build.clip("c_x", { mediaId: "m_x" })] }));
      assert.deepEqual([ed.addTitle().track, ed.addAdjust().track], ["V5", "V5"]);
      const usual = load("minimal");
      assert.deepEqual([usual.addTitle().track, usual.addAdjust().track], ["V2", "V3"]);
    });

  /* A bin double-click or library "+" passes no lane, so the editor picks one.
     A clip on a removed lane is not drawn until the next load. */
  const noLanesProject = () => createEditDriver(build.project({
    media: [build.media("m_v"), build.media("m_a", "audio"), { ...build.media("m_s", "svg"), duration: undefined }],
  }));

  test("BUG-28: given V1 removed, when footage is added from the bin, then it lands on the lowest video lane and its stems on the audio lanes",
    () => {
      const ed = noLanesProject();
      assert.equal(ed.removeTrack("V1"), true);
      const v = ed.addFromMedia("m_v", { at: 1 });
      assert.equal(v.track, "V2");
      assert.ok(ed.tracks().includes(v.track), "the clip is on a lane that exists");
      const stems = ed.clips().filter((c) => c.linkGroup === v.linkGroup && c.kind === "audio");
      assert.deepEqual(stems.map((c) => c.track), ["A1", "A2"]);
    });

  test("BUG-28: given V3 and A1 removed, when an svg and an audio file are added, then they land on the highest video lane and the first audio lane",
    () => {
      const ed = noLanesProject();
      assert.equal(ed.removeTrack("V3"), true);
      assert.equal(ed.removeTrack("A1"), true);
      assert.equal(ed.addFromMedia("m_s").track, "V2");
      assert.equal(ed.addFromMedia("m_a").track, "A2");
    });

  test("given the usual lanes, when media is added without a lane or dropped on the wrong kind of lane, then footage goes to V1, svg to V3 and audio to A1",
    () => {
      const ed = noLanesProject();
      assert.deepEqual(["m_v", "m_s", "m_a"].map((id) => ed.addFromMedia(id).track), ["V1", "V3", "A1"]);
      assert.equal(ed.addFromMedia("m_a", { track: "V2" }).track, "A1", "audio dropped on a video lane");
      assert.equal(ed.addFromMedia("m_v", { track: "A3" }).track, "V1", "footage dropped on an audio lane");
      assert.equal(ed.addFromMedia("m_v", { track: "V2" }).track, "V2", "a valid lane is kept");
    });
});
