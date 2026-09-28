# Changelog

All notable changes to FableCut are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Timeline patch ops: the editor's own edits, one op each.** New
  `fablecut_patch_project` / `POST /api/patch` ops `splitClip {id | ids | all,
  t}`, `trimClip {id, side, t}`, `moveClip {id, start | dt, track?}`,
  `closeGap {t}` and `setTiming {id, start?, duration?}`, plus
  `removeClip {id, linked:true}` (without `linked`, `removeClip` still deletes
  only that clip). Each calls `core/edit.js` exactly as the UI's split, trim to
  playhead, move drag, close gap, inspector timing and Delete do. So one op
  handles the whole link group, speed ramps (`in` from the source time under
  the edge), anchor keyframes and transitions. Agents no longer compute cuts
  by hand. A refusal throws the reason, so the patch stays all-or-nothing. The
  new property INV-15 (`test/props/inv-15-patch-equivalence.test.js`) checks
  each op against the UI path on generated projects.
  - The ops read the document the way the editor loads it: a missing `in` is
    0, and links are completed (a legacy `linkedId` pair, or an ungrouped stem
    matching a video's media and timing, becomes a `linkGroup`).
  - `moveClip {track}` takes only a lane the editor shows (declared, default, or
    already used by a clip) of the clip's kind. The error spells out the
    `setProject tracks` op that declares a new lane.
  - Patch notes say what each op did (`split at 4s: c_v→+c_x, c_l→+c_y`), and
    notes are now joined with `; `. The compact view and the `Changes:` diff
    show a clip's link group (`link:lg_…`).
  - Fixed: the patch validation gate checked the in-memory document, where a
    cleared field is `undefined`. It now checks the JSON that is saved, so a
    cleared transition is no longer a false `SCHEMA_TYPE` error.
- **One patch interpreter for MCP and REST** (`core/patch.js`). Its `OPS`
  table (one row per op: `addClip`, `updateClip`, `removeClip`, `addMedia`,
  `removeMedia`, `setProject`) generates the `fablecut_patch_project` tool
  description and the unknown-op error, and a contract test checks CLAUDE.md
  names every op. The six ops behave exactly as before.
  - A patch result now ends with **`Changes:`**, a compact diff of what it did
    (`+<clip line>`, `-<id>`, `~<id> field: old→new`, `project <field>: old→new`;
    `core/summary.js`), so an agent needn't re-read the project to check it.
  - **`dryRun: true`** on `fablecut_patch_project` returns the same result —
    validation and diff included — prefixed `DRY RUN — nothing saved`.
  - New **`POST /api/patch`** (`{ops, dryRun?}`): the same ops and validation
    gate over REST, behind the same Host/Origin guard. 200 with
    `{ok, revision, notes, diff, warnings}`, 422 with `{error, issues}` when
    the result would add a validation error, 400 for bad JSON or a failing op;
    nothing is written unless it succeeds, and the UI live-reloads when it does.
  - The compact view (`fablecut_get_project {compact:true}`) moved to
    `core/summary.js` unchanged, byte for byte (pinned by a snapshot).
- **Property tests** for the timeline core (`test/props/`, fast-check as a
  devDependency; the runtime stays zero-dependency). Generators of valid
  projects (every clip kind, 1/2/6-stem link groups, speed ramps, keyframes,
  transitions, custom and disabled lanes, IN/OUT) and late-bound op sequences
  (split, trims, edge drags, close gap, delete, lane toggles, undo/redo) check
  the invariants listed in `docs/specs/invariants.md`: no new validation
  errors, link groups in sync, splits and trims invisible in playback, the media
  bound, undo/redo of the whole document (model-based), lossless save/load, and
  determinism. `npm test` runs them at 100 runs, `npm run test:props` at 1000
  (a CI step). They found eight new bugs (BUG-19 to BUG-26), each pinned by a
  regression test in `test/core/regressions.test.js`; while a bug was open its
  property was a `todo`, and every property passes now.
  `docs/specs/0001-timeline-edit-semantics.md` records the decisions the fixes
  implement.
- **Project validation.** One validator (`core/validate.js`) checks
  `project.json` against its schema plus semantic rules JSON Schema can't
  express — unique ids, media and lanes that resolve, clip kind vs lane, source
  windows that fit the media (speed-ramp aware), link groups in sync,
  keyframes/transitions inside their clip, unknown props with "did you mean"
  hints. Every issue carries a severity (error / warning) and a stable code;
  CLAUDE.md's new "Validation" section lists them all.
  - MCP `fablecut_patch_project` / `fablecut_set_project` refuse a write that
    would **add** an error and name each one; errors already on disk never block
    an unrelated edit, and new warnings are listed in the result.
  - New read-only MCP tool **`fablecut_validate`** checks `project.json`, or a
    candidate document without saving it. `fablecut_status` shows the counts.
  - `PUT /api/project` returns `issues` and still always saves;
    `?strict=1` answers 422 and writes nothing when there are errors.
  - The editor lists problems in a collapsed browser-console group on load and
    toasts when there are errors. Loading is never blocked.
- **`core/schema.js`** — the `project.json` schema and timeline constants
  (`DEFAULT_PROPS`, `ANIMATABLE`, `TRANSITIONS`, `EASE`, `MIN_DUR`, speed range
  0.1–8, …) in one dual-mode script shared by the UI (`FableCore.schema`), the
  server and the MCP server. The compact MCP view, the `setProject` allowlist
  and its tool description are derived from it.
- **`schema/project.schema.json`** — the published JSON Schema contract,
  generated by `npm run schema` (CI fails when it is stale) and cross-checked
  against ajv in a contract test.
- Characterization safety net for timeline editing: `test/edit-ops.test.js`
  drives the real app.js split / trim / close-gap / drag / undo code through
  `test/drivers/edit.js` against eight fixture projects; known bugs were pinned
  as `todo` tests until they were fixed.
- Program Monitor transport: playhead as `current / sequence duration` on the
  left; when IN/OUT are set, a right-side stack of IN, marked duration, OUT.
- Ctrl/Cmd-click an inspector **slider** to reset that property to its default
  and clear its keyframes (same as Ctrl/Cmd-clicking the label — scale → 1,
  opacity → 1, brightness → 100, …).
- **Import from URL** — `POST /api/import-url` downloads an HTTPS video, audio
  or image into `./media/` and returns a same-origin `/media/…` src. The
  editor **+ URL** button and `fablecut_import_media` (now accepts `https://`
  as well as a local path) use it. HTTPS-only with SSRF guards (no localhost /
  private / link-local / CGNAT, including after DNS and redirects). Remote SVG
  is refused so a scripted file cannot run on the editor origin. A raw HTTPS
  `media.src` is still unsupported — canvas CORS would break export.
- **WebCodecs export** — a second export engine beside Fast. The browser
  HW-encodes H.264 with `VideoEncoder` and streams the Annex-B elementary
  stream to the server, which stream-copies it into MP4 (`-c:v copy`) and muxes
  the offline audio mix in one pass. Bitrate and rate control (VBR / CBR) are
  chosen in the Export dialog; support is probed before every run and the
  engine is hidden when unavailable or when an export frame is set (use Fast).
  `-r` on the input forces CFR PTS so the file matches `project.fps` exactly,
  and BT.709 tags are written into both the bitstream and the container.
  Abandoned sessions are reclaimed by an idle sweeper, and SIGINT / SIGTERM
  clean up in-flight ffmpeg processes and temp dirs.
- A real test suite (`npm test`, zero dependencies, `node:test`): MCP protocol
  negotiation and framing, MCP tool semantics including the conflict rules, the
  REST API with its Host/Origin and path-traversal guards, and the shipped SVG
  library. CI runs it on Node 22 and 24 for every pull request.
- Dynamic video + audio tracks (default 3+4; **+V** / **+A**, right-click
  **Remove track**, header **S** solo; up to 16 per kind). The live lane list is
  stored on `project.json` as `tracks`.
- Per-clip **stereo pan** (`props.pan`, −1…+1) on video/audio clips — inspector
  slider + keyframes; preview, audio-hold, and both export engines honor it.
  Linked stems default to L `−1` / R `+1` / center for other channels. Compact
  MCP keeps `pan` on linked stems.
- Stereo **master meter** (L/R) on the monitor — post-pan program sum in the
  same RMS / LUFS / Peak modes as the per-track bars; A-tracks + video spill
  route through one summed path when the meter worklet is active. Per-track
  bars collapse via **◂** / **▸** beside the master strip (master L/R stay visible).

### Changed
- **Keyframes may lie outside their clip, one per side.** A key before 0 or
  past the clip's end is an *anchor*: it is not shown, but it shapes the curve
  at that edge (an agent can use one to start a clip mid-fade). Splits and
  trims now keep such anchors (see Fixed). The schema no longer requires
  keyframe `t ≥ 0`; the validator accepts one anchor per side per channel and
  reports `KEYFRAME_OUT_OF_RANGE` only for the keys beyond it (it used to flag
  every key past the end, and `t < 0` as `SCHEMA_MINIMUM`). Existing projects
  load and play unchanged. Timeline diamonds, keyframe navigation, the ◆
  button, its count and the keyframe graph ignore anchors.
- Loading `project.json` completes AV links instead of rebuilding them: link
  ids on disk are kept, only clips without a group are linked (by matching
  media and timing), and a legacy pairwise `linkedId` becomes a group. A
  project saved by an older build therefore keeps its `lg_…` ids from then
  on. `core/project.js` `normalizeProject` and `core/links.js` `relinkClips`
  no longer take an id factory.
- The timeline core is extracted from `app.js` into dual-mode `core/` modules
  (browser `FableCore.<module>`, Node `require`): `core/keyframes.js`
  (keyframe curves, speed-ramp time remapping), `core/compose.js` (props at
  time t, filter presets, transitions), `core/links.js` (AV link groups),
  `core/edit.js` (split / trim / close gap / delete / drag math),
  `core/history.js` (undo/redo stacks) and `core/project.js` (load/save
  normalization). `app.js` keeps its function names as thin wrappers that add
  the UI side effects. No behavior change: the timeline characterization tests
  and their known-bug todos are unchanged. `npm run coverage` gates `core/`
  coverage in CI.
- **Node 22+** is now required (18 and 20 are end-of-life): `engines`, the
  MCPB manifest and the CI matrix (22 / 24). CI installs dev-only tooling with
  `npm ci`; the runtime stays zero-dependency.
- MCP `fablecut_patch_project`: `setProject` may now also change `tracks`,
  `folders`, `inPoint` and `outPoint`; `updateClip` refuses to change a clip's
  `id`; `addClip` (and `fablecut_set_project`) default a missing `in` to 0 and
  say so. The compact `fablecut_get_project` view no longer lists default
  text-box props (`direction`, `boxW`, `vAlign`, …).
- `fablecut_set_project` now reports bad clips by validation code and field
  (e.g. `SCHEMA_REQUIRED clips[0].id`, `MEDIA_NOT_FOUND`) and also refuses
  duplicate clip/media ids. The `PUT /api/project` 200 body gains `issues`.
- CLAUDE.md: speed is 0.1–8× (the inspector slider covers 0.25–4), volume is
  0–4; `audioChannel`, `styleName`, the optional `in` and link-group timing are
  documented; the crossfade example now carries the `duration` a transition
  needs.
- Fast export no longer waits for each JPEG HTTP POST before drawing the next
  frame. The compositor snapshots via `transferToImageBitmap` and keeps going;
  JPEG encode runs in workers and uploads overlap in batches. Piping uncompressed
  RGBA over HTTP was slower (1080p ≈ 8 MiB/frame); the UI is back on JPEG
  image2pipe. `pixelFormat: "rgba"` remains on `/api/export/begin` for callers
  that want raw frames.
- `POST /api/export/begin` now **requires** `fps` (pass `project.fps`) instead
  of defaulting to 30, and takes `mode: "jpeg" | "annexb"`. Callers that relied
  on the old default must send the value; a missing or non-numeric `fps` is a
  400, not a silently wrong frame rate.
- `project.json` gains two forward-compatible keys (`tracks`, `panSchema`).
  Older builds ignore them. **Opening** a project saved before pan writes the
  file back once: it stamps `panSchema: 1`, hard-pans linked stems that had no
  `pan`, and every save from then on also emits `tracks`. Hand-edited documents
  that omit `panSchema: 1` will be migrated again on the next open.

### Fixed
- **Splits and trims no longer change animations.** Cutting through a
  keyframed fade, move or speed ramp dropped the keys outside each piece, so
  the curve jumped to the nearest remaining key: a fade restarted, and a ramp
  played at another speed and slipped out of sync with its source. Each piece
  now keeps the nearest key just outside it as an anchor, so every ease and
  every speed ramp plays exactly as before the cut — for splits, Trim to
  playhead, Trim to IN/OUT, edge drags and linked stems. Dragging a trimmed
  clip's left edge back out plays the original ramp again.
- **Trim to playhead works like a cut.** Keyframes now move with the trim
  (they kept their clip-relative times and slid along the timeline); the
  trimmed edge loses its transition, as with a split or Trim to IN/OUT, on
  linked stems too; and a trim with the playhead outside the clip no longer
  adds an empty undo step.
- **Transitions fit after an edit.** A split, a trim or an edge drag no longer
  leaves a transition (or the in and out transitions together) longer than
  what is left of the clip: they are shortened, the edited edge's first. Edge
  drags keep the dragged edge's transition; drag back out and it grows back.
- Split pieces no longer share list props: changing one piece's font-cut
  fonts changed the other's too.
- **Replacing a speed-ramped clip's media with a shorter file** now cuts the
  clip (and its linked stems) where the ramp reaches the end of the new file.
  It used the clip's static speed, so the ramp could run past the end.
- **+ Title / + Adjust** after removing lane V2 / V3 put the new clip on the
  missing lane, where it stayed invisible until a reload; it now goes on the
  highest video lane.
- **Adding media from the bin or the library** after removing its usual lane
  (V1 for footage, V3 for svg, A1 for audio) put the clip on the missing lane,
  where it stayed invisible until a reload. It now goes on the nearest lane of
  the right kind.
- A keyframe ease named like a JavaScript built-in (`"__proto__"`,
  `"constructor"`) in `project.json` crashed the render loop; it now falls
  back to linear, like any unknown ease.
- **Undo after removing media from the bin** brings the media entry back with
  its clips. Undo used to restore only the clips, which then pointed at media
  that no longer existed. Undo now restores clips, media and bin folders, and
  imports and folder changes are undo steps of their own. Lane toggles,
  markers and IN/OUT are never reverted by undo, and a lane removed in the
  meantime comes back for the clips undo restores.
- **A linked picture and its audio stems no longer drift apart:**
  - Editing Start, Length or Speed in the inspector updates the whole linked
    group. It used to change only the selected clip.
  - Edge drags and trims keep one speed ramp on the picture and every stem,
    and each stem's own keyframes (a volume fade, say) keep their place on the
    timeline instead of sliding with the drag.
  - The extra stems created for a 3+ channel source play at the picture's
    speed and ramp.
  - Close gap and Trim to IN/OUT move and trim a linked stem even when its
    lane is disabled.
- **Link groups survive reloads.** `linkGroup` ids in `project.json` are kept
  (they were regenerated on every load). A stem whose timing drifted stays
  linked and is reported as `LINK_DESYNC` instead of being silently unlinked,
  and a newly linked group gets the stable id `lg_<video clip id>`.
- **Splits and trims on speed-ramped clips keep the picture in sync.** A split,
  a left-edge drag, Trim to playhead and Trim to IN/OUT now start the new piece
  at the source time actually under the cut. They used the clip's static
  speed, so on a ramp the picture jumped.
- **SVG animations stay continuous across splits and trims.** An svg clip's
  `in` is its animation time: splits and trims carry it on (left-edge drags and
  Trim to IN/OUT used to reset it to 0, restarting the animation). Image, text
  and adjustment clips always keep `in: 0` — splits and Trim to playhead used
  to write meaningless values there, and projects that have them are cleaned
  up on load.
- **Ramp-aware trim limits.** Dragging a ramped clip's right edge stops where
  the ramp reaches the end of the media (it used to run past it), and dragging
  its left edge back stops where the source starts, at the speed the ramp
  begins with.
- **More exact ramp timing.** The media time near the end of a speed-ramped
  clip was off by up to a few milliseconds (the last sliver of the clip was
  timed as a full 1/120 s step); it is now exact, in preview, export and the
  validator's `MEDIA_OVERRUN` check.
- Dragging a clip's left edge to the start of its media could save `in` as a
  tiny negative number (−5.6e-17), which is a validation error. A clamped edge
  now lands exactly on its limit.
- A drag that the limits kept in place (a clip at 0 s pushed further left, an
  edge already at the media end) no longer adds an undo step.
- When an agent's write reset the undo history and `project.json` also had
  validation errors, the problem toast replaced the "undo history was reset"
  toast. They are now one toast: "Project was updated externally — undo
  history was reset · project.json has N problems — see the browser console".
- Four timeline data-loss bugs: dragging a clip's right edge could leave a
  negative duration when its source had been replaced by a shorter file; clips
  saved without `in` (common for agent-written text/adjust clips) turned into
  NaN on split/trim; undo after an agent's external write replayed a stale
  snapshot and saved that revert over the agent's edit (the undo history is now
  reset, with a toast); and saving dropped a title's `styleName`.
