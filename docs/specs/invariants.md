# Timeline invariants

What must hold for every project the editor can reach, whatever the agent
wrote and whatever the user did to it. Each invariant is a fast-check property
in `test/props/` (the id leads the test title), run on generated **valid**
projects (`test/support/arb.js`) and random op sequences
(`test/support/ops.js`) through the real `core/` ops, wired the way `app.js`
wires them.

- `npm test` runs every property at 100 runs; `npm run test:props` at 1000
  (CI, Node 24). A failure prints fast-check's seed, the shrunk counterexample
  and the op log. Replay it with `FC_SEED=<seed> npm run test:props`. To jump
  straight to the shrunk case, add `FC_PATH=<path>` and narrow the run to that
  one property, e.g.
  `npm run test:props -- --test-name-pattern=INV-14b test/props/inv-14-gap.test.js`.
- A property that fails is marked `todo: "BUG-xx: …"` until its bug is fixed.
  Fixing the bug means removing the todo, watching it fail, then making it
  pass. Each new bug also has a minimal deterministic test in
  `test/core/regressions.test.js` (BUG-19 and up). BUG-01 to BUG-18 are in
  `test/edit-ops.test.js`. Since Phase 3 step 3d no todo is left: every row
  below passes at 1000 runs (`npm run test:props`), and did at 5000.
- Where an invariant fails for more than one reason, it is split into variants
  (a, b, …) by op family or clip class, so each todo names exactly the part
  that fails.
- The decisions behind the invariants (D1–D7) are in
  [0001-timeline-edit-semantics.md](0001-timeline-edit-semantics.md).

