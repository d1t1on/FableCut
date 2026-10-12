# FableCut — browser video editor, drivable by Claude Code

A production-style non-linear video editor (Premiere-style) that runs in the
browser. An AI agent edits videos by **editing `project.json`** (or calling the
REST API / MCP tools) — the open browser UI live-reloads within ~150 ms via SSE.
No build step, no npm dependencies.

**This file is the master manual.** Any model pointed at this document (or at
the `fablecut_docs` MCP tool, which returns it) has everything needed to fully
drive the editor.

## MCP connection (preferred — works from any session, any directory)

Register the MCP server (`mcp-server.js`) once at user scope as `fablecut`:
`claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"`.
Every Claude Code session then has these tools:

- `fablecut_status` — auto-starts the editor server, returns URL + project summary. Call first.
- `fablecut_docs` — returns this document (`section: "…"` returns only matching `## ` sections).
- `fablecut_get_project` / `fablecut_set_project` — read / replace the timeline JSON.
  `fablecut_get_project {compact:true}` returns a one-line-per-clip summary instead.
- `fablecut_patch_project` — apply targeted ops without round-tripping the
  document. **Prefer this for edits.** `{ops:[…], dryRun?, baseRevision?}`; ops apply in order:
  - `{op:"addClip", clip:{kind, track, start, duration, mediaId, …}}` — add a clip; id auto-generated if omitted, a missing `in` defaults to 0
  - `{op:"updateClip", id, set:{…}}` — merge into a clip: top-level keys are replaced (keyframes/transitionIn/transitionOut wholesale), `props` merges key by key, `null` deletes a key, `id` is immutable
  - `{op:"removeClip", id, linked?}` — delete that one clip (its link partners stay); `linked:true` deletes its whole link group, like the editor's Delete
  - `{op:"addMedia", media:{src, kind, …}}` — register a media entry; id auto-generated if omitted, name defaults to the src file name
  - `{op:"removeMedia", id}` — unregister media that no clip uses
  - `{op:"splitClip", id | ids:[…] | all:true, t}` — cut at time `t` like the editor's split: that clip, those clips, or (`all`) every clip crossing `t` — each with its link group; the right pieces get new ids, and source time, speed ramps, keyframes and transitions stay right
  - `{op:"trimClip", id, side:"in"|"out", t}` — trim the head (`in`) or tail (`out`) to time `t`, like the editor's trim to playhead: the whole link group, keyframes stay where they play, the trimmed edge loses its transition
  - `{op:"moveClip", id, start | dt, track?}` — move the clip and its link group like a timeline drag without snapping: to `start`, or by `dt` seconds (clamped at 0); `track` moves only this clip, onto an existing lane of its kind
  - `{op:"closeGap", t}` — close the gap at time `t` like the editor's close gap: every targeted, unlocked lane must be empty at `t`; later unlocked groups on targeted lanes shift left by the gap every lane shares, with their link groups
  - `{op:"setTiming", id, start?, duration?}` — set start and/or duration like the inspector: the whole link group takes them (start ≥ 0, duration ≥ 0.05), and the partners take the clip's `in` and speed; keyframes keep their clip-local times
  - `{op:"setProject", set:{…}}` — change project fields; `null` deletes one. May change:
    `name`, `width`, `height`, `fps`, `background`, `folders`, `tracks`, `markers`,
    `inPoint`, `outPoint`, `disabledTracks`, `lockedTracks`, `untargetedTracks`, `exportFrame`, `encodeProfile`.

  The **timeline ops** (`splitClip`, `trimClip`, `moveClip`, `closeGap`,
  `setTiming`, and `removeClip` with `linked:true`) run the editor's own edit
  code (`core/edit.js`) exactly as the UI does for the same action, so their
  result equals the UI's (invariant INV-15). They read the document the way the
  editor loads it: a missing `in` counts as 0, and links are completed (a
  legacy `linkedId` pair, or an ungrouped audio clip matching a video's media
  and timing, becomes a `linkGroup`, as the editor saves it). A refusal throws
  the reason, so the patch is all-or-nothing: nothing crosses `t`, nothing to
  trim, no gap (in the editor's own words), or a lane the editor doesn't show.
  `moveClip {track}` accepts only a lane the editor shows: one in `tracks` (or
  the default lanes when `tracks` is absent), or one a clip already uses. To
  use a new lane, declare it first in the same patch with `setProject tracks`
  (the error gives the exact op). A clip on an undeclared lane is not an
  error, but it would add a `TRACK_UNDECLARED` warning, and the editor itself
  never drops a clip on a lane it doesn't show.

  The result starts with one note per op (`+c_x`, `~c_a`, `-c_b`, `split at 4s:
  c_v→+c_x, c_l→+c_y`, `trimmed c_v in to 2s: ~c_v ~c_l`, `moved c_v by +1s to
  3s: ~c_v ~c_l`, …) and ends with **`Changes:`**, a compact diff of what the
  patch did — `+<clip line>` added (`link:<group>` names a piece's link group),
  `-<id>` removed, `~<id> field: old→new, …` changed
  (timing, lane, media, `props.<k>`, `kf.<channel>` key counts, transitions),
  `project <field>: old→new` — so there is no need to re-read the project to
  check an edit. **`dryRun: true`** returns the same result (validation and diff
  included), prefixed `DRY RUN — nothing saved`, and writes nothing.
- `fablecut_validate` — check `project.json` (or a candidate `project`, not saved)
  against the schema and the editor's semantic rules. Read-only. See "Validation".
- `fablecut_import_media` — copy a local file (or download an `https://` URL)
  into `./media/` and register it. The stored `src` is always `/media/…`.
- `fablecut_analyze_reference` — turn a reference video into an edit blueprint
  (shots, beats, BPM, energy, drop) + extract its music. See "Remake a reference video".
- `fablecut_encode_profiles` — list export presets from `encoding-profiles.json` (each is a
  raw ffmpeg args list). Set `project.encodeProfile` via patch to pin a project default.

### Token-efficient editing (important for agents)

Editing via full get→modify→set costs thousands of tokens per change. Cheaper:

1. **Plan** from `fablecut_get_project {compact:true}` (≈10× smaller than the JSON)
   and `fablecut_status` — fetch the full JSON only to inspect exact keyframes.
2. **Edit** with `fablecut_patch_project` ops — send only what changes, e.g.
   `{ops:[{op:"updateClip", id:"c_v2", set:{props:{filterPreset:"noir"}}}]}`.
   It re-reads the latest document internally and checks its revision again
   before writing. If it changed, the original ops are retried on the latest
   document (up to four attempts). Pass `baseRevision` when the plan depends
   on a specific snapshot: a mismatch refuses with `CONFLICT`, even in a dry run.
   Its `Changes:`
   diff shows what landed — don't re-read the project to check; `dryRun:true`
   previews a risky patch without saving.
3. **Docs**: request `fablecut_docs {section:"schema"}` (or "Recipes", "Remake", …)
   instead of the whole manual; skip it entirely if the schema is already in context.
4. **Media questions** (duration, fps, size): read them from the registered media
   entries — don't shell out to ffprobe; the browser probes and writes them back.
5. **Cut, trim and move with the timeline ops**: `splitClip`, `trimClip`,
   `moveClip`, `closeGap` and `setTiming`, not an `updateClip` + `addClip`
   computed by hand. One op does what the editor does. It acts on the whole link
   group (the picture and its audio stems stay in sync). It takes each new `in`
   from the source time under the edge, so speed ramps stay continuous. It keeps
   one anchor keyframe per side, so fades and ramps play unchanged. It fits or
   drops transitions on the cut edges. Hand-computed cuts get these wrong,
   silently, and each wrong one costs a round trip to find.
6. Batch related changes into ONE patch call (ops apply in order, one revision bump).
7. **Check** with `fablecut_validate` after a batch of edits. Patch/set results
   already list any warning the edit introduced.

**`fablecut_set_project` is conflict-checked.** The MCP server remembers the
`revision` from the most recent `fablecut_get_project` call. If `project.json`
has been written by anyone else since that read (e.g. the user dragged a clip in
the UI), `fablecut_set_project` refuses with a "CONFLICT — not saved" error
instead of overwriting. Protocol:

1. `fablecut_get_project` → read the document and note its `revision`.
2. Apply your edits in memory, bump `revision`.
3. `fablecut_set_project` → if it succeeds you're done.
4. **On conflict**: call `fablecut_get_project` again to get the latest document,
   re-apply your intended changes on top of it, bump `revision`, and call
   `fablecut_set_project` again.

Pass `force: true` to `fablecut_set_project` only when the user explicitly
asks to overwrite conflicting changes.

**Patch and set are validated.** Both refuse a write that would add a
validation *error* (duplicate id, missing `start`, unknown `mediaId`, speed out
of range, …) and name each one by code; nothing is saved. Errors already on disk
never block an unrelated edit. Warnings don't block; new ones are listed in the
result. A clip sent without `in` gets `in: 0`. See "Validation". `fablecut_import_media` only appends a
new media entry and always merges safely — no conflict check needed.

For Claude Desktop, add to its MCP config:
`{"mcpServers":{"fablecut":{"command":"node","args":["<path-to>/fablecut/mcp-server.js"]}}}`
Direct file editing of `project.json` (below) works too and is equivalent.

Installing as a Claude Code plugin (`/plugin marketplace add ronak-create/FableCut`,
then `/plugin install fablecut@fablecut`) does the registration for you.

### Where the files are

`project.json`, `media/`, `exports/`, `analysis/` and `library/` normally sit in
the repo next to `server.js`. Set **`FABLECUT_DATA_DIR`** to move all five
somewhere else; the code and the static app files stay in the install directory
either way. The plugin sets this so a plugin update can replace the install
directory without touching anyone's timeline or footage. **Don't assume
`project.json` is beside `mcp-server.js`** — call `fablecut_status`, which
reports the real paths.

Tests (and nothing else) may set **`FABLECUT_NO_FS_WATCH=1`** to skip `fs.watch`.
On Windows, libuv can abort the process when a file is created under a temp
data dir. Production leaves watching on so the UI live-reloads.

## Run

```
node server.js        # → http://localhost:7777
```

Files: `index.html` + `style.css` + `app.js` (editor UI), `server.js` (API + hosting),
`project.json` (the timeline — THE file to edit), `media/` (project footage),
`library/` (default asset library, see below).

## How Claude Code edits a video

1. Ensure the server is running (background: `node server.js`, or `fablecut_status`).
2. Put source files in `./media/` (copy them in, import via the UI / **+ URL**,
   or `fablecut_import_media` with a local path or HTTPS URL).
3. Read `project.json`, modify `media` / `clips`, **increment `revision`**, write it back.
4. The browser UI (if open) reloads instantly. The user previews/exports from the UI.

Rules:
- **Prefer `fablecut_set_project`** over direct file writes — it detects conflicts
  automatically (see the MCP section above). If you do write `project.json`
  directly, read it **immediately** before writing (never write from a stale read:
  if the user tweaked something in the UI between your read and write, that write
  destroys their changes). The UI detects external changes by revision comparison,
  so a write that does not bump `revision` is invisible to it.
- Make each edit a single atomic write (read → modify → write once), and bump
  `revision` (integer). Partial multi-step edits can be picked up half-finished.
- New media entries may omit `duration` — the browser probes it and writes it back.
  If you need the duration yourself, re-read `project.json` after a second or two,
  or probe with ffprobe.
- Don't edit `project.json` while the UI may be mid-drag — the UI defers external
  reloads during gestures, then picks up the next change.

## The asset library (`./library/`) — default media

Reusable assets, visible in the editor's left-panel tabs and never copied:

| Folder      | Editor tab   | Purpose |
| ----------- | ------------ | ------- |
| `library/sfx/`      | **Sound FX** | whooshes, impacts, risers, UI clicks |
| `library/elements/` | **Elements** | overlay art: alpha PNGs, light leaks, textures, stickers |
| `library/svg/`      | **SVG**      | animated vector graphics **you author** (convention below) |
| `library/fonts/`    | font editor  | `.ttf/.otf/.woff/.woff2`, auto-registered, family name = file name |

- List via `GET /api/library?dir=sfx|elements|svg|fonts` (recursive; subfolders OK).
- To use one in the timeline, add a media entry whose `src` is its library path,
  e.g. `{ "id":"m_x", "name":"whoosh.mp3", "kind":"audio", "src":"/library/sfx/whoosh.mp3" }`
  — then reference it from clips like any other media.
- Dropping files into these folders live-refreshes the open UI.

## Authoring animated SVGs (the `svg` clip kind)

You can create your own vector animations/overlays: write an `.svg` file into
`library/svg/` (or `media/`), register it as media with `"kind": "svg"`, and
place it on a video track. The compositor renders it frame-accurately, driven
by the clip's local time (preview and export).

**Conventions (required for time-driven animation):**
1. Root `<svg>` must carry `width` and `height` attributes (or a `viewBox`).
2. Animate with **CSS `@keyframes` inside a `<style>` block** — SMIL
   (`<animate>`) is NOT time-controlled.
3. Never write a literal `animation-delay`. For staggered starts set the custom
   property `--d` on the element instead: `style="--d:0.4s"`. (The engine drives
   time by overriding `animation-delay` to `calc(var(--d,0s) - t)` with
   animations paused.)
4. `animation-fill-mode: both` (or the `both` keyword in the shorthand) for
   one-shot intros; `infinite` for loops — both work.
5. For rotations/scales around an element's own center add
   `transform-box: fill-box; transform-origin: center;`.
6. Keep files self-contained (no external hrefs).

Skeleton:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <style>
    .a { transform-box: fill-box; transform-origin: center;
         animation: pop 0.5s cubic-bezier(.34,1.56,.64,1) both; }
    @keyframes pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  </style>
  <circle class="a" style="--d:0s"   cx="200" cy="225" r="60" fill="#7b6cff"/>
  <circle class="a" style="--d:0.2s" cx="400" cy="225" r="60" fill="#ffd166"/>
</svg>
```

Examples in `library/svg/`: `sparkles.svg` (loop), `lower-third.svg`,
`confetti-burst.svg`, `underline-swoosh.svg` (draw-on via stroke-dashoffset).

## project.json schema

```jsonc
{
  "name": "My Edit",
  "width": 1280, "height": 720, "fps": 30,   // composition canvas + timeline/export rate — sole FPS source (UI: FPS select)
  "exportFrame": { "x": 438, "y": 0, "w": 404, "h": 720 },  // optional delivery crop (even w/h for H.264)
  // ^ omit = export the full canvas. Preview dims outside this rect; Fast export crops
  // JPEGs to w×h. Clip x/y/scale stay relative to the composition center, not the frame.
  // Frame size is always even (yuv420p / libx264); 9:16 on 1280×720 → 404×720, not 405.
  "background": "#000000",                    // canvas color behind all clips (optional)
  "revision": 7,                              // bump on every write!
  "panSchema": 1,                             // 1 = pan-aware; omit only on pre-pan projects (UI migrates once)
  "markers": [ { "t": 2.5 }, { "t": 5.0, "label": "drop", "color": "red" } ],
  // ^ beat/cue markers: diamonds on the ruler (label shown beside them), snap
  //   targets for clip edges. color: gold (default) · red · orange · green ·
  //   cyan · blue · purple · pink. Kept sorted by t; the UI rounds t to 1 ms.
  "inPoint": 10.023, // IN work-area marker (Limit playback + optional export range)
  "outPoint": 21.500, // OUT work-area marker; omit = timeline end
  "folders": [
    // Project-bin virtual folders (tree). Media reference them via folderId.
    { "id": "f_broll", "name": "B-roll", "parentId": null, "open": true }
  ],
  "disabledTracks": [ "A2" ],
  // ^ optional — track ids (e.g. V4 V3 V2 V1 A1 A2 A3) omitted from preview/export when listed
  "lockedTracks": [ "A3" ],
  // ^ optional — locked lanes: nothing on them may be edited or moved (see Semantics)
  "untargetedTracks": [ "V2" ],
  // ^ optional — lanes edits skip (split, insert, ripple, close gap…); default: all targeted
  "encodeProfile": "hq",  // optional — fast-export profile id (see encoding-profiles.json)
  "tracks": [                          // optional — timeline lanes (default V3…V1 + A1…A4)
    { "id": "V3", "kind": "video" },   // video: higher number drawn on top (V1 under V2 under V3…)
    { "id": "V2", "kind": "video" },
    { "id": "V1", "kind": "video" },
    { "id": "A1", "kind": "audio" },   // audio: A1…An top→bottom; +V/+A in the UI appends Vn+1 / An+1
    { "id": "A2", "kind": "audio" },
    { "id": "A3", "kind": "audio" },
    { "id": "A4", "kind": "audio" }
  ],
  "media": [
    { "id": "m_abc", "name": "intro.mp4", "kind": "video",  // video|audio|image|svg
      "src": "/media/intro.mp4",             // path under ./media or ./library (never a raw https:// URL)
      "duration": 12.4, "width": 1920, "height": 1080,
      "folderId": null }                     // optional: id of a folders[] entry
  ],
  "clips": [
    {
      "id": "c_xyz",             // unique string
      "mediaId": "m_abc",        // null for kind:"text" and kind:"adjust"
      "kind": "video",           // video | audio | image | svg | text | adjust
      "track": "V1",             // Vn…V1 (video) | A1…An (audio); extras via UI +V/+A or tracks[]
      "start": 0,                // timeline position, seconds
      "in": 2.5,                 // source position, s: media time (video/audio), animation time (svg); 0 for image/text/adjust; omitted = 0
      "duration": 5,             // clip length on timeline, seconds
      "name": "intro",
      "linkGroup": "lg_abc",     // OPTIONAL — AV link: video + per-channel audio stems share one id
                                 // and must share start/in/duration/speed (see Semantics)
      "styleName": "impact",     // OPTIONAL — title style the inspector last applied (text clips)
      "locked": true,            // OPTIONAL — locked by the user: leave it alone (MCP patch refuses edits)
      "disabled": true,          // OPTIONAL — stays on the timeline, hidden from preview / audio / export
      "unlinked": true,          // OPTIONAL — the user unlinked this clip; never auto-relinked on load
      "props": { /* all optional — see the props reference below */ },
      // OPTIONAL — keyframe animation. Times are seconds RELATIVE TO CLIP START.
      // "ease" sits on the DESTINATION keyframe of each segment:
      // linear | ease-in | ease-out | ease-in-out (default ease-in-out).
      // One key per side may lie OUTSIDE [0, duration] — an anchor (t < 0, or
      // t > duration) that shapes the curve at that edge; see Semantics.
      "keyframes": {
        "scale":   [ { "t": 0, "v": 1 }, { "t": 5, "v": 1.25, "ease": "linear" } ],
        "opacity": [ { "t": -0.5, "v": 0 }, { "t": 0.8, "v": 1 } ]  // an anchor: ramps from 0 half a second before the start
      },
      // OPTIONAL — transitions at the clip's head/tail.
      "transitionIn":  { "type": "fade", "duration": 0.8 },
      "transitionOut": { "type": "slide-left", "duration": 0.6 }
    }
  ]
}
```

### props reference

**Transform & compositing** (all visual kinds):
| prop | default | notes |
|---|---|---|
| `x`, `y` | 0 | px offset from canvas center |
| `scale` | 1 | |
| `rotation` | 0 | degrees |
| `opacity` | 1 | 0–1 |
| `blend` | "normal" | multiply · screen · overlay · lighter · soft-light · hard-light · color-dodge · darken · lighten · difference |

**Layout** (video/image/svg):
| prop | default | notes |
|---|---|---|
| `fit` | "contain" | contain · cover (fill canvas, crop overflow) · stretch · none (native px) |
| `cropL` `cropR` `cropT` `cropB` | 0 | % of the source trimmed off each edge |
| `cornerRadius` | 0 | px, rounded corners — the PiP look |
| `flipH`, `flipV` | false | mirror |

**Filter / color** (video/image/svg):
| prop | default | notes |
|---|---|---|
| `filterPreset` | "none" | one of: cinematic · teal-orange · noir · vintage · faded · warm · cold · pop · dreamy · retro · bw-soft · cyberpunk · sunset · midnight. Combines non-destructively with the sliders below. |
| `brightness` `contrast` `saturation` | 100 | % (100 = neutral) |
| `hue` | 0 | degrees |
| `temperature` | 0 | −100 (cool blue) … +100 (warm orange) |
| `tint` | 0 | −100 (magenta) … +100 (green) |
| `blur` | 0 | px |
| `grayscale` `sepia` `invert` `vignette` | 0 | % |

**Motion FX** (video/image/svg/adjust — all animatable but `shakeSpeed`):
| prop | default | notes |
|---|---|---|
| `shake` | 0 | camera-shake amplitude in px (deterministic — identical in export) |
| `shakeSpeed` | 8 | shake frequency |
| `rgbSplit` | 0 | chromatic aberration / RGB channel split, px |
| `grain` | 0 | animated film grain, % |

**Keying / cut-out** (video/image):
| prop | default | notes |
|---|---|---|
| `chromaKey` | "" | hex key color, e.g. `"#00ff00"` for green screen ("" = off) |
| `chromaTolerance` | 26 | 0–100, how much color distance is keyed out |
| `chromaSoftness` | 12 | 0–100, edge feather + spill suppression |
| `bgRemove` | false | AI person cut-out (MediaPipe, loads from CDN on first use; needs internet once) |

**Audio / time** (video/audio; `speed` also retimes svg):
| prop | default | notes |
|---|---|---|
| `volume` | 1 | 0–4 gain (the inspector slider stops at 2; the mixer clamps at 4) |
| `pan` | 0 | −1 (full left) … 0 (center) … +1 (full right). Linked stems default L `−1` / R `+1` / other `0`. Projects saved before pan migrate once on load (`panSchema`); keep `panSchema: 1` (and explicit `pan` on stems) when rewriting the document so a centered stem is not re-hard-panned. |
| `speed` | 1 | 0.1–8× playback rate (the engine clamps to this; the inspector slider covers 0.25–4). **Keyframable → speed ramps**: with `keyframes.speed` the engine time-remaps (media time = `in` + ∫speed dt), in preview and in the export audio mix; an svg clip's animation time follows the same mapping. Static case: source window consumed = `duration × speed`, so `in + duration×speed ≤ media.duration` (video/audio). |
| `audioChannel` | — | set on **linked audio stems** only: which source channel this stem plays (0 = L, 1 = R, …). The UI writes it when it splits a video's audio into per-channel clips; keep it when rewriting stems. |

**Text clips only:**
| prop | default | notes |
|---|---|---|
| `text` | "Title" | `\n` for multi-line |
| `fontSize` | 72 | px |
| `color` | "#ffffff" | fill |
| `color2` | "" | if set: vertical gradient fill color→color2 |
| `font` | "Segoe UI" | system font, a `library/fonts` family, or ANY Google Font name — unknown names are fetched from Google Fonts automatically |
| `bold` / `weight` | true / 0 | `weight` (300–900) overrides `bold` when non-zero |
| `italic` `uppercase` | false | |
| `align` | "center" | left · center · right · **justify** (inserts spaces between words to fill the text box width, or ~85% of the canvas when no box) |
| `boxW` `boxH` | 0 | px text box; **0 = hug content**. When both > 0, corner handles resize the box (not `scale`). Default: fixed `fontSize`, word-wrap inside the box. |
| `boxFit` | false | when a box is set: `false` = wrap at fixed font size; `true` = scale font down (up to `fontSize`) so the whole text fits |
| `vAlign` | "middle" | top · middle · bottom — vertical alignment of the text block inside the box |
| `direction` | "auto" | auto · ltr · rtl — `auto` detects per line (Hebrew/Arabic → RTL); all `textAnim` modes honor reading direction (wipe, typewriter reveal, word/letter layout) |
| `letterSpacing` | 0 | px |
| `lineHeight` | 1.2 | multiplier |
| `textShadow` | 12 | soft drop shadow amount, 0 = off |
| `glow` | 0 | neon glow strength (0–100); replaces the drop shadow |
| `glowColor` | "" | glow color ("" = use the text color) |
| `strokeWidth` `strokeColor` | 0, "#000000" | text outline |
| `bgColor` `bgOpacity` | "#000000", 0 | rounded pill behind each line |
| `textAnim` | "none" | typewriter · word-pop · word-slide · karaoke · **letter-pop** (per-character entrance; Arabic/Indic auto-fallback to per-word clusters so joined letters shape correctly) · **wave** (looping per-character ride; same shaping fallback) · **bounce** (looping per-word hop) · **shake** (looping jitter) · **clip-reveal** (wipe-mask sweep, per line) · **zoom-in** (scale + opacity settle) · **font-cut** (rhythmically swaps typeface, then settles — see `fontCutSet`) · **rise-mask** (line rises from behind its baseline, lower-third reveal) |
| `wordRate` | 0.15 | seconds per word (typewriter: /4, letter-pop: /3 per character); also staggers `clip-reveal`/`zoom-in`/`rise-mask` per line |
| `fontCutSet` | (curated) | array of font family names cycled by `font-cut`, e.g. `["Anton","Bebas Neue","Archivo Black","Oswald"]`; each is auto-loaded |

**Title styles (one-tap cohesive looks).** Text clips created in the UI now
rotate through curated styles so titles vary instead of all looking basic (the
old flat `Segoe UI` / no-animation default). Each style bundles a **different
font**, placement and animation. Apply one in the inspector (Title style
dropdown + Shuffle), or reproduce it from an agent by writing the same props:

| Style | Font | Look |
| --- | --- | --- |
| `impact` | Anton | uppercase, lower third, `word-pop`, big shadow |
| `elegant` | Playfair Display | white→gold gradient, centered, `clip-reveal` |
| `kinetic` | Bebas Neue | gold, `font-cut` cycling Anton/Bebas/Archivo/Oswald |
| `neon` | Bebas Neue | cyan `glow`, `wave` |
| `handwritten` | Caveat | rotated −4°, lower-left, `word-slide` |
| `serifDrop` | Abril Fatface | centered, `zoom-in` |
| `subtitle` | Roboto | small, bottom, bg pill, `karaoke` |
| `boldRise` | Archivo Black | uppercase, lower third, `rise-mask` |
| `luxury` | Cinzel | uppercase, cream→gold gradient, wide `letterSpacing`, `clip-reveal` |

**Rule for agents: vary the font per title — never reuse one font across a whole
edit.** Any Google Font name auto-loads; the display faces above ship in
`library/fonts/`. Placement props (`x`/`y`) are canvas-aware in the styles
(lower third ≈ `y: height*0.30`).

The inspector remembers the applied style in the clip's `styleName` field (e.g.
`"styleName": "neon"`); it is informational — the props carry the actual look.
Switching the style on an **existing** title (inspector dropdown/Shuffle) only
restyles the look (font, size, colors, shadow/glow, animation) — the clip's
`x`/`y`/`scale`/`rotation`/`align` and its `text` are preserved. The style's
canvas-aware placement is applied only when a title is first created.

**Adjustment layers** (`kind:"adjust"`, `mediaId:null`): a clip that re-renders
everything drawn *below* it (lower tracks + earlier clips) through its own
filter stack — Premiere-style. Supports all Filter/Color props, vignette,
grain, rgbSplit, temperature/tint, whole-frame `shake`, and `opacity` as the
intensity. Keyframe/transition it like any clip. Put it on V2/V3 above the
footage. Example: 0.3 s impact shake over everything =
`{kind:"adjust", track:"V3", duration:0.3, props:{shake:18}}`.

**Animatable props** (usable in `keyframes`): x, y, scale, rotation, opacity,
volume, pan, speed, brightness, contrast, saturation, hue, blur, grayscale, sepia,
invert, temperature, tint, vignette, cornerRadius, shake, rgbSplit, grain,
fontSize, letterSpacing, glow.

**Transition types**: fade · slide-left/right/up/down · zoom · wipe (=wipe-left)
· wipe-right/up/down · iris (circular) · spin · blur · whip (whip-pan) ·
glitch (RGB split + jitter) · pop (overshoot scale — stickers/captions).

### Semantics

- Rendering order: V1 is drawn first, then V2, V3, … on top. SVG/image/text clips
  go on any V track (higher V lanes are handy overlay lanes). Add lanes with the
  timeline **+V** / **+A** buttons (or by listing them in `tracks`); up to 16 per kind.
  Right-click an empty track header → **Remove track** (disabled if the lane has
  clips or is the last video/audio track).
- **Audio tracks A1–An** hold both standalone audio files *and* linked companions
  for imported video. Dropping a video creates the picture on a V track
  (`props.volume: 0` so it isn't doubled) plus one `kind:"audio"` clip per source
  channel on consecutive A-tracks that share a `linkGroup` (and the same
  `mediaId` / timing). Each stem is mono-isolated then placed with `pan` (defaults
  preserve stereo: L `−1`, R `+1`). Standalone music/SFX also live on A-tracks. Linked partners
  move/trim/split together — edit timing on any member of the group; do not treat
  A-tracks as music-only. When you write a group yourself, give every member the
  same `start`, `in`, `duration`, `speed` and `keyframes.speed`, and each stem its
  `props.audioChannel`; drifting members are a `LINK_DESYNC` warning.
- **A link group is one piece of footage.** `linkGroup` ids are kept exactly as
  written. On load the editor only links clips that have no group yet (a legacy
  `linkedId` pair, or an audio clip whose `mediaId` and start/in/duration match a
  video) and names the new group `lg_<video clip id>`, so reloads never rename
  anything. A member whose timing drifted stays linked and is reported as
  `LINK_DESYNC`; it is never silently unlinked. Every edit acts on the whole
  group, members on disabled lanes included (a disabled lane is hidden from
  preview and export, not unlinked): split, delete, move, close gap, trim to
  IN/OUT, trim to playhead, edge drags, and the inspector's Start / Length /
  Speed fields (edited on any member). A trim moves every member's edge by the
  same amount and re-bases each member's own keyframes, so a stem's volume fade
  keeps its place on the timeline. The group keeps one `start`, `in`,
  `duration`, `speed` and `keyframes.speed`, each member with its own copy of
  the ramp.
- **Undo** (in the UI) restores the document content: clips, media and bin
  folders. Removing a media entry from the bin (with its clips) is one undo
  step, and so are imports and folder changes. Marker edits also record their
  markers; clip-only entries leave later marker changes intact. IN/OUT, the
  lane list and lane enable/disable are not undo steps; a
  removed lane comes back if undo restores clips on it. An external write
  (agent, MCP, REST) resets the undo history.
- **Three track switches** (Premiere-style), all in the track header and all
  persisted on `project.json`:
  - **Enable (eye / speaker)** → `disabledTracks`. Output only: a disabled lane
    is left out of preview, audio and export. It does *not* affect editing.
  - **Target (click the track name — lit = targeted)** → `untargetedTracks`.
    Decides which lanes an edit touches when nothing is selected: split at
    playhead (S), insert ripple (`,`), replace punches (`.`), ripple-delete
    shifting (⇧Del), close gap (⇧G), next gap (G), split / trim at IN/OUT
    (T / ⇧T) and jump to cut (↑ / ↓). Source placement follows targeting too:
    the picture lands on V1 if it is targeted, else the lowest targeted video
    lane (none → the edit lands audio-only); stems land on the first two
    targeted audio lanes. A **selection** is always edited wherever it sits.
  - **Lock (padlock)** → `lockedTracks`. Nothing on a locked lane can be
    moved, trimmed, split, deleted or edited in the inspector, and ripples leave
    it where it is while the other lanes shift. A locked lane is never an edit
    target. Typical use: lock the music bed, then ripple the picture freely.
- **Clip lock / enable** — right-click a clip, or use the toggles at the top of
  the inspector. `locked: true` pins one clip the same way a locked lane does.
  `disabled: true` (⇧E) keeps the clip on the timeline but drops it from
  preview, audio and export — like a disabled lane, for a single clip. Both
  apply to the clip's whole linked group.
- **Locks and linked groups** — a linked A/V group with *any* locked member
  (its own flag or its lane) counts as locked as a whole, so sync is never
  broken by a partial move.
- **Sync lock** — edits that shift clips move the targeted lanes; linked AV
  partners always ride along, even on an untargeted lane, and locked groups
  stay put. On reload existing `linkGroup` ids remain stable; only missing
  groups are inferred from matching media and timing, respecting `unlinked`.
- **Unlink / link (Ctrl/Cmd+L)** — unlinking a group removes its `linkGroup`
  and stamps `unlinked: true` on each member, so the reload-time relink leaves
  them apart; picture and audio then move, trim and delete separately. Link
  (select one video clip plus its audio, Ctrl/Cmd+L) only joins clips of the
  same file that line up exactly — same start, in and duration — because a
  link here means identical timing.
- **Agents and locks** — `fablecut_patch_project` refuses `updateClip` /
  `removeClip` and explicit timeline edits on locked material (own flag, locked lane, or a linked partner
  of one) and `addClip` onto a locked lane. Treat locked clips as the user's
  finished work: leave them alone. `POST /api/patch` uses the same guard. Only when the user asks you to change one,
  pass `force: true` on that op, or unlock first with
  `updateClip set:{locked:null}` (always allowed). `fablecut_set_project`,
  REST `PUT` and direct file edits are not guarded — respect locks there too.
- Media is `fit`-ted to the canvas (default "contain"), then crop → scale/x/y/
  rotation → flips apply.
- `props` keys are all optional — missing keys get the defaults above.
- `in` is optional too: omitted means 0 (the MCP tools write `in: 0` for you).
- `in` is a source position only for the **timed kinds**: video and audio
  (media time) and svg (animation time — the SVG shows its CSS animation at
  `in` + ∫speed dt, so `props.speed` / `keyframes.speed` retime it too).
  Image, text and adjust clips always have `in: 0`; the editor resets any
  other value on load.
- Video/audio clips must satisfy `in + ∫speed dt ≤ media.duration`
  (`in + duration×speed` at a constant speed).
- Splits and trims keep the source mapping of timed clips, speed ramps
  included: the new `in` is the source time under the new edge, so the
  picture and an svg's animation don't jump. A right-edge drag stops where the
  ramp reaches the end of the media; a left-edge drag stops at `in: 0`.
- Keyframes fully override the static prop value while present; they are
  clip-local and are re-based automatically when clips are split or trimmed.
- **Anchor keys.** A key outside the clip (`t < 0` or `t > duration`) is an
  anchor: it is never on screen, but it shapes the curve at that edge — the
  segment from the anchor to the first (or last) key on the clip is
  interpolated as usual, and past the anchor its value holds. Each channel may
  have **one anchor per side**; keys beyond it never reach the clip and are
  flagged `KEYFRAME_OUT_OF_RANGE`. Splits and trims (keyboard, IN/OUT,
  edge drags, linked partners) keep the nearest key outside each new edge as
  its anchor and drop the rest, so every animation and speed ramp plays
  exactly as before the cut, for every ease — and a ramp's source mapping
  (`in` + ∫speed dt) is unchanged. Extending a clip's head plays the curve
  before 0 (the anchor's segment, then its value held). Agents may write
  anchors too, e.g. to start a clip mid-fade. The timeline draws no diamond
  for an anchor, keyframe navigation skips it, and the inspector's ◆ never
  sees it; removing the last key on the clip removes the channel, anchors
  included.
- Transitions modulate the evaluated props (fade also fades audio); they render
  on top of keyframes, so both can coexist.
- **Transitions after an edit** fit the clip: each is ≤ `duration`, and
  `transitionIn + transitionOut` ≤ `duration`. A split drops the transition at
  the cut and keeps each piece's outer one; a keyboard trim (trim to playhead,
  trim to IN/OUT) acts like a cut and drops the trimmed edge's transition; an
  edge drag keeps it. Whatever no longer fits is taken off the edited edge's
  transition first, then the other one. Replacing a clip's media with a
  shorter file cuts it where the source (speed ramp included) runs out, the
  same way. An edit that would change nothing records no undo step.
- Same-track overlap IS the crossfade idiom: overlap A and B by ~1 s and give B
  `transitionIn: {type:"fade", duration:1}` (a transition needs both `type` and
  `duration`).
- **Split with `splitClip`** (`{op:"splitClip", id, t}`, a patch op): it
  cuts the whole link group, takes the right piece's `in` from the source time
  under the cut (speed ramps included), keeps anchor keyframes and fits the
  transitions. By hand, a cut is two clips: first with `duration: t`, second with
  `start: +t, duration: rest` and `in` = the source time at the cut:
  `in + t×speed` at a constant speed, `in + ∫₀ᵗ speed dt` on a ramp, and
  `0` for image/text/adjust. Re-base the second piece's keyframes by `−t`
  and keep one anchor per side on each piece (above); each piece gets its
  own copy of `props`.
- **New titles and adjustment layers** (the UI's + Title / + Adjust) go on V2
  and V3; when that lane was removed, on the highest video lane.
- **Media added without a lane** (bin double-click, library +) or dropped on the
  wrong kind of lane: footage and images on V1, svg on V3, audio on A1. When
  that lane was removed: the lowest video lane for footage, the highest for
  svg, the first audio lane for audio.
- **Edit tools** (timeline toolbar picker, or V / B / R / Y / U) change what a
  clip drag does. They are editor gestures — agents get the same results by
  patching `start` / `in` / `duration` directly, keeping linked partners equal.
  - **Selection (V)** — move and trim, as always.
  - **Ripple edit (B)** — drag a clip edge; everything after it on the targeted
    tracks (and the clip's own lanes) moves with it, so no gap opens or closes.
    Dragging a head keeps the clip's start and trims its source In.
  - **Rolling edit (R)** — drag a cut; the clip on one side lengthens by what
    the other loses, nothing else moves.
  - **Slip (Y)** — drag a clip to change its source In only (dragging left shows
    later source); position and length stay. Video / audio clips only.
  - **Slide (U)** — drag a clip along its track; the clip before it trims its
    tail and the clip after it its head, so the sequence length stays.
  All four are clamped to the available source media, MIN_DUR and the free
  room on the track, take linked partners with them, and refuse on locked
  clips; a readout by the pointer shows the offset while dragging.
- **Lift (;) / Extract (')** — remove IN→OUT on the targeted tracks. Lift
  leaves the gap; Extract closes it. Linked partners are cut too, locked clips
  stay whole, and IN / OUT clear afterwards.
- **Jump to cut** — `↑` / `↓` move the playhead to the previous / next clip
  In or Out. Selection first (that clip’s start then end); no selection walks
  targeted-track cuts. Source monitor: 0 / In / Out / duration. Does not change
  `project.json`.
- `bgRemove` and `chromaKey` can combine with all filters; heavy pixel work is
  automatic (only runs when those props are set).

## Validation

Every writer shares one validator (`core/validate.js`): the MCP tools, the REST
`PUT`, and the editor UI. It checks `project.json` against the published JSON
Schema, **`schema/project.schema.json`** (generated from `core/schema.js`; the
contract other tools can validate against), plus semantic rules JSON Schema
can't express: unique ids, references that resolve, clip kind vs lane, source
windows that fit the media (speed-ramp aware), link groups in sync, keyframes
and transitions inside their clip, and unknown props (with a "did you mean"
hint).

Each issue is `{severity, code, path, pointer, message, hint?}`. `path` uses
clip/media ids (`clips[c_ab].props.speed`), `pointer` is an RFC 6901 pointer
(`/clips/3/props/speed`). As text: `error SCHEMA_MAXIMUM clips[c_ab].props.speed:
12 is above the maximum 8`.

- **Errors** are what crashes the editor, corrupts timing, or silently drops
  what you asked for: duplicate ids, dangling `mediaId`, missing or invalid
  `start`/`duration`/`kind`/`track`, a clip on the wrong kind of lane, an unknown
  transition / `textAnim` / `blend` / `fit` / ease, speed outside 0.1–8, canvas
  size or fps not > 0.
- **Warnings** are everything else: out-of-range looks (opacity 1.4), unknown
  props, a source window that runs past the media, keyframes past the clip end,
  link groups out of sync, legacy fields. The editor loads them and repairs or
  ignores what it can.

Where it runs:

- **`fablecut_validate`** — read-only; no args checks `project.json`, `{project}`
  checks a candidate without saving it. Call it after a batch of edits.
- **`fablecut_patch_project` / `fablecut_set_project`** — refuse only errors the
  write would *add* (issues are compared before and after the edit), so a
  problem already on disk never blocks an unrelated edit. Nothing is saved on
  refusal; the message lists each new error with its code and a hint. New
  warnings are appended to the success result. `fablecut_status` shows the
  current counts.
- **`PUT /api/project`** — always saves (the UI must never lose work) and returns
  `issues`; `?strict=1` answers **422** and writes nothing when there are errors.
- **Editor UI** — on load, problems are listed in the browser console (a
  collapsed "FableCut: project.json has …" group); errors also raise a toast.
  Loading is never blocked.

Codes ("per field" = graded by the schema: error for clip/media identity and
timing, the project canvas and the enums above; warning for looks, metadata and
the `folders`/`tracks`/`markers`/`exportFrame`/IN–OUT fields):

| code | severity | meaning |
|---|---|---|
| `SCHEMA_TYPE` | per field | value has the wrong JSON type |
| `NON_FINITE` | per field | number is NaN or ±Infinity (only possible in in-memory docs) |
| `SCHEMA_ENUM` | per field | value is not one of the allowed options |
| `SCHEMA_CONST` | per field | value differs from the schema's constant |
| `SCHEMA_MINIMUM` | per field | number below the minimum (e.g. start < 0) |
| `SCHEMA_MAXIMUM` | per field | number above the maximum (e.g. speed > 8) |
| `SCHEMA_EXCLUSIVE_MINIMUM` | per field | number not above the exclusive minimum (e.g. duration ≤ 0) |
| `SCHEMA_REQUIRED` | per field | required field missing |
| `SCHEMA_ADDITIONAL` | per field | unknown field in a closed object (track, keyframe, marker, …) |
| `DUP_CLIP_ID` | error | two clips share an id |
| `DUP_MEDIA_ID` | error | two media entries share an id |
| `MEDIA_REQUIRED` | error | video/audio/image/svg clip without a mediaId |
| `MEDIA_NOT_FOUND` | error | mediaId names no media entry |
| `TRACK_ID_INVALID` | error | lane id is not `V<n>` or `A<n>` (n ≥ 1) |
| `TRACK_KIND_MISMATCH` | error | audio clip on a V lane, visual clip on an A lane, or a declared lane whose kind contradicts its letter |
| `DURATION_TOO_SHORT` | error | clip shorter than MIN_DUR (0.05 s) but above 0 |
| `TRACK_UNDECLARED` | warning | clip on a lane missing from tracks (or from the default lanes); the editor adds it |
| `DUP_TRACK_ID` | warning | lane declared twice; the editor keeps the first |
| `DISABLED_TRACK_UNKNOWN` | warning | disabledTracks names a lane that doesn't exist; the editor drops it |
| `IN_MISSING` | warning | clip without `in`; the editor assumes 0 |
| `MEDIA_KIND_MISMATCH` | warning | clip kind can't play its media's kind |
| `MEDIA_OVERRUN` | warning | source window (in + ∫speed dt) runs past media.duration |
| `LINK_DESYNC` | warning | linkGroup members disagree on start/in/duration/speed/speed keyframes |
| `LEGACY_LINKED_ID` | warning | pairwise linkedId (superseded by linkGroup; the editor turns the pair into a group) |
| `KEYFRAMES_UNSORTED` | warning | keyframe channel not sorted by t |
| `KEYFRAME_OUT_OF_RANGE` | warning | keyframe outside the clip beyond its anchor: one key per side may sit before 0 / past the end |
| `KEYFRAME_NOT_ANIMATABLE` | warning | keyframes on a prop that can't be animated; ignored |
| `TRANSITION_TOO_LONG` | warning | transitionIn/Out (or both together) longer than the clip |
| `TRANSITION_ALIAS` | warning | legacy transition spelling (dissolve, wipe-left) or a `{type:"none"}` placeholder |
| `UNKNOWN_PROP` | warning | props key the editor doesn't know; kept but inert |
| `UNKNOWN_CLIP_FIELD` | warning | clip field the editor doesn't know; dropped on the next UI save |
| `FOLDER_NOT_FOUND` | warning | folderId/parentId names no folder; the editor resets it |
| `WORK_AREA_INVALID` | warning | outPoint ≤ inPoint; the editor clears both |

## Remake a reference video (analyze → blueprint → rebuild)

Given a reference edit (a reel/montage the user likes), FableCut can analyze it
and hand back an **edit blueprint** so the same idea can be rebuilt with
different footage over the same music.

**Run the analysis** (any of):
- MCP: `fablecut_analyze_reference {path:"C:\\…\\ref.mp4"}` (absolute path or an
  existing `/media/...` src; copies the file into `media/` if needed)
- REST: `POST /api/analyze` body `{"src":"/media/ref.mp4", "threshold":0.3, "music":true}`
  (GET `/api/analyze?src=/media/ref.mp4` returns the cached result)
- CLI: `node analyze.js media/ref.mp4` (results also cached in `./analysis/<name>.json`)

**The blueprint** (needs ffmpeg on PATH):
```jsonc
{
  "duration": 21.4, "fps": 30, "width": 1080, "height": 1920,
  "cuts": [1.8, 3.1, ...],            // detected shot boundaries, seconds
  "shots": [                           // one entry per shot between cuts
    { "index": 0, "start": 0, "end": 1.8, "duration": 1.8, "energy": 42 } ],
  "avgShotLen": 1.4, "cutsPerSecond": 0.7,
  "beats": [0.51, 1.02, ...],          // music onsets — snap cut points to these
  "bpm": 118,                          // detected tempo
  "energy": { "step": 0.5, "values": [12, 30, ...] },  // loudness curve 0–100
  "drop": 8.5,                         // biggest musical rise — the money moment
  "music": { "name": "ref-music.m4a", "src": "/media/…", "mediaId": "m_x" }
}                                      // ^ extracted + registered by the MCP tool
```
`threshold` tunes cut sensitivity (default adapts 0.30→0.20→0.12): lower it if
obvious cuts were missed, raise it if motion is being misread as cuts.

**Rebuild recipe** — the analysis is deterministic; the creative mapping is yours:
1. `setProject`: copy the reference's `width/height/fps`; write `beats`
   (or the `cuts`) into `markers` so the user sees the grid.
2. Music: the extracted track on A1, `in:0, duration:<ref duration>`.
3. Structure: one clip per `shots[]` entry on V1 at the same `start`/`duration`
   (hard cuts by default — that's what shot detection saw). Pick source footage
   whose motion matches each shot's `energy` (calm ≤40, action ≥70), and choose
   each clip's `in` so something interesting happens inside the window.
4. The `drop`: put the hero shot there; classic garnish = a speed ramp landing
   on it, an impact `adjust` layer (shake+rgbSplit), or a whip transition.
5. Pacing garnish to taste: shots shorter than ~0.6 s read as beat-flashes;
   `avgShotLen` tells you the reference's overall pace. Captions/grade/SFX per
   the Recipes section — the blueprint gives structure, not style.

## REST API (alternative to file editing)

- `GET  /api/project` — current project JSON
- `PUT  /api/project` — replace project JSON (body = full document).
  **Conflict-safe**: if the body's `revision` ≤ the revision currently on disk,
  the server rejects with **409** and returns `{"error":"…","revision":<current>}`.
  Append `?force=1` to overwrite unconditionally. Writes are atomic (tmp file +
  rename), so a crashed write never corrupts the file.
  **Validated**: the 200 response is `{"ok":true,"revision":N,"issues":[…]}`
  (errors first, at most 50; see "Validation"). The document is saved even with
  errors, because the UI must never lose work. Append `?strict=1` to refuse a
  document with errors instead: **422** `{"error":"…","issues":[…]}` and nothing
  is written. The revision check (409) runs first.
- `POST /api/patch` — body `{ops:[…], dryRun?, baseRevision?}`: the same ops, validation gate
  and diff as `fablecut_patch_project` (one interpreter, `core/patch.js`).
  The ops apply to the latest document, with a revision recheck before writing.
  If it changed, the original ops retry on the latest document (four attempts).
  `baseRevision` must be a non-negative integer; a mismatch returns **409**
  `{"error":"CONFLICT…","revision":<current>}`, as do exhausted retries.
  This is optimistic conflict detection, not an interprocess file lock.
  Bumps `revision` once and writes atomically; the UI
  live-reloads. **200** `{"ok":true,"revision":N,"notes":[…],"diff":[…],"warnings":[…]}`
  (`diff` = the `Changes:` lines, `warnings` = new warnings only) ·
  **422** `{"error":"…","issues":[…]}` when the result would add a validation
  error — nothing written, no op applied · **400** bad JSON, a missing/empty
  `ops`, invalid `baseRevision`, or an op that fails (unknown op, no such clip, …; `error` says which).
  `dryRun:true` answers the same way (200 adds `"dryRun":true` and the revision
  it would get) and writes nothing.
- `GET  /api/media`   — list files in ./media (name, src, size)
- `GET  /api/library?dir=sfx|elements|svg|fonts` — list library assets
- `POST /api/upload?name=foo.mp4` — raw body saved into ./media, returns `{src}`.
  MP4/MOV/M4V uploads are auto-remuxed with `+faststart` (needs ffmpeg on PATH).
  Files copied straight into ./media by external tools skip this — remux big ones
  yourself (`ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`) or playback stalls.
- `POST /api/import-url` — body `{url:"https://…"}` downloads the file into
  `./media/` and returns `{src,name}` (same-origin `/media/…`, like upload).
  HTTPS only; rejects localhost, private/link-local/CGNAT addresses, and
  redirects to those. Remote SVG is refused (`/media/*.svg` is served
  same-origin as `image/svg+xml` — a scripted SVG opened as a document would
  run on the editor origin). Does not write `project.json` — register the media
  afterwards (UI and `fablecut_import_media` do this). Do **not** put a
  raw `https://` URL (or another origin, including `localhost` on a different
  port) in `media.src`: canvas CORS would taint the compositor and Fast /
  WebCodecs export cannot JPEG-encode. Import into `./media` so `src` is
  `/media/…`, or serve the remote with `Access-Control-Allow-Origin`.
- `POST /api/analyze` — body `{src:"/media/ref.mp4", threshold?, music?}`: analyze a
  reference video into an edit blueprint (see "Remake a reference video"); extracts
  its music into ./media. `GET /api/analyze?src=…` returns the cached blueprint.
- `GET  /api/events`  — SSE: named event `change` when project.json, ./media or
  ./library changes; named event `profiles` when `encoding-profiles.json` changes
  (UI refreshes the export-profile list only — no project reload)
- Fast / WebCodecs export (browser compositor → server ffmpeg):
  `GET /api/export/ffmpeg` → `{available}` · `GET /api/export/profiles[?detail=1]` →
  `{default, profiles, issues}` · `POST /api/export/begin`
  `{fps,name,mode?,profile?,hasAudio?,pixelFormat?,width?,height?}` → `{id,mode,profile?,label,summary}`
  (`fps` is required — pass `project.fps`, no server-side default;
  `mode` is `"jpeg"` (default, Fast) or `"annexb"` (WebCodecs H.264 elementary stream);
  jpeg **400** if `profile` is not a defined id, or if ffmpeg rejects its args in the dry run;
  optional `pixelFormat:"rgba"` plus `width`/`height` pipes raw canvas frames instead of JPEG)
  · `POST /api/export/frame?id=` (JPEG body for jpeg mode; raw RGBA if `begin`
  used `pixelFormat:"rgba"`; Annex-B for annexb — one POST may concatenate frames
  or AUs. Must be after audio; ffmpeg is spawned on the first frame in both modes)
  · `POST /api/export/audio?id=` (WAV body — must be sent before the first frame)
  · `POST /api/export/end?id=[&discard=1]` → `{src}` under `/exports/`

## Recipes

**Edit like the UI** (timeline patch ops: the editor's own split, trim, move,
close gap and inspector timing, link groups included):

```jsonc
{op:"splitClip", id:"c_v", t:4}              // cut c_v (and its stems) at 4 s
{op:"splitClip", all:true, t:12.5}           // cut every clip crossing 12.5 s
{op:"trimClip", id:"c_v", side:"in", t:1.2}  // head to 1.2 s (tail: side:"out")
{op:"moveClip", id:"c_v", start:6}           // or dt:-0.5; track:"V2" changes lane
{op:"closeGap", t:9}                         // ripple-close the gap at 9 s
{op:"setTiming", id:"c_v", duration:3.5}     // the inspector's start / length
{op:"removeClip", id:"c_v", linked:true}     // delete c_v with its link group
```

**Assemble a rough cut**: clips back-to-back on V1; each `start` = running sum
of previous durations.

**Insert / replace at playhead (3-point editing)**: load media into the Source
monitor (double-click a bin item or timeline clip), mark the window with I/O,
then `,` (insert icon) splits straddling clips on targeted tracks at the
playhead, ripples everything later to the right by the window length, and drops
the Source window in — video brings its linked audio stems. `.` (replace icon)
overwrites instead: punches the placement tracks (V1 + linked stems) over
[playhead, +window) with no ripple. Placement lanes are resolved against the
live track list and follow targeting — if V1 / A1 / A2 were removed or
untargeted, the lowest remaining targeted lanes of the right kind are used
instead. Locked clips are never punched or split. A locked clip loaded into
Source can't be retargeted with `.` (toast) until it is unlocked. When Source was loaded *from* a timeline
clip, `.` instead retargets that clip's In/Out (and its linked stems) and
ripples later clips on its tracks if the duration changed.

**Ripple delete**: select clip(s), then ⇧Del or the timeline-toolbar **Ripple
delete** — removes the selection (linked partners included) and pulls later
clips left on each targeted track to close the gap. Plain Del lifts (leaves a
gap). Sync lock applies: linked partners on untargeted tracks move with the
ripple, and locked clips are neither deleted nor moved. An unselected clip that merely *overlaps* the deleted range stays put —
its overlap ends up bridging the shifted-in clip, so a crossfade across the cut
survives.

**Tighten a cut without breaking the rest**: Ripple edit (B) on the tail of the
shot that runs long — the rest of the edit follows. To change where a cut
falls between two shots without shifting anything else, Rolling edit (R) the
cut. To keep a shot's timing but use a better take of the same moment, Slip
(Y) it. To pull a whole segment out of the middle: set IN / OUT around it and
Extract (').

**Jump to cut**: select a clip, then ↑ / ↓ — playhead snaps to its In, then
Out (further taps walk neighboring cuts). No selection → previous / next cut
on targeted tracks. Source monitor: same keys jump among 0 / In / Out / duration.

**Protect finished work**: lock the lanes you are done with (`lockedTracks`,
or the padlock), e.g. `setProject {lockedTracks:["A3"]}` for a music bed. Now
insert, ripple delete and close gap re-time the picture without touching it.
To try an alternative without deleting a clip, disable it (⇧E / `disabled:true`).

**Title card**: `{kind:"text", mediaId:null, track:"V2", props:{text,fontSize,color}}`.

**Music bed**: audio file on A1, `props.volume: 0.3`, trim with `in`/`duration`.

**Center a mono stem**: linked or standalone audio clip with `props.pan: 0` (inspector **Pan** slider, −1…+1). Stereo video stems default to L `−1` / R `+1`; set A1 to `0` to center that channel in the mix.

**Cinematic grade**: `props.filterPreset: "teal-orange"` (tweak with
`temperature`/`vignette` on top).

**Green-screen composite**: subject clip on V2 with
`props: {chromaKey:"#00ff00", chromaTolerance:30, chromaSoftness:15}`,
background footage on V1.

**Remove background without a green screen** (people):
`props: {bgRemove:true}` — then put anything behind it on V1.

**Picture-in-picture**: clip on V3 with
`props: {scale:0.35, x:380, y:-200, cornerRadius:24}` — add
`transitionIn: {type:"slide-right", duration:0.5}` to fly it in.

**Slow motion / timelapse**: `props.speed: 0.5` (half speed) or `4` (4×).
Remember the source window is `duration × speed`.

**Speed ramp** (the reel move — fast into slow on the beat):
`keyframes: { speed: [ {t:0, v:3}, {t:1.1, v:3}, {t:1.3, v:0.4, "ease":"ease-out"} ] }`
— sync the drop (t:1.3) to a marker; add `transitionIn:{type:"whip",duration:0.2}` before it.

**Impact hit**: adjustment layer, 0.25–0.4 s at the hit:
`{kind:"adjust", track:"V3", props:{shake:20, rgbSplit:8}}` + `impact-hit.mp3`
from `library/sfx` on A2.

**VHS / glitch look**: `props: {rgbSplit:4, grain:35, saturation:120}` +
`library/elements/vhs-scanlines.svg` on V3 with `blend:"soft-light", fit:"stretch"`.
Cut between shots with `transitionIn:{type:"glitch",duration:0.3}`.

**Film look**: adjustment layer across the whole edit:
`props: {filterPreset:"cinematic", grain:18}` — one clip grades every shot.

**Neon caption**: `props: {glow:60, glowColor:"#22d3ee", color:"#ffffff",
font:"Bebas Neue", textAnim:"wave"}` on a dark shot.

**Light leak accent**: `library/elements/light-leak-warm.svg` on V3,
`props:{blend:"screen", fit:"cover", opacity:0.7}`, 1–2 s at scene changes,
`transitionIn/Out: fade`.

**Light-leak / dust overlay**: element from `library/elements` on V3 with
`props: {blend:"screen", opacity:0.6, fit:"cover"}`.

**Reel caption**: text clip with `props: {textAnim:"word-pop", wordRate:0.15,
strokeWidth:6, bgColor:"#000000", bgOpacity:0.45, fontSize:88}`. `karaoke`
dims words until "spoken"; `typewriter` for terminal vibes.

**RTL / Hebrew / Arabic caption**: omit `direction` (defaults to `"auto"`) or set
`direction:"rtl"` explicitly; pick a font with the script's glyphs (Google Fonts
work). Animations wipe and stagger in reading order automatically. `letter-pop` /
`wave` animate whole words on Arabic/Indic lines (not isolated letters) so
cursive joining stays correct.

**Branded title**: `props: {font:"Bebas Neue", weight:700, letterSpacing:6,
uppercase:true, color:"#ffffff", color2:"#7b6cff", textShadow:20}` — any Google
Font name just works.

**Kinetic font-cut title** (rhythmic typeface cuts on the beat, then settle):
`props: {font:"Bebas Neue", fontSize:120, uppercase:true, color:"#ffd166",
textAnim:"font-cut", fontCutSet:["Anton","Bebas Neue","Archivo Black","Oswald"]}`.

**Elegant clip-on title** (letters wipe in): `props: {font:"Playfair Display",
fontSize:88, color:"#ffffff", color2:"#ffd166", letterSpacing:2,
textAnim:"clip-reveal"}` — centered, one clean sweep.

**Lower-third reveal**: `props: {font:"Archivo Black", fontSize:92,
uppercase:true, textAnim:"rise-mask", y:<height*0.30>}` — the line rises from
behind its baseline. Pair with a `serifDrop`/`zoom-in` kicker above it.

**Custom font**: drop `MyBrand.ttf` into `library/fonts/`, then
`props.font: "MyBrand"`.

**Animated sticker**: author an SVG (convention above) into `library/svg/`,
register `{kind:"svg", src:"/library/svg/foo.svg"}`, clip on V2/V3. Scale/move/
rotate with normal props & keyframes; the SVG's own CSS animation plays on top,
frame-accurately.

**Whoosh on a cut**: 0.4 s sfx clip from `library/sfx` on A2 aligned to the cut.

**Ken Burns** (slow push on a photo):
`keyframes: { scale:[{t:0,v:1},{t:D,v:1.2,ease:"linear"}], x:[{t:0,v:0},{t:D,v:-40,ease:"linear"}] }`.

**Crossfade**: overlap two clips on the same track by ~1 s; later clip gets
`transitionIn: {type:"fade", duration:1}`.

**Whip-pan cut**: A gets `transitionOut:{type:"whip",duration:0.25}`, B gets
`transitionIn:{type:"whip",duration:0.25}`.

**Beat-synced cut**: write beat times into `markers`, then cut on them with
`{op:"splitClip", id, t:<beat>}` (or `all:true`) and land clips on them with
`{op:"moveClip", id, start:<beat>}` or `trimClip` (the UI also snaps drags to
markers).

**Label the structure**: write named, coloured markers for sections the user
can jump between (⇧M / Alt+⇧M, or the Markers list):
`setProject {markers:[{t:0,label:"intro",color:"blue"},{t:8.5,label:"drop",color:"red"},{t:24,label:"outro",color:"purple"}]}`.
`setProject` replaces the whole list — include the existing markers you want to keep.

**Music fade-out**: audio clip `keyframes: { volume:[{t:D-3,v:0.8},{t:D,v:0}] }`
or simply `transitionOut: {type:"fade", duration:3}`.

**Pulse / emphasis**: `keyframes: { scale:[{t:0,v:1},{t:0.3,v:1.12},{t:0.6,v:1}] }`.

**Reframe horizontal → vertical**: keep a wide composition canvas and crop for
delivery — e.g. `width:1920, height:1080` with
`exportFrame:{x:656,y:0,w:608,h:1080}` (9:16 fitted to canvas height). Position
footage with clip `x`/`y`/`scale`; the export frame can be dragged in the UI.
Omit `exportFrame` to export the full canvas.

**Vertical reel**: set project `width:1080, height:1920`; use the UI's safe-area
guides (▦) to keep captions out of platform UI zones.

**Project frame rate**: set `fps` in `project.json` (or the Program Monitor FPS
dropdown — 24 / 25 / 30 / 50 / 60). Preview stepping, timecode frames, Fast /
WebCodecs / Realtime export, and `/api/export/begin` all use this value; pass the same
`fps` when starting an export via the API.

## Export

Export is user-driven (Export button → dialog). Three engines:

1. **Fast** — browser renders each frame with the normal compositor (SVG, keys,
   AI masks), streams JPEGs + an offline WAV mix to the server; a single ffmpeg
   pass encodes them via an **encoding profile** into `./exports/`. Quality /
   software path; keeps rendering if you switch tabs.
2. **WebCodecs** — same frame-accurate compositor loop, but the browser’s
   `VideoEncoder` produces Annex-B H.264 (Main 4:2:0) and the server stream-copies
   (`-c:v copy`) while muxing the WAV. Faster uploads, less server CPU. Requires
   Chromium-class `VideoEncoder` with `avc: { format: "annexb" }` plus ffmpeg.
   Encoding profiles do not apply (the bitstream is already encoded). No ffmpeg-style
   CRF — quality is bitrate + VBR/CBR (export dialog; remembered in localStorage).
   Optional `bitrateMode: "quantizer"` (fixed QP) exists in the spec but is rarely
   supported by hardware encoders with Annex-B. Unavailable while an `exportFrame`
   crop is set — use Fast for cropped delivery.
3. **Realtime (MediaRecorder)** — automatic offline fallback when the server,
   ffmpeg, or WebCodecs is unavailable. Plays the timeline once and records it;
   keep the tab focused.

The exported span is chosen in the Export dialog (**Range**: Entire
timeline / IN–OUT). IN–OUT is the default when `inPoint` / `outPoint` are
set; pick Entire timeline to keep those markers for split/trim. Effective
IN/OUT export bounds are clamped to `projDur` so an IN past the last clip
cannot produce a one-frame black file.

1. Entire timeline (or no markers) → the whole timeline
2. IN–OUT, IN only → from `inPoint` to the end
3. IN–OUT, OUT only → from the start to `outPoint`
4. IN–OUT, both → the range between them

Claude cannot trigger export headlessly — the compositor lives in the browser;
ask the user to click Export, or render with ffmpeg directly from `media/`
sources if a file is needed.

### Encoding profiles (`encoding-profiles.json`)

User-editable at the repo root. A profile is a **raw ffmpeg argument list** plus the
things that are not ffmpeg arguments: `jpegQuality` (browser frame quality),
`extension` (output container), and optional `color` (output matrix / range tags).
Edit the file while the server runs — the UI hot-reloads the profile list via an SSE
`profiles` event (no full project reload). Fast export only; WebCodecs ignores them.

```jsonc
{
  "default": "delivery",           // profile id used when nothing else is set
  "profiles": {
    "draft": {
      "label": "Draft · H.264 fast",
      "description": "Quick preview — smaller file, faster encode.",
      "jpegQuality": 0.85,         // browser JPEG frame quality (0.1–1)
      "extension": ".mp4",
      // Output color (optional — defaults to BT.709 limited/tv). Independent of
      // -pix_fmt: yuv420p and yuv422p10le both typically use bt709 for HD SDR.
      "color": { "matrix": "bt709", "primaries": "bt709", "trc": "bt709", "range": "tv" },
      "args": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
               "-movflags", "+faststart", "-shortest"]
    }
  }
}
```

Export is **one ffmpeg pass**. The server owns the input side and the output path;
`args` is everything in between (plus JPEG color conversion derived from `color`):

```
ffmpeg -y -f image2pipe -framerate <fps> -i - [-i audio.wav] <jpeg-color> <args…> exports/<name><extension>
```

- **There is no allow-list.** Any codec, filter, container or flag your local ffmpeg
  supports works — ProRes, DNxHD, NVENC/QSV/VideoToolbox, VP9/AV1, 10-bit, HDR tags.
  See the shipped `prores422` and `broadcast1080i50` profiles.
- **Args are validated by ffmpeg itself**, not by a schema: when an export starts the
  server dry-runs the profile against a 0.1 s synthetic input (`lavfi`). A typo or an
  encoder your build lacks is rejected up front with ffmpeg's own message, instead of
  failing after every frame has been rendered.
- Use the **array form** — each element is passed to `spawn` untouched, so no quoting
  is needed (`["-vf", "drawtext=text='hi there'"]` just works). A plain string is
  accepted and split on whitespace.
- **`color`** controls JPEG→YUV conversion and stream tags (`-colorspace` /
  `-color_primaries` / `-color_trc` / `-color_range`). Default is BT.709 limited
  (`range: "tv"`). Use `"range": "pc"` for full-range masters. Do **not** put those
  flags in `args` — the engine strips them and applies `color` so vf and tags stay
  aligned. `-pix_fmt` stays in `args` (sampling / bit depth only).
- Nothing else is injected for you: `+faststart`, `-shortest`, `-strict -2` for Opus
  in MP4 and pixel-format choices are all yours to write.
- Frames arrive as **JPEG (4:2:0)**, so `yuv422p`/`yuv444p` cannot recover chroma the
  source never had; raise `jpegQuality` before reaching for a wider pixel format.
  Optional `pixelFormat:"rgba"` on `/api/export/begin` pipes uncompressed canvas
  frames instead (`-f rawvideo`) when a caller wants full chroma.
- The audio mix is only present when the timeline has audio; with no audio there is a
  single input, so avoid hardcoded `-map 1:a`.

**Note:** Fast export pipes **composited JPEG frames** from the browser (`-f image2pipe`),
not `-i source.mp4`. Filters and codec settings apply to that frame stream. To transcode
an existing file verbatim, run ffmpeg directly — that is outside the compositor path.

**Which profile is used (priority):**
1. Profile picked in the Export dialog (one-off; saved to browser settings unless overridden)
2. `project.encodeProfile` — set via UI reload or `{op:"setProject", set:{encodeProfile:"hq"}}`
3. Browser setting `encodeProfile` in localStorage (set when you change the Export dropdown)
4. `default` in `encoding-profiles.json`

**MCP:** `fablecut_encode_profiles` lists profiles; `{detail:true}` includes each `args`
array; `{profile:"hq"}` returns one profile. `fablecut_status` shows the effective profile.
