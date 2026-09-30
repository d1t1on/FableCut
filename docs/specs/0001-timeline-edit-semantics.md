# 0001: Timeline edit semantics

**Status:** Accepted. D1–D3, D6 and D7 are the approved defaults of the
hardening plan. D4 and D5 were decided by the maintainer on 2026-09-24. D3 was
revised in step 3b (snapshots hold the document content, not every field).
**Implemented by:** Phase 3, steps 3b–3d, test-first. Each decision below
names the tests that pin it. **Implemented (3b):** D1, D2, D3, and the BUG-24 /
BUG-25 items of D6. **Implemented (3c):** D5, and the BUG-12, BUG-23 and BUG-26
items of D6 (time mapping). **Implemented (3d):** D4, the rest of D6
(BUG-14a/b/d, BUG-15, BUG-16, BUG-22, and BUG-27 found in review) and D7.
Every decision is implemented; no `todo` test is left.
**Invariants:** [invariants.md](invariants.md).

## Context

The timeline core (`core/edit.js`, `core/links.js`, `core/keyframes.js`,
`core/history.js`, `core/project.js`) was extracted from `app.js` with its
behavior unchanged, bugs included. The property tests (`test/props/`) state
what editing must preserve and found eight more bugs (BUG-19 to BUG-26). This
document records how the editor *should* behave wherever today's behavior is a
bug, or wherever there was no rule, so the fixes all follow one set of
semantics.

Terms:

- **Link group:** a picture clip and its per-channel audio stems, which share a
  `linkGroup` id.
- **Timed kinds:** clips whose `in` is a position in a source (see D5).
- **Retained time:** timeline time that a clip covers both before and after an
  edit.

---

## D1: Link groups on disk are authoritative (BUG-11)

**Status:** implemented (3b).

**Decision.** `linkGroup` ids survive every load unchanged. On load,
`relinkClips` only links clips that have **no** group yet, by matching timing,
and gives such a group the deterministic id `lg_<video clip id>`. A member whose
timing drifted from its group **stays linked**. The validator reports it as
LINK_DESYNC, and nothing is unlinked silently.

- A legacy pairwise `linkedId` becomes a group (the partner's group if it has
  one, else `lg_<video id>`, else `lg_<first member's id>`), whatever its
  timing, and `linkedId` is dropped.
- An ungrouped audio clip whose `mediaId` and start / in / duration (±1e-3)
  match a video joins that video's group, or a new `lg_<video id>` group.
- A new id never reuses one on disk: `lg_<id>_2`, `_3`, … if the name is taken.
- `relinkClips` and `normalizeProject` no longer take an id factory.

**Why.** A link is a decision somebody made: the importer, an agent, or the user.
Timing drift is a problem to report, not a reason to break the pairing. Once a
drifted stem is unlinked, the next move of the picture leaves its sound behind.
Deterministic ids make a save/load round trip exact, and they keep diffs of
`project.json` quiet.

**Pinned by.** `edit-ops` BUG-11a, BUG-11b and the two BUG-11 tests (the same
`lg_<video id>` on every load; a legacy pair becomes one group). `test/core/links.test.js`
relinkClips tests (ids kept, drift kept, adoption by timing, legacy pairs, no id
collision) and `test/core/project.test.js` normalizeProject tests. INV-12b
(every schema field survives load + save) and INV-12c (an edited timeline
survives a reload, link groups included).

## D2: Group-wide edits (BUG-06, 07, 08, 09, 10, 21)

**Status:** implemented (3b).

**Decision.** A link group is one piece of footage. Split, delete, close gap
and trim to IN/OUT act on whole link groups, including members on disabled
lanes. A disabled lane is hidden from preview and export. It is not unlinked.

- `syncLinkedTiming` copies `keyframes.speed` along with `start`, `in`,
  `duration` and `props.speed` (BUG-07). The speed part is its own
  `syncLinkedSpeed`: every partner gets its own deep copy of the ramp, and a
  partner of an unramped clip loses its ramp.
- `reconcileAudioChannels` (and the stems a video drop creates) give the stems
  the picture's speed and ramp (BUG-08).
