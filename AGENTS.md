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
- Run `npm run check && npm test` before opening a PR. The full script list, the development rules and the single-source-of-truth registry are in [Development](#development) below.
- Timeline edit behavior is pinned by `test/edit-ops.test.js`. Known bugs there are `todo: "BUG-xx"` tests: fixing one means removing its `todo`, seeing it fail, then making it pass.
- Property tests (`test/props/`, fast-check, a devDependency) check the invariants in `docs/specs/invariants.md` (INV-01…15; decisions in `docs/specs/0001-timeline-edit-semantics.md`) on generated valid projects and random op sequences through `core/`. `npm test` runs them at 100 runs, `npm run test:props` at 1000. Replay a failure with the seed it prints: `FC_SEED=<seed> npm run test:props`. A property that fails today is `todo: "BUG-xx: …"`: the todo names the bug it waits on, and fixing that bug means removing the todo there too. A new bug a property finds gets the next BUG id and a minimal regression test in `test/core/regressions.test.js`.

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

Patch ops live in `core/patch.js`'s `OPS` table: one row per op (`name`, `params`, one-line `doc`, `run(doc, op, ctx)`, and `timeline: true` for the editor's own edits). The tool description, the unknown-op error and `TIMELINE_OPS` are generated from it. Adding an op = adding a row + a test in `test/core/patch.test.js` + a line in CLAUDE.md's op list under "## MCP connection" (`test/contract/patch-docs.test.js` fails until it is there, and until README's MCP paragraph names it; a timeline op must also be named in CLAUDE.md's "Token-efficient editing"; the manifest's patch tool line is built from `TIMELINE_OPS` in `mcp-tools.js`, so run `npm run manifest`). A timeline op calls `core/edit.js` exactly as app.js's wrapper does for the same UI action, and INV-15 (`test/props/inv-15-patch-equivalence.test.js`) checks that against the driver.

`app.js` keeps the old global names (`splitAtPlayhead`, `applyProject`, `projectJSON`, `pushUndo`, …) as thin wrappers. A wrapper reads the playhead, selection and lanes, calls core, and only adds UI side effects: toasts, saves, redraws, the inspector, media elements. Don't put timeline logic back into `app.js`; `test/contract/core-boundary.test.js` fails when app.js re-declares what core owns. Tests `require` core directly. `test/support/slice.js` may slice only code that still lives in `app.js`.

## Development

### Scripts

