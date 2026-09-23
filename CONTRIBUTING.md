# Contributing to FableCut

Thanks for your interest in FableCut! This is a zero-dependency, single-purpose
project, and contributions of all sizes are welcome — bug reports, new
transitions, filter presets, animated SVG starters, docs, or core engine work.

## Ground rules

- **No runtime dependencies.** FableCut ships as plain HTML/CSS/JS + a Node
  standard-library server. Please keep it that way — no `npm install` should ever
  be required to run the editor. Dev-only tooling in `devDependencies` is fine if
  it earns its place.
- **One compositor.** Preview and export share the same `drawFrame(t)` code path.
  Any visual feature must render identically in both — never fork the renderer.
- **Match the surrounding style.** Terse, no framework, no build step. Look at how
  neighbouring code reads and follow it.

## Getting set up

```bash
git clone https://github.com/ronak-create/FableCut.git
cd FableCut
npm ci                # dev-only tooling (ajv, for the schema contract test)
node server.js        # → http://localhost:7777
```

Requirements: **Node 22+**, a Chromium-based browser, and (optional but
recommended) **ffmpeg on PATH** for fast export and upload remuxing.

The runtime is still zero-dependency — `node server.js` works without `npm ci`,
and `test/contract/zero-deps.test.js` keeps it that way. `npm ci` only installs
`devDependencies` for the tests; a test that needs one skips locally when it is
missing (CI sets `FABLECUT_REQUIRE_DEV=1`, which turns that skip into a failure).

## Where things live

| File | What it is |
| --- | --- |
| `server.js` | HTTP server: static hosting, REST API, SSE, ffmpeg export pipeline |
| `app.js` | The editor — timeline UI, compositor, keyframes, text engine, SVG rasterizer, chroma key, exporters |
| `index.html` / `style.css` | Single-page UI + dark theme |
| `mcp-server.js` | stdio MCP server exposing the editor to AI agents |
| `core/schema.js` | The `project.json` schema (`PROJECT_SCHEMA`) and timeline constants (`DEFAULT_PROPS`, `TRANSITIONS`, …) — one source for the UI, server and MCP server |
| `core/validate.js` | The validator every writer uses; its codes and their severity are listed in `CODES` |
| `schema/project.schema.json` | The published JSON Schema, generated from `core/schema.js` — never edit it by hand |
| `CLAUDE.md` | The agent manual — schema, semantics, recipes. **Keep this in sync with any schema change.** |

## Making a change

1. Fork and branch from `main` (`git checkout -b my-feature`).
2. Make your change. Keep commits focused.
3. **Run the test suite** before pushing:
   ```bash
   npm run check     # node --check on every JS file + parse every JSON file
   npm run schema -- --check   # schema/project.schema.json matches core/schema.js
   npm test          # node --test (run `npm ci` first for the dev-only tests)
   ```
   It covers the MCP protocol and tools, the REST API and its path/Host guards,
   the shipped SVG library, and the timeline edit operations (split, trim, gap,
   drag, undo — `test/edit-ops.test.js`, driven through `test/drivers/edit.js`
   against the fixtures in `test/fixtures/`). CI runs the same commands on
   Node 22 and 24 for every pull request. Add a test with your change when it touches any of
   those surfaces — see [`test/`](test/) and the harness in `test/helpers.js`
   (every test gets a throwaway data dir and its own port, so the suite never
   touches your real `project.json`).

   Then open the editor and confirm your change renders in **both** preview and a
   test export — the compositor itself runs in the browser and is not covered by
   the suite.
4. If you touched the `project.json` schema, props, transitions, text anims, or
   the API, **update `CLAUDE.md` and the `README.md` feature list** in the same PR.
   Schema changes start in `core/schema.js`; then run `npm run schema` to
   regenerate `schema/project.schema.json` and commit both. A new validation
   rule goes in `core/validate.js` with a code in `CODES`, and a row in the
   "Validation" table of `CLAUDE.md` (a test checks the table).
5. Open a pull request against `main` using the PR template. Describe what changed
   and how you verified it.

## Adding common things

- **A transition** — extend the `TRANSITIONS` array in `core/schema.js` and
  `applyTransition()` in `app.js`. Transitions modulate evaluated props; keep
  them deterministic so they export identically.
- **A filter preset** — add an entry to `FILTER_PRESETS` in `core/schema.js`.
- **A text animation** — add to `TEXT_ANIMS` in `core/schema.js` and handle it
  in `drawText()`.
- **An animated SVG starter** — drop a self-contained `.svg` into `library/svg/`
  following the conventions in
  [CLAUDE.md](CLAUDE.md#authoring-animated-svgs-the-svg-clip-kind) (use `--d` for
  staggered delays, CSS `@keyframes` only — never SMIL).

## Translations (`docs/i18n/`)

The English `README.md` is the single source of truth; `docs/i18n/` holds full
translations of it, section for section.

- **Don't translate identifiers.** Prop names, tool names, file paths, CLI
  commands, filter/transition/text-anim names, UI labels that appear in the app
  in English (`Source`, `Browse file…`, `Scale to fit`, `Fit`, `Limit`) and
  everything inside code fences stay as-is. Translate the prose around them.
- Each file ends with a sync note giving the `README.md` commit it was written
  against. Update that short SHA whenever you re-sync a translation.
- Adding a language: copy `docs/i18n/README.es.md`, translate, then add your
  language to the selector line at the top of **every** i18n file and of the
  root `README.md`. Relative links resolve from `docs/i18n/`, so the repo root
  is `../../` (e.g. `../../CLAUDE.md`) and the screenshot is `../screenshot.png`.
- **Feature PRs only need to touch the English README.** Translations are
  re-synced separately; a translation that lags is expected, and the sync note
  tells readers how far behind it is.

## Reporting bugs & requesting features

Use the issue templates. For bugs, include your OS, browser, Node version, and —
if relevant — a minimal `project.json` that reproduces the problem.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
