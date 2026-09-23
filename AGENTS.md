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
- Run `npm run check && npm test` before opening a PR (`check` syntax-checks every JS file and parses every JSON file).
- Timeline edit behavior is pinned by `test/edit-ops.test.js`. Known bugs there are `todo: "BUG-xx"` tests: fixing one means removing its `todo`, seeing it fail, then making it pass.

## MCP entry point

The local MCP server is `mcp-server.js`. It can be started by any stdio-capable MCP client:

```bash
node /absolute/path/to/FableCut/mcp-server.js
```

Use the existing `CLAUDE.md` recipes and tool descriptions rather than inventing a second protocol or schema.