| script | what it does |
|---|---|
| `npm start` | Run the editor server (`node server.js`, http://localhost:7777). |
| `npm run check` | `node --check` every JS file and parse every JSON file git tracks or would add. |
| `npm test` | The whole suite (`node --test`), properties at 100 runs. Keep it at about 6 s. `FABLECUT_REQUIRE_DEV=1 npm test` (CI) fails instead of skipping when a devDependency is missing. |
| `npm run test:props` | The property tests at 1000 runs. Replay a failure with the seed it prints: `FC_SEED=<seed> npm run test:props`; add `FC_PATH=<path>` and `-- --test-name-pattern=INV-xx <file>` to jump to the shrunk case. |
| `npm run coverage` | The suite with the `core/` line / function / branch gate CI runs (thresholds in package.json; raise them, never lower them). |
| `npm run crap` | A one-off CRAP report, not a gate (`scripts/crap.js`). It runs the suite with `core/` coverage, then ranks `core/` functions by CRAP = c²·(1−cov)³ + c (top 20, plus every function over the action bar: CRAP > 30, or coverage < 80% with c ≥ 8) and app.js functions by complexity alone (top 25: the backlog for the next extraction into `core/`). Writes `reports/crap.md`. Run it after a batch of `core/` work and before extracting more of app.js. `-- --no-run` reuses `coverage/lcov.info`. |
| `npm run mutation` | Stryker mutation testing of the `mutate` list in `stryker.config.json`. Manual, or weekly in `.github/workflows/mutation.yml`; never a PR check. A full run takes 15 to 25 minutes. Every mutant runs `scripts/mutation-tests.js`: test/core and test/props, 25 fast-check runs from a fixed seed. Run it after changing `core/edit.js`, `core/links.js` or `core/keyframes.js`, or their tests. See [Mutation testing](#mutation-testing). |
| `npm run schema` | Regenerate `schema/project.schema.json` from `core/schema.js`. `npm run schema -- --check` writes nothing and fails when it is stale (CI). |
| `npm run manifest` | Regenerate `manifest.json` `tools` from `TOOLS` in `mcp-tools.js`. `npm run manifest -- --check` fails when it is stale (CI). |
| `npm run demo:sync` | Refresh the GitHub Pages playground (`docs/demo/`) from index.html, app.js, style.css and `core/`. |
| `npm run demo:check` | Write nothing; fail listing the stale playground files (CI). |
| `npm run i18n:status` | Report how many README.md commits each `docs/i18n` translation is behind. Informational, never fails. |

### Rules

- Schema changes start in `core/schema.js`, then `npm run schema`. Never re-declare a schema table elsewhere.
- Every bug fix starts with a failing test named `BUG-xx` (the next free id): watch it fail, then fix.
- `test/support/slice.js` may slice only code that stays in `app.js`. Logic that moves to `core/` is tested by requiring `core/`.
- Runtime code (everything `server.js`, `mcp-server.js` and `analyze.js` reach, plus `core/`) requires only `node:` builtins and relative paths. devDependencies are for `test/` and `scripts/`.
- A patch op is a row in `core/patch.js` `OPS` + a test in `test/core/patch.test.js` + a line in CLAUDE.md's op list.
- An MCP tool is an entry in `mcp-tools.js` `TOOLS` (with a one-line `summary`) + `npm run manifest` + a bullet in CLAUDE.md "## MCP connection" + its name in README's "Tools:" line.
- A property failure reproduces with `FC_SEED` (see `npm run test:props` above). A new bug it finds gets the next BUG id and a regression test in `test/core/regressions.test.js`.
- A new spec starts from `docs/specs/TEMPLATE.md` and lands with its tests: every `AC-nnn` and quoted "Pinned by" test must exist (`test/contract/spec-ids.test.js`).

### Mutation testing

`npm run mutation` runs [Stryker](https://stryker-mutator.io/) on the files listed in `stryker.config.json` → `mutate`; that list is kept only there. Stryker makes one small change at a time, called a mutant: `<` becomes `<=`, `&&` becomes `||`, a statement is dropped, and so on. Each mutant runs `scripts/mutation-tests.js`, and a failing test kills it.

Reading the report (`reports/mutation/mutation.html`, one page per file; the clear-text summary lists the same):

- **Killed** / **Timeout**: a test failed, or the mutant hung (an endless loop). Both count as detected.
- **Survived**: every test passed with the code changed, so no test pins that behavior. The report shows each one in place, with its diff.
- **No coverage** never appears: the command runner reports no per-test coverage, so every mutant runs the whole command.
- Score = detected ÷ (detected + survived). ≥ 80 is high and ≥ 60 low; the run fails below `thresholds.break`.

A survivor is one of two things:

1. **A behavior the tests don't pin.** Add or sharpen a test in `test/core/<module>.test.js`, or a property in `test/props/`, that fails with the mutant in place. If the survivor shows the code is wrong, it is a bug: a `BUG-xx` test in `test/core/regressions.test.js` first, as always.
2. **An equivalent mutant**: no input can tell it from the original (say, a bound that is clamped again later). Mark it on the line above with the mutator and the reason: `// Stryker disable next-line EqualityOperator: equivalent — <why>`. Keep these rare. A disable comment without a reason is not accepted in review.

Re-testing: `incremental: true` keeps every verdict in `reports/stryker-incremental.json` and reuses it while the code is unchanged. The command runner can't tell Stryker which tests reach a mutant, so a new test does not reopen an old survivor. Re-test the lines you worked on with `npm run mutation -- --force --mutate core/edit.js:120-140` (verdicts outside the range are kept), or everything with `npm run mutation -- --force`. The weekly workflow restores no incremental file, so it always runs everything.

A directive covers every mutant of the named mutators on its line, so split a busy line before you disable part of it. The wrapper at the top of each core file is disabled as a block: its browser branch only runs in a vm page, where Stryker can't switch mutants on.

Verdicts are deterministic. `scripts/mutation-tests.js` fixes the fast-check seed and runs 25 cases, and it sets `FABLECUT_NO_TIMING=1` so wall-clock assertions (`test/support/timing.js`) are skipped: instrumented code on every core runs slowly, and a missed "under 5 ms" would count as a kill. The timeouts in `stryker.config.json` are generous for the same reason: with Stryker's defaults (1.5 × the dry run + 5 s), a laptop with efficiency cores timed out hundreds of mutants that were only slow, and a timeout counts as a kill.

Baseline (September 2026, before triage): 87.7% edit.js, 85.9% keyframes.js, 90.4% links.js (201 survivors). After triage every file scores 100%, stable across full runs: each survivor got a test in `test/core/` or a reasoned directive. `thresholds.break` is **95**, the score minus 5, rounded down to a multiple of 5. Raise it as the score allows; never lower it to land a change.

Next: widen `mutate` to `core/patch.js`, `core/project.js` and `core/validate.js`, one file at a time. Triage each new file's survivors the same way, then re-check `thresholds.break`, because the total score will drop while the new files are untriaged.

### Single source of truth

One source of truth is not just one file: every place that repeats it must stay in sync cheaply. When you add any list-type fact (ops, error codes, tool names, routes, config keys, versions, …), first name its source, then pick the highest sync method that works:

1. **① Derived at runtime**: no copy exists; whoever needs it computes it from the source.
2. **② Generated, with a CI staleness check**: a command writes the copy; CI fails when it is stale.
3. **③ Contract test**: the copy is written by hand; a test checks it against the source.
4. **④ Convention**: never allowed on its own.

Every drift check's failure message states the fix: the exact command to run, or the exact file and section to edit.

The registry below lists every list-type fact in the repo. `test/contract/registry.test.js` checks it: each test file and npm script it names exists, each ② command runs in CI, every `test/contract/` file and every npm script is listed here or in Scripts. Add a row with your fact.

| fact | source | copies | method | enforced by |
|---|---|---|---|---|
| Schema tables: `DEFAULT_PROPS`, `ANIMATABLE`, `PATCHABLE_PROJECT_FIELDS`, `MARKER_COLORS`, kinds, enums | `core/schema.js` `PROJECT_SCHEMA` | read by app.js, mcp-server.js, core/validate.js | ① | `test/contract/core-boundary.test.js`, `test/core/schema.test.js` |
| What core owns (every core export) | `core/*.js` exports | must not be re-declared in app.js | ① | `test/contract/core-boundary.test.js` |
| Published JSON Schema | `core/schema.js` | `schema/project.schema.json` | ② | `npm run schema -- --check`, `test/contract/generated.test.js` |
| Schema semantics | `PROJECT_SCHEMA` | core/validate.js's structural layer (vs ajv) | ③ | `test/contract/schema-ajv.test.js` |
| `DEFAULT_PROPS` / `ANIMATABLE` key order (persisted in every project.json) | `core/schema.js` | snapshot in the test | ③ | `test/core/schema.test.js` |
| Patch ops in the tool description, the unknown-op error, `TIMELINE_OPS` | `core/patch.js` `OPS` | mcp-tools.js, core/patch.js | ① | `test/contract/patch-docs.test.js` |
| Patch ops and settable project fields in the docs | `OPS`, `PATCHABLE_PROJECT_FIELDS` | CLAUDE.md "## MCP connection" + "Token-efficient editing", README's MCP paragraph | ③ | `test/contract/patch-docs.test.js` |
| Validation codes and severities | `CODES` in `core/validate.js` | CLAUDE.md "## Validation" table | ③ | `test/contract/validation-docs.test.js` |
| MCP tools served | `mcp-tools.js` `TOOLS` | tools/list | ① | `test/mcp-protocol.test.js` |
| MCPB manifest tool list | `TOOLS` (`name`, `summary`) | `manifest.json` `tools` | ② | `npm run manifest -- --check`, `test/contract/generated.test.js` |
| MCP tool names in the docs | `TOOLS` | CLAUDE.md "## MCP connection" bullets, README "Tools:" line | ③ | `test/contract/mcp-docs.test.js` |
| REST routes | server.js (`p === "/api/…"`) | CLAUDE.md "## REST API", README's REST item | ③ | `test/contract/rest-docs.test.js` |
| Props reference, enums, animatable props, transitions, eases, kinds | `PROJECT_SCHEMA`, `TRANSITIONS`, `EASE`, … | CLAUDE.md "### props reference" + jsonc schema comments | ③ | `test/contract/props-docs.test.js` |
| Encoding profile ids | `encoding-profiles.json` | CLAUDE.md examples | ③ | `test/contract/profiles-docs.test.js` |
| Playground copy of the editor | index.html, app.js, style.css, `core/` | `docs/demo/` | ② | `npm run demo:check`, `test/contract/generated.test.js` |
| Playground demo project | `DEMO` in `docs/demo/static-shim.js` | `test/fixtures/demo-reel.json` | ③ | `test/contract/demo-fixture.test.js` |
| core/ script tags and load order | `core/*.js` and their `require()`s (deps derived, ①) | index.html `<script>` tags, each module's browser guards | ③ | `test/core/dual-mode.test.js` |
| core/ module descriptions | `core/*.js` | AGENTS.md "Where the logic lives", CONTRIBUTING "Where things live", README "Project layout" | ③ | `test/contract/core-docs.test.js` |
| Runtime files (zero-dependency scan) | require closure of the entry points | — | ① | `test/contract/zero-deps.test.js` |
| Release version | `package.json` `version` | manifest.json, server.json (+ its .mcpb URL), .claude-plugin/plugin.json | ③ | `test/contract/versions.test.js` |
| MCP `serverInfo.version` | `package.json` `version` | none — mcp-server.js reads it at runtime | ① | `test/mcp-protocol.test.js` |
| Media extension → kind | `import-url.js` `KIND_BY_EXT` | none — mcp-server.js imports it | ① | `test/import-url.test.js` |
| Compact view format | `core/summary.js` | `test/core/summary.snapshot.json` | ③ | `test/core/summary.test.js` |
| README translations | `README.md` | `docs/i18n/README.*.md` (may lag: sync note + language selector checked, lag reported) | ③ | `test/contract/i18n.test.js`, `npm run i18n:status` |
| Bundle exclusions | `.gitignore` user-data blocks | `.mcpbignore` | ③ | `test/contract/ignore-files.test.js` |
| Spec ids (INV, AC, "Pinned by") | `docs/specs/*.md` | test titles | ③ | `test/contract/spec-ids.test.js` |
| Files `npm run check` checks | `git ls-files` | — | ① | `npm run check` |
| Mutation setup: the `mutate` files, the test command, report paths, `thresholds.break` | `stryker.config.json` | AGENTS.md "Mutation testing" (the break value), `.github/workflows/mutation.yml` | ③ | `test/contract/mutation-config.test.js` |
| npm scripts | `package.json` `scripts` | the Scripts table above | ③ | `test/contract/registry.test.js` |
| This registry | this table | the "enforced by" column | ③ | `test/contract/registry.test.js` |

## MCP entry point

The local MCP server is `mcp-server.js`. It can be started by any stdio-capable MCP client:

```bash
node /absolute/path/to/FableCut/mcp-server.js
```

Use the existing `CLAUDE.md` recipes and tool descriptions rather than inventing a second protocol or schema.