- Inspector start / length edits go through `edit.setClipTiming(doc, c,
  { start, duration }, ctx)`: start ≥ 0, duration ≥ MIN_DUR, the same timing
  for every member, then the partners take c's `in` and speed. Keyframes stay
  clip-local as typed (a shorter length keeps the keys past the end). Speed
  writes (static or keyed, the ◆ toggle, resets, clearing a channel) call
  `syncLinkedSpeed` from app.js `applyKfEffects` (BUG-06). app.js routes the
  inspector through `applyInspectorField`; the driver calls it as `inspect`.
- **New:** a trim or edge drag re-bases every partner's keyframes by the same
  offset as the clip that was dragged, so a stem's volume fade keeps its place
  on the timeline (BUG-21). `beginDrag` keeps every member's pointerdown
  keyframes; `dragTo` applies the same edge change to each member and then
  syncs the timing. Trim to IN/OUT trims each member by its own span, which is
  the same span. Trim to playhead re-bases every member the same way (BUG-14a,
  3d), and every member loses the trimmed edge's transition.
- Close gap and trim to IN/OUT take the linked partners of the clips they act
  on, on any lane (BUG-09, BUG-10). An unlinked clip on a disabled lane is
  still left alone.

**Why.** Every group-wide rule exists so that a picture and its stems never
drift apart, whichever lane is enabled or whichever member was grabbed.

**Pinned by.** `edit-ops` BUG-06 (start, length, static and keyed speed),
BUG-07, BUG-08 (static speed and ramp), BUG-09 and BUG-10. `regressions`
BUG-21 (head and tail drags). `test/core/edit.test.js` setClipTiming,
trimToRange, closeGapAt and dragTo tests; `test/core/links.test.js`
syncLinkedTiming / syncLinkedSpeed. INV-04a (with the new `setTiming` op:
inspector start / length / speed), INV-04b, INV-04c, INV-04d, INV-14b and
INV-09c; INV-06b since 3d.

## D3: Undo covers the document content (BUG-04) — revised in 3b

**Status:** implemented (3b).

**Decision (revised).** An undo snapshot holds the document **content**:
`clips`, `media` and `folders` (`core/project.js` `snapshotContent`, still a
string, so `core/history.js` stays generic). It deliberately leaves out
markers, IN/OUT, the lane list and lane enable/disable: those changes are not
undo steps (`toggleTrackEnabled`, `setInPoint`, `toggleMarker` never call
`pushUndo`), so snapshotting them would let undoing an *earlier* edit silently
revert a *later* toggle. An external write (an agent, MCP) still resets the
history (BUG-03).

Restoring a snapshot (`restoreContent`):

- Lanes grow to cover the restored clips. A lane removed after its clips were
  deleted comes back with them; app.js rebuilds `TRACKS` and the timeline DOM.
- What is not an edit keeps its live value: media facts probed since the
  snapshot (`duration`, `width`, `height`, `channels`) and a folder's
  open / closed state.
- The app prunes the selection, releases the media element of a clip that
  vanished or changed source, and re-renders the bin.