- The MCPB `manifest.json` tool list was missing `fablecut_encode_profiles`
  (a test now keeps it in step with the server).
- `fablecut_status` with a non-default `FABLECUT_PORT` started the editor on
  7777 and then reported it as failed; the MCP server now passes its port on.
- Fast (and WebCodecs) export no longer repeats video frames. The compositor was
  snapshotting before a new decoded picture was presented: `currentTime` and
  `fastSeek` ran ahead of the displayed frame, play-ahead settled a half-frame
  early, and JPEG/upload backpressure left the element playing so the next tick
  had to seek back to a keyframe. Export now waits on
  `requestVideoFrameCallback` mediaTime, seeks with `currentTime`, and pauses
  during stalls. ffmpeg’s JPEG pipe was already 1:1 — unique frames stay unique.
- Export play-ahead is less twitchy mid-shot: JPEG/encoder queue depth no longer
  forces a full pause+seek on every blip (only when the queue is deep or the
  compositor tick fell behind), and play-ahead no longer hard-seeks just because
  `currentTime` ran ahead of the presented picture.
- `waitForPresentedFrame` no longer treats a presentation timeout (or an rvfc
  callback without `mediaTime`) as success — `hardSeekVideo` retries up to three
  times instead of recording `currentTime` as the presented frame.
