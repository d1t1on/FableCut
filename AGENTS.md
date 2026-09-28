# Working with FableCut

The complete agent manual is in [CLAUDE.md](CLAUDE.md). Read it before changing the project schema, using the MCP tools, or editing the timeline. This file exists so agents that look for the cross-tool `AGENTS.md` convention, including OpenCode and Codex, find the same source of truth without duplicating it.

## Project constraints

- Keep FableCut zero-runtime-dependency and standard-library only.
- Keep preview and export on the same compositor path.
- The project schema and timeline constants (`PROJECT_SCHEMA`, `DEFAULT_PROPS`, `ANIMATABLE`, `TRANSITIONS`, `EASE`, `MIN_DUR`, …) live in `core/schema.js`, a dual-mode classic script (browser: `FableCore.schema`; Node: `require`). Change them there — never re-declare them in `app.js` or `mcp-server.js`.
- Schema workflow: edit `core/schema.js`, run `npm run schema` to regenerate `schema/project.schema.json` (CI fails when it is stale), and add validation rules to `core/validate.js` with a code in `CODES` plus a row in CLAUDE.md's "Validation" table.
- When driving the editor through MCP, call `fablecut_validate` after a batch of edits. Patch/set refuse only errors an edit adds; warnings are advisory.
- Prefer small, focused changes and preserve the existing terse browser-native style.
- If a schema, prop, text animation, API, or MCP surface changes, update `CLAUDE.md` and the English `README.md` in the same change.
- Run `npm run check && npm test` before opening a PR (`check` syntax-checks every JS file and parses every JSON file). `npm run coverage` is the `core/` coverage gate CI runs.
- Timeline edit behavior is pinned by `test/edit-ops.test.js`. Known bugs there are `todo: "BUG-xx"` tests: fixing one means removing its `todo`, seeing it fail, then making it pass.
- Property tests (`test/props/`, fast-check, a devDependency) check the invariants in `docs/specs/invariants.md` (INV-01…14; decisions in `docs/specs/0001-timeline-edit-semantics.md`) on generated valid projects and random op sequences through `core/`. `npm test` runs them at 100 runs, `npm run test:props` at 1000. Replay a failure with the seed it prints: `FC_SEED=<seed> npm run test:props`. A property that fails today is `todo: "BUG-xx: …"`: the todo names the bug it waits on, and fixing that bug means removing the todo there too. A new bug a property finds gets the next BUG id and a minimal regression test in `test/core/regressions.test.js`.

## Where the logic lives

The timeline core is in `core/`, as dual-mode classic scripts (browser: `FableCore.<module>`; Node: `require`). Pure functions: the project document and an explicit `ctx` go in, nothing reads the DOM or app state.

- `core/schema.js`: the `project.json` schema and every timeline constant.
- `core/keyframes.js`: keyframe curves, speed-ramp time remapping (`mediaTimeAt`), the keyframe mutators.
- `core/compose.js`: what the compositor draws for a clip at time t (`evalProps`, filter presets, transitions).
- `core/links.js`: AV link groups: partner expansion, timing sync, relink on load and after a split.
- `core/edit.js`: split, trim, close gap, delete, and the clip-drag math.
- `core/history.js`: the undo/redo stacks.
- `core/project.js`: load and save: `normalizeProject`, `serializeProject`, the field normalizers, lane defs.
- `core/validate.js`: the validator every writer uses.
- `core/summary.js`: the compact one-line-per-clip view and the diff a patch reports.
- `core/patch.js`: the patch interpreter behind MCP `fablecut_patch_project` and REST `POST /api/patch`.

Patch ops live in `core/patch.js`'s `OPS` table: one row per op (`name`, `params`, one-line `doc`, `run(doc, op, ctx)`, and `timeline: true` for the editor's own edits). The tool description, the unknown-op error and `TIMELINE_OPS` are generated from it. Adding an op = adding a row + a test in `test/core/patch.test.js` + a line in CLAUDE.md's op list under "## MCP connection" (`test/contract/patch-docs.test.js` fails until it is there, and until README's MCP paragraph names it; a timeline op must also be named in CLAUDE.md's "Token-efficient editing" and the manifest's patch tool description). A timeline op calls `core/edit.js` exactly as app.js's wrapper does for the same UI action, and INV-15 (`test/props/inv-15-patch-equivalence.test.js`) checks that against the driver.

`app.js` keeps the old global names (`splitAtPlayhead`, `applyProject`, `projectJSON`, `pushUndo`, …) as thin wrappers. A wrapper reads the playhead, selection and lanes, calls core, and only adds UI side effects: toasts, saves, redraws, the inspector, media elements. Don't put timeline logic back into `app.js`; `test/contract/core-boundary.test.js` fails when app.js re-declares what core owns. Tests `require` core directly. `test/support/slice.js` may slice only code that still lives in `app.js`.

## MCP entry point

The local MCP server is `mcp-server.js`. It can be started by any stdio-capable MCP client:

```bash
node /absolute/path/to/FableCut/mcp-server.js
```

Use the existing `CLAUDE.md` recipes and tool descriptions rather than inventing a second protocol or schema.