The same rule applied to the content fields: every UI action that changes
media or folders is now an undo step, so no content change is ever reverted
by undoing an earlier one. That is the bin's delete (`removeMediaFromBin`
→ `edit.removeMedia`, one step for the entry and its clips), an import (one
step per batch of files, URL import, a library file's first use), and folder
add / delete / rename / move and moving media between folders. A drag that
changes nothing records no step (BUG-25, D6).

**Why.** The bin's delete button removes a media entry together with its
clips. An undo that restores only the clips leaves them pointing at media
that no longer exists (MEDIA_NOT_FOUND errors on disk). That is data
corruption, not a cosmetic issue.

**Pinned by.** `edit-ops` BUG-04 (the bin's delete undone and redone as one
step; a removed lane restored for its clips) and D3 (a later lane toggle,
IN/OUT and marker survive the undo of an earlier edit).
`test/core/project.test.js` snapshotContent / restoreContent. INV-11b
(whole-document round trip after a media removal), INV-11a (now with
inspector edits), and INV-11f, whose model now includes lane toggles and
checks that undo / redo never revert one.

## D4: Keyframes across a cut: anchor keys (BUG-13, BUG-14a). DECIDED

**Status:** implemented (3d).

**Decision (option b, anchors).** When a split or trim cuts through an animated
channel, each piece keeps **at most one** keyframe just before `0` and **at
most one** just after `duration`, per channel. These anchor keys are the
nearest originals outside the piece. With them, the original segment keeps
interpolating exactly: rendered props are unchanged for **every** ease, not
only for linear segments. Keys beyond the anchors are dropped. Speed ramps
work the same way, so `mediaTimeAt` of a piece matches the original.

The cut applies wherever keyframes are re-based:

- `splitClipAt`
- `trimToRange`
- edge drags
- `trimClipTo`, which did not re-base keyframes at all before 3d (BUG-14a)
- linked partners (D2, BUG-21)
- `capToSource` (a replaced, shorter source; BUG-27)

**Algorithm** (`keyframes.shiftKF(kfs, offset, dur)`, the one re-base every
op above calls):

1. Shift each key by `−offset`, round `t` to 0.1 ms, copy it, sort the channel.
2. A key with `t ∈ [−1 ms, dur + 1 ms]` is **on the clip** (`KF_EPS`, the same
   slack the validator and INV-09 use) and stays.
3. Of the keys before, only the last stays; of the keys after, only the first.

A key exactly on an edge still leaves the nearest outside key as an anchor:
one rule, and extending the edge later reveals the original curve.

**What reads keys.**

- Rendering and the ramp integral read every key (`kfChannel` interpolates
  across an anchor). `keysOnClip(c, k)` is the view the UI and the playhead
  helpers use.
- `kfAtPlayhead`, `setAnimProp` and `toggleKfAtPlayhead` see only keys on the
  clip: an anchor half a frame outside an edge is never "at the playhead",
  never overwritten by an auto-key, never toggled. Removing the **last key on
  the clip** removes the channel, anchors included (its value becomes the
  static prop), so no invisible animation is left behind.
- app.js: timeline diamonds (`clipKeyframeGroups` / `clipKeyframesHtml`),
  keyboard navigation (`goToKeyframe` via `clipKeyframeLocalTimes`), the graph
  (`kfGraphRange` zooms to keys on the clip and ranges over the curve's values
  at the clip's edges; `drawKfGraph` draws no anchor diamond) and the
  inspector (◆n counts keys on the clip; `has` and ✕ follow the channel, so a
  curve shaped only by anchors still reads as animated and can be cleared).
- **Head extension.** A trim-l drag to the left integrates the curve before
  `0`: `keyframes.headRamp(c)` walks mediaTimeAt's 1/120 s grid back from 0
  across the anchor's segment and holds the first key's value beyond it
  (closed form there, and exact everywhere when no key sits before 0). The new
  `in` is `in − back(e)`; the edge stops where `back(e) = in`. This replaces
  3c's `in / speedAtStart`. One solve per gesture, cached on the drag.
- Trim-r's cap (`keyframes.durationUntil`) needed no change: it integrates the
  ramp from 0, anchors on both sides included.

**Validator and schema.** The schema's keyframe `t ≥ 0` minimum is gone (JSON
Schema cannot say "at most one key below 0"). The semantic layer allows one key
before `−1 ms` and one past `duration + 1 ms` per channel, the nearest ones,
whatever the order; every other key outside is KEYFRAME_OUT_OF_RANGE, with the
anchor named in the message. `schema/project.schema.json` is regenerated.

**Rejected: option (a), interpolated boundary keys.** This option inserts a key
with the interpolated value exactly at each cut. The value at the cut is right,
but an eased segment is then interpolated in two halves, each with the full
ease curve, so its shape changes: an ease-in-out becomes two ease-in-outs.
Rendering would change for every eased channel, and on a speed ramp the media
mapping would change too.

**Pinned by.** `edit-ops` "BUG-13: given a keyframed ramp, when split mid-ramp,
then both pieces keep the value at the cut", "BUG-14a: given keyframes, when
the in-point is trimmed to the playhead, then keyframes keep their absolute
times", and "given keyframes, when split, then the right piece's keyframe
times are re-based to its start, the key before the cut kept as an anchor
(D4)". `regressions` "BUG-13: given a lone 0.25× speed key at 0.132 s, …",
"BUG-13: given an eased speed ramp split mid-segment, …" and "BUG-13: given
the right piece of a split ramp, when its left edge is dragged back over the
cut, then in follows the original ramp". `test/core/keyframes.test.js`
"shiftKF: … one anchor per side (D4)", "anchors keep a cut segment
interpolating exactly, for every ease (D4)", "keysOnClip / kfAtPlayhead: …",
"setAnimProp / toggleKfAtPlayhead: never write an anchor; …", "headRamp: …".
`test/core/edit.test.js` "dragTo trim-l on a ramp with an anchor before 0: …".
`test/core/validate.test.js` "anchors: one key before 0 and one past the end
per channel draw no issue (D4)" and the two KEYFRAME_OUT_OF_RANGE cases.
`test/keyframes.test.js` "syncInspectorPlayhead: anchors outside the clip are
not counted and never … (D4)" and "anchors: no timeline diamonds, no
navigation stops, graph zoomed to the keys on the clip (D4)". INV-06a (split)
and INV-06b (trims) at every retained time for all eases; INV-09a/b/c (sorted,
inside `[0, dur]` ± 1e-3 except one anchor per side); INV-05b, INV-07c,
INV-10b and INV-10d for speed ramps; INV-01c (edits add no
KEYFRAME_OUT_OF_RANGE).

## D5: Which clips have a meaningful `in`. DECIDED

**Status:** implemented (3c).

**Decision.** **Video, audio and svg are timed kinds.** Their `in` is a
position in the source. For svg that is animation time: `getSvgImage` renders
the frame at `mediaTimeAt(c, t)`. Splits and trims of timed clips keep that
mapping continuous, exactly like video. Trim-l advances `in` through
`mediaTimeAt`. Extending an svg clip's left edge stops at `in = 0`, like media
does. **Image, text and adjust always keep `in == 0`.** They have no source
time, and a non-zero `in` there is noise that splits and trims keep adding.

**Implementation.** `core/schema.js` exports `TIMED_KINDS` (video, audio,
svg); `core/edit.js` tests it wherever `in` is written:

- split: the right piece's `in` is `mediaTimeAt(c, t)` for timed kinds, else
  0 (BUG-19);
- trim-l drag and trim to IN/OUT keep the mapping for svg too, instead of
  resetting it to 0 (BUG-20). Extending an svg's head stops at `in = 0`;
- trim to playhead ("in") leaves image/text/adjust at `in = 0` (BUG-14c).

The trim-r cap still applies to video/audio only: an svg has no media end
(its media entry has no probed `duration`), like MEDIA_OVERRUN in the
validator. The schema's `in` description now reads "media time (video/audio)
or animation time (svg); 0 for image/text/adjust" (`core/schema.js`, the
generated schema, CLAUDE.md).