- Fast / WebCodecs export no longer throws “tainted canvases may not be exported”
  for animated SVG overlays (rasterized via a same-origin blob instead of a
  `data:` URL) or for other-origin footage that sends CORS (reload with
  `crossOrigin=anonymous` for the encode). A clip whose server omits
  `Access-Control-Allow-Origin` still cannot be JPEG-encoded — import it into
  `./media` instead.
- MCP `initialize` no longer echoes an unsupported `protocolVersion`. Missing or unknown versions now negotiate to `2025-11-25` instead of claiming a revision the server does not speak (#58).
- `CLAUDE.md` pointed agents at `fablecut_docs {section:"props"}`, which matches no `## ` heading and returns nothing useful; it now names a real section.
- Audio graph teardown on project reload — clip chains
  (`MediaElementSource → splitter → gain → panner → bus`) are now fully
  disconnected via `releaseClipEl` instead of only clearing the maps (which
  left nodes wired to live track buses). Panner attach degrades gracefully if
  `StereoPannerNode` is unavailable; inspector volume/pan changes refresh
  audio-hold voices.
- **Export follows IN/OUT** — Fast, WebCodecs, and Realtime honor a Range
  choice in the Export dialog (Entire timeline / IN–OUT; IN–OUT is the default
  when markers exist). Effective IN/OUT export bounds are clamped to `projDur`
  so an IN past the last clip cannot become a one-frame black file.

## [1.7.0] - 2026-08-25

The community release — 20 merged pull requests. Audio gets real tracks and real
metering, the monitor gets zoom, the Project tab gets folders, and FableCut
installs as a Claude Code plugin.

### Added
- **Installable as a Claude Code plugin.** `.claude-plugin/plugin.json` plus a
  `.claude-plugin/marketplace.json`, so the repo is its own marketplace:
  `/plugin marketplace add ronak-create/FableCut` then
  `/plugin install fablecut@fablecut`. Ships the MCP server via `.mcp.json` and
  two skills (`edit-video`, `remake-reel`).
- `FABLECUT_DATA_DIR` — put `project.json`, `media/`, `exports/`, `analysis/`
  and `library/` somewhere other than the install directory. Unset (the default)
  everything stays where it always has, so `node server.js` is unchanged. The
  plugin points it at the per-plugin data directory, which is what keeps a
  user's timeline and footage from being wiped when a plugin update replaces the
  install directory. On first use with a split data dir the shipped `library/`
  assets are copied across; files you add or edit there are never overwritten.
- Project FPS select in the Program Monitor header (next to aspect presets) —
  pick 24 / 25 / 30 / 50 / 60 fps; writes `project.fps` and persists like canvas
  size. Non-preset rates appear as Custom.
- Preview playback speed — a monitor toolbar toggle plus **J**/**K**/**L** shortcuts cycle the preview player through 1×, 1.5×, 2×, and 4× (L faster, J slower, K play/pause and reset to 1×). It rides on top of each clip's own speed and is forced back to 1× during export, so renders always come out at real time.
  (thanks @ur5fot, #18)
- **Separate audio and video tracks.** Imported video now shows its audio as
  linked companion clips on the A-tracks (sharing a `linkGroup`, relinked on
  project reload), with switchable RMS / LUFS / peak metering and dBFS labels
  (thanks @PlkMarudny, #17)
- **Track enable/disable** buttons, with the disabled state persisted to
  `project.json` as `disabledTracks`, plus an export-time warning when a disabled
  track still holds clips (thanks @PlkMarudny, #20, #22)
- **Keyframe graphs** — interpolated curves drawn on the clip, keyframe markers,
  and a keyframe count per time point (thanks @PlkMarudny, #34)
- **Text layout engine** — word wrapping inside a text box with horizontal and
  vertical alignment (`boxW`/`boxH`/`vAlign`) (thanks @PlkMarudny, #37)
- **Project folders** — a folder tree in the Project tab with drag-and-drop and
  in-place rename, stored as `folders[]` (thanks @PlkMarudny, #38)
- **Monitor zoom** — mousewheel over the Program Monitor zooms the composition
  (clamped to 2× real pixels), with scrollbars when zoomed in and a restyled
  zoom-reset button (thanks @PlkMarudny, #39)
- **Linked selection** between the Project tab and the timeline
  (thanks @PlkMarudny, #40)
- **Audio hold** — a single frame of audio loops while the playhead is held, so
  scrubbing is audible (thanks @PlkMarudny, #42)
- **Clip replacement and rename** — swap a clip's source media in place
  (thanks @PlkMarudny, #45)
- **Animated SVG overlays** — `countdown-ring`, `rec-indicator` and `swipe-up`
  join the shipped `library/svg/` set (thanks @madebysaira, #55)
- **In/out points** on the timeline — `inPoint`/`outPoint` mark the working
  range (thanks @PlkMarudny, #21)
- **Transition overlay** — transitions are now drawn on the clip itself
  (thanks @PlkMarudny, #23)
- **RTL support for titles** — `direction: auto | ltr | rtl`, with every
  `textAnim` mode staggering in reading order (thanks @PlkMarudny, #25)
- `sunset` and `midnight` filter presets (thanks @Azizbek, #29)
- `luxury` title style — Cinzel, cream→gold gradient, wide letter-spacing
  (thanks @Azizbek, #30)
- Ctrl+click an inspector label to reset that property to its default
  (thanks @PlkMarudny, #36)
- Two-column help dialog (thanks @PlkMarudny, #33)
- Word-timestamp auto-caption example (thanks @madebysaira, #53)
- Multi-agent MCP setup documentation (thanks @madebysaira, #54)
- MCP registry metadata — `server.json` plus an MCPB manifest, so FableCut is
  installable as a one-click `.mcpb` bundle.

### Fixed
- **Exports are tagged BT.709**, so they no longer render noticeably darker than
  the preview (thanks @dntmcq, #56)
- **XSS in the Project tab** — user-controlled media and folder names were
  rendered through `innerHTML` unescaped.
- Zoom to timeline now scales the timeline to 95% of the viewport instead of
  overflowing it (thanks @PlkMarudny, #47)
- `syncMedia` no longer desyncs when playout is paused (thanks @PlkMarudny, #32)
- Gap closing on the timeline (thanks @PlkMarudny, #31)
- Vertical drag of clips between tracks.
- Font weight is preserved in `drawText()` on the `font-cut` path.
- Audio meter labels are placed correctly at 'S' track density.

### Changed
- VU meter and timeline ruler now render on canvases rather than DOM nodes — a
  large drop in layout cost during playback (thanks @PlkMarudny, #44)
- Monochrome icons throughout (thanks @PlkMarudny, #19)
- Play button restyled to be more visible (thanks @PlkMarudny, #35)
- Overlapping helpers deduplicated into shared general-purpose functions
  (thanks @PlkMarudny, #43)
- Landing page: liquid-glass theme, live GitHub star count, and a minimal hero
  over an ASCII field.
- README: ASCII block wordmark, zh-CN / ja / es / pt-BR translations, DeepWiki
  link, community Discord link, and a Trendshift badge.

## [1.6.0] - 2026-07-14

### Added
- Resizable monitor/timeline split — drag the divider, double-click to reset (thanks @PlkMarudny, #14)
- S/M/L timeline track-density presets with layout persistence (thanks @PlkMarudny, #15)
- Zoom to selection (Z) now frames all selected clips (thanks @PlkMarudny, #13)
- Title-style picker: each entry renders in its own typeface, and hovering an entry live-previews the style on the monitor (mouse away reverts, click commits)
- Program-monitor hover cursors: the rotate knob shows a rotate cursor, corner handles show direction-aware resize arrows (correct even on rotated clips), and the clip body shows a move cursor

### Fixed
- Changing a title's style no longer resets its position/scale/rotation — style switches only restyle the look; placement applies to newly created titles only
- Selection handles now clamp to the frame edge and stay visible/grabbable when a clip's box extends past the canvas
- Header logo icon/text vertical alignment after the topbar layout change

## [1.5.0] - 2026-07-11

### Added
- **Direct manipulation on the program monitor** — click a clip or title on the
  preview to select it, then drag the body to move, the corner handles to resize,
  and the top handle to rotate (hold Shift to snap rotation to 15°). Gestures map
  straight onto the clip's `x`/`y`/`scale`/`rotation` props. Selection handles are
  drawn only on screen and never appear in an export.

## [1.4.0] - 2026-07-11

### Added
- **Title styles** — text clips no longer all look the same. Adding a title now
  rotates through curated one-tap looks (Impact, Elegant, Kinetic cut, Neon,
  Handwritten, Serif drop, Subtitle, Bold rise), each bundling a **different
  font**, placement and animation. Pick or shuffle them from the inspector, or
  reproduce any look from an agent by writing the same props.
- **Four cinematic caption animations**: `clip-reveal` (wipe-mask sweep),
  `zoom-in` (scale + opacity settle), `font-cut` (rhythmically swaps the typeface
  from a `fontCutSet`, then settles), and `rise-mask` (lower-third reveal). All
  render on the existing frame-accurate path, so they export unchanged.
- Expanded the built-in Google-font list with the display faces the styles use
  (Archivo Black, Abril Fatface, Barlow, Teko, Roboto). Any font name still
  auto-downloads on demand.

## [1.3.1] - 2026-07-11

### Security

Hardening of the local server against network and drive-by attacks, prompted by
the report in [#1](https://github.com/ronak-create/FableCut/issues/1) — thanks
@suthakamal2.

- The server now binds **127.0.0.1 only** by default (previously all
  interfaces, reachable from the whole LAN). Deliberate LAN use is an explicit
  opt-in: `HOST=0.0.0.0 node server.js` plus
  `FABLECUT_ALLOWED_HOSTS=192.168.1.20,mybox.local`.
- Every request is checked against a **Host-header allowlist**
  (localhost/127.0.0.1/[::1] + the opt-ins above), which defeats DNS-rebinding
  attacks, and — when the browser sends one — an **Origin allowlist**, which
  defeats blind cross-origin writes from malicious web pages (e.g. a drive-by
  `POST /api/upload` carried a no-preflight raw body).
- The static file server no longer serves dot-files or dot-directories
  (`.git/`, `.gitignore`, …), and both path-traversal guards now use
  separator-anchored directory prefixes.

### Added
- The default asset library now ships with the repo where licensing allows:
  20 Google Fonts in `library/fonts/` (OFL, listed in `LICENSES.md`) and the
  self-authored overlay SVGs in `library/elements/`. `library/sfx/` stays
  local-only (SFX-site licenses generally prohibit redistribution) — its new
  README points to good free sources.

## [1.3.0] - 2026-07-09

### Added
- **Reference-remake pipeline** — give FableCut a reference video and get back an
  *edit blueprint* to rebuild the same idea with different footage over the same
  music. New zero-dependency analyzer (`analyze.js`, needs ffmpeg): shot-boundary
  detection with adaptive threshold, music beat + BPM detection (onset envelope +
  autocorrelation, span-refined), a 0.5 s loudness curve, per-shot audio energy,
  drop detection, and extraction of the reference's music track into `media/`.
  Exposed as MCP tool `fablecut_analyze_reference`, REST `POST /api/analyze`
  (cached under `./analysis/`, `GET /api/analyze?src=…`), and CLI
  `node analyze.js <video>`. New CLAUDE.md section "Remake a reference video"
  documents the blueprint schema and the rebuild recipe.
- **Token-efficient agent surface**:
  - `fablecut_patch_project` — targeted ops (`addClip`, `updateClip`,
    `removeClip`, `addMedia`, `removeMedia`, `setProject`) applied to the latest
    on-disk document in one atomic, merge-safe write — no more round-tripping the
    whole project JSON for a one-prop change.
  - `fablecut_get_project {compact:true}` — one-line-per-clip timeline summary
    (non-default props only, keyframe/transition digests), ~10× smaller.
  - `fablecut_docs {section:"…"}` — fetch only matching `## ` sections of the manual.
  - `fablecut_status` now caps long media listings.
  - New CLAUDE.md section "Token-efficient editing" with agent guidance.

### Changed
- Full `fablecut_get_project` now returns minified JSON (was pretty-printed).
- MCP server bumped to version **1.3.0**.

## [1.2.0] - 2026-07-09

### Added
- **Timeline multi-select** — rubber-band marquee (drag on empty track area)
  selects every clip the box touches. Ctrl/Cmd/Shift+click adds or removes
  individual clips. Ctrl+A selects all; Esc deselects.
- **Group move** — dragging any selected clip moves the whole selection by the
  same time delta (clamped at 0). Vertical track moves remain per-clip.
- **Batch Delete / Split** — Delete removes all selected clips; S splits every
  selected clip that sits under the playhead.
- **Multi-select inspector** — shows an "N clips selected" banner; edits the
  primary (white-outlined) clip; secondary clips show a lighter outline.
- **Conflict-safe `PUT /api/project`** — rejects stale writes with **409** when
  the request body's `revision` ≤ the on-disk revision; response body is
  `{error, revision}` with the current value. Append `?force=1` to overwrite
  deliberately. Writes are now atomic (tmp file + rename).
- **Conflict-safe MCP `fablecut_set_project`** — tracks the revision from the
  last `fablecut_get_project` and errors with "CONFLICT — not saved" if
  `project.json` changed on disk since that read. Recovery: re-read, re-apply,
  save. New optional `force: true` argument bypasses the check.

### Changed
- Editor UI syncs by exact revision comparison (no timing heuristics); detects
  external changes even during the previous 1.5 s blind window; defers reloads
  during drag/export and applies them immediately after; preserves clip
  selection across external reloads (pruned to clips that still exist); shows a
  toast ("Project was updated externally…") when an external write supersedes an
  unsaved local tweak.
- Selection state survives undo/redo.
- `CLAUDE.md` and `README.md` updated to document all of the above.
- MCP server bumped to version **1.2.0**.

## [1.1.0] - 2026-07-07

### Added
- **Motion FX** (all animatable): camera `shake` / `shakeSpeed`, `rgbSplit`
  chromatic aberration, and boiling film `grain`.
- **Speed ramps** — `speed` is now keyframable. The engine time-remaps media time
  as `in + ∫ speed dt` in both preview and the offline export audio mix (the
  fast-into-slow-motion reel move).
- **Adjustment layers** — a new `kind:"adjust"` clip that re-renders everything
  drawn below it through its own grade/filter/shake/grain/vignette stack,
  Premiere-style. Added the *+ Adjust* button, inspector, and timeline styling.
- **Neon caption glow** (`glow` / `glowColor`).
- Four new kinetic text animations: `letter-pop`, `wave`, `bounce`, `shake`.
- Two new transitions: `glitch` (RGB split + jitter) and `pop` (overshoot scale).
- Project-level `background` color, persisted and drawn behind all clips.
- 16 new animated library SVGs (subscribe pill/bell, rating stars, arrows,
  badges, progress/loading bars, speech bubble, hearts, equalizer, pulses…).

### Changed
- `CLAUDE.md` and `README.md` expanded to document all of the above.
- MCP server validation now exempts `adjust` clips from the `mediaId` check.

## [1.0.0] - 2026-07-06

### Added
- Initial public release: a zero-dependency, Premiere-style browser video editor
  whose entire timeline is a single `project.json` document.
- **Editing** — 4 video + 3 audio tracks, drag/trim/split/snap, undo/redo, beat &
  cue markers, real decoded audio waveforms, aspect presets + safe-area guides.
- **Look** — 12 filter presets, full grade controls (temperature/tint/vignette),
  blend modes, fit/crop/corner-radius/flip, chroma key, in-browser AI background
  removal (MediaPipe).
- **Motion** — keyframe animation with easing, per-clip speed, 15 transitions.
- **Text** — kinetic captions, gradient/outline/pill styling, any Google Font by
  name, drop-in custom fonts.
- **Animated SVG clips** — a first-class `svg` kind rendered frame-accurately from
  CSS `@keyframes`.
- **Export** — fast browser-rendered frames + offline audio mix encoded by ffmpeg
  (CRF-18 MP4), with a realtime MediaRecorder fallback.
- Three control surfaces for AI agents: **MCP server**, direct `project.json`
  editing, and a **REST API** with live-reload over server-sent events.

[1.7.0]: https://github.com/ronak-create/FableCut/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/ronak-create/FableCut/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/ronak-create/FableCut/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/ronak-create/FableCut/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/ronak-create/FableCut/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/ronak-create/FableCut/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ronak-create/FableCut/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ronak-create/FableCut/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ronak-create/FableCut/releases/tag/v1.0.0