Op families: **split** = split at playhead (all or a selection) and split at
IN/OUT. **trims** = trim to playhead (in/out), trim to IN/OUT, and left/right
edge drags. **move**, **delete**, **close gap**. The helpers (lane toggle,
undo, redo) are mixed into every sequence. Two ops belong to no family and
are named by the properties that use them: **removeMedia** (the bin's delete)
and **setTiming** (an inspector start / length / speed edit). INV-15 runs no
sequences: it checks each **timeline patch op** (Phase 4, `core/patch.js`)
once per generated project, against the same action through the editor.
Tolerances: 1e-9 s on edges; 1e-3 s on media time (the ramp integral runs on a
1/120 s trapezoid grid); 1e-3 s on keyframe times.

| id | statement | enforced in | test | status |
|---|---|---|---|---|
| GEN-01 | Every generated project and its normalized form validate with zero errors (the raw project with zero warnings too: media bound, keyframes, transitions, lanes) | `test/support/arb.js` | `test/props/generators.test.js` | passing |
| GEN-02 | The generator reaches every shape the invariants talk about | `test/support/arb.js` | `test/props/generators.test.js` | passing |
| GEN-03 | Every op kind resolves against any doc and goes ahead somewhere | `test/support/ops.js` | `test/props/generators.test.js` | passing |
| INV-01a | No op sequence adds a validation error (every op except the left-edge drag, plus removeMedia and setTiming) | every `core/edit.js` op, checked by `core/validate.js` `validateProject` / `newErrors` | `test/props/inv-01-03-integrity.test.js` | passing |
| INV-01b | A left-edge drag adds no validation error | `edit.dragTo` (trim-l: a clamped edge lands exactly on its bound) | same | passing |
| INV-01c | Splits, trims and edge drags (with moves, deletes, gap closes, lane toggles, undo / redo) add no KEYFRAME_OUT_OF_RANGE, KEYFRAMES_UNSORTED or TRANSITION_TOO_LONG warning: one anchor per side is legal (D4), transitions fit (D6) | `keyframes.shiftKF`, `edit.fitTransitions`, `validate` anchor rule | same | passing |
| INV-02a | Clip and media ids stay unique. Every mediaId, lane and disabled lane resolves | `edit.splitClipAt` (`ctx.newId`), `edit.removeClips` | same | passing |
| INV-02b | No two clips share a mutable object (props, arrays, keyframes, transitions) | `edit.splitClipAt` (deep `props` copy), `keyframes.shiftKF` (key copies) | same | passing |
| INV-03 | Every number is finite, start ≥ 0, duration ≥ MIN_DUR | clamps in `edit.dragTo`, `closeGapAt`, `trimToRange`, `splitClipAt` | same | passing |
| INV-04a | Link-group members share start, in, duration, props.speed and keyframes.speed after split, split at IN/OUT, delete, move and inspector timing edits (start, length, speed) | `links.withLinked`, `links.relinkSplitRights`, `links.syncLinkedSpeed`, `edit.splitSet` / `removeClips` / `dragTo` (move) / `setClipTiming` | `test/props/inv-04-links.test.js` | passing |
| INV-04b | …after trim to playhead and edge drags, speed ramps included | `links.syncLinkedTiming` (+ `syncLinkedSpeed`), `edit.dragTo` | same | passing |
| INV-04c | …after a gap close with a member on a disabled lane | `edit.planCloseGap` (movers + their partners) | same | passing |
| INV-04d | …after trim to IN/OUT with a member on a disabled lane | `edit.trimToRange` (targets + their partners) | same | passing |
| INV-05a | Split pieces tile the original exactly. At static speed, every timed piece (video/audio/svg) keeps the media mapping: `mediaTimeAt(piece, t) ≈ mediaTimeAt(orig, t)` ± 1e-3 | `edit.splitClipAt` | `test/props/inv-05-06-split.test.js` | passing |
| INV-05b | …and so do the pieces of a speed ramp | `edit.splitClipAt`, `keyframes.shiftKF` (D4 anchors), `keyframes.mediaTimeAt` | same | passing |
| INV-05c | `mediaTimeAt` of a speed ramp is `in + ∫speed dt` at every time in the clip (± 1e-3; the reference integrates exactly) | `keyframes.mediaTimeAt` (the last, partial grid step over its real length; Float64) | same | passing |
| INV-06a | Split pieces render the same props (`evalProps` without transitions, every ANIMATABLE key) as the original at every retained time, for every ease | `keyframes.shiftKF` (D4 anchors), `compose.evalProps` | same | passing |
| INV-06b | …and so do trimmed clips | `keyframes.shiftKF`, `edit.trimClipTo`, `edit.trimToRange`, `edit.dragTo` | `test/props/inv-06-07-trim.test.js` | passing |
| INV-07a | Trims never move the fixed edge. Trim to IN/OUT moves an edge only onto its marker | `edit.trimClipTo`, `edit.trimToRange`, `edit.dragTo` | same | passing |
| INV-07b | Trimmed video/audio at static speed keep the retained media mapping | same | same | passing |
| INV-07c | Trimmed speed ramps keep the retained media mapping | same + `keyframes.mediaTimeAt`, `keyframes.headRamp` (a head extended over an anchor) | same | passing |
| INV-07d | Trimmed svg clips keep the retained animation time (D5) | `edit.dragTo` (trim-l), `edit.trimToRange` (`schema.TIMED_KINDS`) | same | passing |
| INV-07e | Trims keep `in == 0` on image/text/adjust clips (D5) | `edit.trimClipTo` | same | passing |
| INV-07f | Splits keep `in == 0` on image/text/adjust pieces (D5) | `edit.splitClipAt` | same | passing |
| INV-08a | Moves, deletes and gap closes keep every transition ≤ its clip's duration | `edit.dragTo`, `removeClips`, `closeGapAt` | `test/props/inv-08-09-transitions-keyframes.test.js` | passing |
| INV-08b | …and so do splits | `edit.splitClipAt` + `fitTransitions` | same | passing |
| INV-08c | …and so do trims | `edit.trimClipTo`, `trimToRange`, `dragTo` + `fitTransitions` | same | passing |
| INV-09a | Keyframes stay sorted, every key t ∈ [0, dur] ± 1e-3 except at most one anchor before 0 and one after dur per channel (D4). Checked after splits, trim to IN/OUT, move, delete and gap close | `keyframes.shiftKF` | same | passing |
| INV-09b | …after trim to playhead | `edit.trimClipTo` (`shiftKF` on every member) | same | passing |
| INV-09c | …after edge drags, linked partners included | `edit.dragTo` (every member re-bases its own keyframes) | same | passing |
| INV-10a | The media bound (in ≥ 0, `in + ∫speed dt ≤ media.duration` + 1e-3) holds after every edit whenever it held before (static speed) | `edit.dragTo` (trim-r cap), `splitClipAt`, trims | `test/props/inv-10-media.test.js` | passing |
| INV-10b | …for speed ramps, after splits and left / IN / playhead trims | `edit.splitClipAt`, `trimClipTo`, `trimToRange`, `dragTo` (trim-l) — `in` from `mediaTimeAt` / `headRamp` | same | passing |
| INV-10c | …for speed ramps, after a right-edge drag that keeps every speed key (lengthening it, or shortening it no further than its last speed key) | `edit.dragTo` (trim-r cap: `keyframes.durationUntil`) | same | passing |
| INV-10d | …for speed ramps, after a right-edge drag that shortens a clip past a speed key | `keyframes.shiftKF` (D4 anchors) | same | passing |
| INV-11a | `undo(op(p)) ≡ p` for the whole document and `redo(undo(op(p))) ≡ op(p)` after any clip edit or inspector timing edit | `history.createHistory` + the app's `pushUndo` (`ctx.beforeChange`), `project.snapshotContent` / `restoreContent` | `test/props/inv-11-history.test.js` | passing |
| INV-11b | …after a media entry is removed with its clips (the bin's delete) | `edit.removeMedia`, `project.snapshotContent` (clips, media, folders — D3) | same | passing |
| INV-11c | A split, delete, gap close or trim to IN/OUT that changes nothing leaves the history unchanged | `edit.*` refusals (no `beforeChange`) | same | passing |
| INV-11d | …and so does a trim to playhead | `edit.trimClipTo` (refused "nothing" before `beforeChange`) | same | passing |
| INV-11e | …and so does a drag that ends where it started | the app's drag gesture (`startClipGesture` onUp compares its pointerdown snapshot) | same | passing |
| INV-11f | Over any edit / undo / redo / lane-toggle sequence the history matches a model stack, and undo / redo never revert a lane toggle (D3; fast-check `fc.commands`) | `history.createHistory`, `project.restoreContent` | same | passing |
| INV-12a | `normalize ∘ serialize` is idempotent: one save/load round reaches a fixed point, before and after edits | `project.normalizeProject`, `project.serializeProject` | `test/props/inv-12-13-roundtrip.test.js` | passing |
| INV-12b | Loading and saving a valid project preserves every schema field, `linkGroup` ids included | same + `links.relinkClips` (D1) | same | passing |
| INV-12c | An edited timeline survives save + reload, link groups included (ids compared up to renaming) | `links.relinkClips` (D1) | same | passing |
| INV-13 | The same project, ops and id generator give the identical document, log and history | every `core/` op, which takes its ids from `ctx` | same | passing |
| INV-14a | Closing a gap shifts clips by exactly the gap and never before the gap's start | `edit.planCloseGap`, `edit.closeGapAt` | `test/props/inv-14-gap.test.js` | passing |
| INV-14b | Closing a gap keeps the offsets inside every link group | `edit.planCloseGap` | same | passing |
| INV-15a | A patch op equals the editor's own edit (agent path `patch.patchProject` vs the UI path through `test/drivers/edit.js`; both documents normalized by load + save, generated ids renamed by creation order, the driver's history / selection / toasts left out): `splitClip {id \| ids \| all, t}` ≡ select + playhead + split | `core/patch.js` OPS → `edit.splitAt` | `test/props/inv-15-patch-equivalence.test.js` | passing |
| INV-15b | …`trimClip {id, side, t}` ≡ select + playhead + trim to playhead | → `edit.trimClipTo` | same | passing |
| INV-15c | …`moveClip {id, start \| dt, track?}` ≡ the move drag without snapping. A lane the UI would ignore (not shown, or of the other kind) is refused by the op; the rest of the move must still match | → `edit.beginDrag` / `dragTo` | same | passing |
| INV-15d | …`closeGap {t}` ≡ playhead + close gap | → `edit.closeGapAt` (targeted, unlocked lanes in display order) | same | passing |
| INV-15e | …`setTiming {id, start?, duration?}` ≡ the inspector's start / length fields | → `edit.setClipTiming` | same | passing |
| INV-15f | …`removeClip {id, linked:true}` ≡ select + Delete. Every refusal leaves the UI's document unchanged too, and no op adds a validation error | → `edit.removeClips` | same | passing |

## Bugs the properties found (BUG-19 and up)

Each has a deterministic regression in `test/core/regressions.test.js`, and
all are fixed: BUG-21, BUG-24 and BUG-25 in Phase 3 step 3b; BUG-19, BUG-20,
BUG-23 and BUG-26 in step 3c (with BUG-12 and BUG-14c from
`test/edit-ops.test.js`); BUG-22 in step 3d, with BUG-13, BUG-14a/b/d,
BUG-15 to BUG-18 from `test/edit-ops.test.js`. BUG-27 was found by review in
3d, not by a property (no property drives the inspector's Source picker).

| id | bug | invariant | decision |
|---|---|---|---|
| BUG-19 (fixed) | `splitClipAt` advances `in` on image/text/adjust pieces (right piece `in = cut × speed`) | INV-07f | D5 |
| BUG-20 (fixed) | trim-l and trim to IN/OUT reset an svg clip's `in` to 0, so its animation jumps | INV-07d | D5 |
| BUG-21 (fixed) | An edge drag re-bases only the dragged clip's keyframes. Linked partners get the new start and duration but keep their old clip-local key times, so a stem's volume fade slides, and on a shortening drag its keys pile up past the end | INV-09c, INV-06b | D2 |
| BUG-22 (fixed) | Trims (trim to playhead, trim to IN/OUT, edge drags) leave a transition longer than the shortened clip | INV-08c | D6 |
| BUG-23 (fixed) | trim-r caps the duration at `(media − in) / static speed`. A speed ramp then runs past the end of its media | INV-10c | D6 |
| BUG-24 (fixed) | trim-l clamped at the media start computes `in = orig.in + d × speed` in floats: `0.425 + (0.535 − 0.96) = −5.6e-17`. That is a SCHEMA_MINIMUM **error** on disk | INV-01b | D6 |
| BUG-25 (fixed) | The drag gesture records an undo step whenever the pointer moved, even when the clamped result is unchanged (a move left at 0 s, a trim at its limit) | INV-11e | D6 |
| BUG-26 (fixed) | `mediaTimeAt` interpolates the clip's last, partial 1/120 s grid step as if it were a full step. Media time near the end of a ramped clip runs slow, by up to `speed × 1/480` s (≈ 8 ms at 4×). The validator's MEDIA_OVERRUN check uses it and underestimates too | INV-05c | D6 |
| BUG-27 (fixed) | Replacing a clip's media with a shorter file caps `in` / `duration` at static speed: a speed ramp keeps a source window past the new file's end | — (review) | D6 |