**Load.** `normalizeProject` sets `in = 0` on every image/text/adjust clip.
Nothing reads `in` for those kinds (checked in app.js: `drawClip` draws an
image from its element, `drawText` and `drawAdjust` take `t − c.start`,
`evalProps` works in clip-local time, `syncMedia` and the export mix skip
them; only svg goes through `mediaTimeAt`, in `getSvgImage` /
`prepareSvgFrame`), so the value on disk was noise that splits and trims
kept adding to. The next save writes 0. No validator code: agents who write
another value lose nothing.

**Pinned by.** `edit-ops` BUG-14c. `regressions` "BUG-19: given a title, when
split, then the right piece keeps in == 0" and both "BUG-20: given an svg clip
with in 1, …" tests. `test/core/edit.test.js` "D5: svg clips keep their
animation time across split, trim to playhead, trim to IN/OUT and trim-l;
image/text/adjust keep in 0". `test/core/project.test.js` "normalizeProject:
image/text/adjust clips load with in = 0; video/audio/svg keep theirs (D5)".
INV-07d (svg keeps the retained animation time), INV-07e (trims keep
`in == 0`), INV-07f (splits keep `in == 0`). INV-05a already checks svg
pieces.

## D6: Split and trim hygiene (BUG-12, 14b, 14d, 15, 16, 22, 23, 24, 25, 26, 27)

**Status:** implemented (3b: BUG-24, BUG-25; 3c: BUG-12, BUG-23, BUG-26; 3d:
the rest).

**Decision.**

- **Deep-copy props on split (BUG-15).** No two clips share an array or object:
  the right piece gets a JSON copy of `props`, and `shiftKF` copies every key.
- **Transitions fit after every split, trim and edge drag** (BUG-16 for
  splits, BUG-22 for trims): each ≤ `duration`, and `transitionIn +
  transitionOut` ≤ `duration`. What has to go comes off the **edited edge's**
  transition first, then the other one; a transition squeezed to nothing is
  removed; a shortened one is a new object (`edit.fitTransitions`).
- **Keyboard trims act like a cut (BUG-14b):** trim to playhead, like trim to
  IN/OUT and like a split, drops the transition on the edge it trims (on every
  link-group member). **Edge drags keep it**, fitted to the new length from its
  pointerdown length, so dragging back out within the same gesture gives it
  back. Rule: a cut removes the edge; a drag moves the edge.
- **Nothing recorded for a no-op.**
  - A trim to playhead that leaves nothing to trim (the playhead outside the
    clip, or within `minDur` of the far edge) is refused before
    `beforeChange`: no undo step, reason `"nothing"` (BUG-14d).
  - A drag whose clamped result is unchanged records no undo step either
    (BUG-25, implemented in 3b). The gesture compares its pointerdown
    snapshot before pushing it.
- **Source time comes from `mediaTimeAt`, never from static speed.**
  Implemented in 3c, except where noted.
  - Split, trim-l, trim to playhead and trim to IN/OUT all set the new `in` to
    `mediaTimeAt(original, new edge)` (BUG-12). A trim-l drag reads it from
    its pointerdown copy of the clip. Dragged left, past the clip start, `in`
    falls at the speed held before the first key, and the edge stops where
    `in` reaches exactly 0: `in / speedAtStart` before the start, not
    `in / static speed`. See D4 for what anchors change here.
  - Trim-r caps the duration where the ramp reaches the media end (BUG-23):
    `keyframes.durationUntil(clip, media.duration)`, the original ramp with
    its last key held past the end. It is solved on `mediaTimeAt`'s own grid:
    closed form past the last key, a bisection inside the last grid step
    before it. A clip of that length plays to the media end ± float noise
    (well under 1e-6 s). One solve per gesture, cached on the drag.
  - A source replaced by a shorter file (the inspector's Source picker,
    `edit.capToSource`) caps `in`, then cuts where the ramp reaches the new
    end — `durationUntil`, not `(media − in) / static speed` (BUG-27, 3d) —
    re-basing keys with anchors and fitting transitions like a trim-r. Every
    link-group member gets the same cap.
  - `in` is clamped to exactly ≥ 0, so no float residue like −5.6e-17 is saved
    as a validation error (BUG-24, implemented in 3b: a trim-l clamped at the
    media start lands on `in = 0`, one clamped at the tail on `MIN_DUR`).
  - `mediaTimeAt` interpolates the last, partial grid step over its real
    length, and sums the grid in a `Float64Array` (BUG-26). The cache and its
    key are unchanged. The validator's MEDIA_OVERRUN uses it, so its verdict
    near the end of a ramp is now exact too (it used to underestimate by up
    to `speed × 1/480` s).

**Why.** Each rule keeps an edit from changing what plays, from leaving a
document the validator rejects, or from recording an undo step that does
nothing.

**Pinned by.**

- `edit-ops`: BUG-12a, BUG-12b, BUG-14b, BUG-14d, BUG-15, BUG-16.
- `regressions`: the three BUG-12 tests "BUG-12: given a speed ramp, when its
  head is trimmed …", "BUG-12: given a speed ramp, when trimmed to an IN
  marker, …" and "BUG-12: given a ramp that starts at 3×, …" (trim to
  playhead, trim to IN, the ramp-aware left limit),
  BUG-22 to BUG-26 (BUG-23: a constant 2× ramp and a 1×→2.5× ramp stop on the
  media end ± 1e-6 s; BUG-26: a 0.501 s clip at 2× ends on 1.002), and
  "BUG-27: given a linked speed ramp, when its media is replaced by a shorter
  file, then the group is cut where the ramp reaches the new end".
- `test/core/edit.test.js` "splitClipAt: the pieces own their props (BUG-15)
  and each keeps its outer transition, fitted to the piece (BUG-16)",
  "trimClipTo: acts like a cut — …", "trimClipTo: nothing to trim → refused,
  no beforeChange (BUG-14d)", "trimClipTo: every link-group member re-bases
  its own keyframes and loses the trimmed edge's transition" and "capToSource:
  … (BUG-27)".
- `test/core/keyframes.test.js` "durationUntil: …" and "mediaTimeAt ramp: …"
  (a partial last step is exact); `test/core/edit.test.js` "splitClipAt: the
  right piece starts at the media time under the cut, ramps included
  (BUG-12)" and "dragTo trim-l on a ramp: …".
- Properties: INV-02b, INV-08b, INV-08c, INV-11d, INV-11e, INV-01b, INV-01c,
  INV-05b, INV-05c, INV-07c, INV-10b, INV-10c — all passing since 3d.

## D7: Robust defaults (BUG-17, BUG-18, BUG-28)

**Status:** implemented (3d).

**Decision.** New titles and adjustment layers go on their preferred lane (V2 /
V3) if it exists, else on the highest existing video lane (BUG-17; app.js
`overlayLane`). Media added without a lane (bin double-click, library +) or
dropped on the wrong kind of lane follows the same rule (BUG-28; app.js
`defaultTrackFor`): footage/images on V1, else the lowest video lane; svg on
V3, else the highest video lane; audio on A1, else the first audio lane. An ease name is looked up as an own property of `EASE`
(`keyframes.easeOf`, the only dynamic `EASE[…]` lookup in core/ and app.js), so
`"__proto__"` or `"constructor"` falls back to linear instead of throwing
(BUG-18).

**Pinned by.** `edit-ops` "BUG-17: given lane V2 removed, when a title is
added, then it lands on the highest video lane, as one undo step" and "BUG-17:
given lanes V5 and V1 only, …" (the driver's `addTitle` / `addAdjust` /
`removeTrack` run the real app.js code); "BUG-28: given V1 removed, when
footage is added from the bin, …", "BUG-28: given V3 and A1 removed, …" and
"given the usual lanes, when media is added without a lane …" (the driver's
`addFromMedia` runs the real `addClipFromMedia`). `test/core/keyframes.test.js`
"BUG-18: given an ease named like an Object.prototype member, …". The
property generator only writes valid eases, and the schema rejects the others.

---

## Notes (Phase 3)

- **Order** (plan, by severity):
  1. S1: BUG-04. Done (3b).
  2. S2: BUG-06 to BUG-11 and BUG-21. Done (3b).
  3. S3: BUG-12 to BUG-16, BUG-19, BUG-20, BUG-22, BUG-23 and BUG-26.
     BUG-12, BUG-14c, BUG-19, BUG-20, BUG-23 and BUG-26 done (3c); BUG-13,
     BUG-14a/b/d, BUG-15, BUG-16 and BUG-22 done (3d).
  4. S4: BUG-17, BUG-18, BUG-24 and BUG-25. BUG-24 and BUG-25 done (3b);
     BUG-17 and BUG-18 done (3d), with BUG-27 (found in review) and BUG-28
     (media added from the bin after its default lane was removed).
- **Fixing a bug.** Remove its `todo` from `test/edit-ops.test.js` or
  `test/core/regressions.test.js`, and from every property that names it. Watch
  them fail, fix `core/`, watch them pass. A property that lists several bugs
  goes green only when the last one is fixed.
- **Precision.** `mediaTimeAt` sums a ramp on a 1/120 s trapezoid grid in a
  `Float64Array` (3c; it was float32, which drifted about 1 ms after 45 s of
  source). What is left is the trapezoid rule on eased segments, far below
  the 1e-3 s the properties allow. That error is per eased segment, not per
  second, so since 3d the generator puts ramps on clips of any length (up to
  its 12 s maximum).
