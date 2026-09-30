# NNNN: Title

<!-- Copy to docs/specs/NNNN-short-name.md (next free number). Keep every
     section; write "none" where a section doesn't apply. The ids below are
     machine-checked by test/contract/spec-ids.test.js:
     - every AC-nnn here must appear in a test title;
     - every INV id you cite must be a row in invariants.md;
     - every quoted test name under "**Pinned by.**" must exist.
     So a spec lands in the same change as its tests. AC numbers are global:
     continue from the highest AC-nnn in docs/specs/. This file itself is
     skipped by those checks. -->

**Status:** Draft | Accepted | Implemented (which step).
**Invariants:** [invariants.md](invariants.md).

## Context

What exists today, what is wrong or missing, and who is affected (the UI, an
agent over MCP, a REST script). Link the bug ids (BUG-nn) or issues.

## Decisions

### D1: <one-line rule>

**Decision.** The rule, stated so a test can check it.

**Why.** The alternative you rejected and what it would break.

**Pinned by.** The tests, quoted exactly as titled (`"…"` may elide a part):
"AC-nnn: given …, when …, then …".

<!-- D2, D3, … -->

## Invariants touched

The INV ids this change must keep (or adds — add each new row to
invariants.md with its property test in test/props/, the id leading the
title). Say which op families they now cover.

## Acceptance

One criterion per behavior, numbered AC-nnn, each the title of one test:

- **AC-nnn** — Given <a project / state>, when <the edit or call>, then
  <what the document, the response or the UI shows>.

## Schema diff

Changes to `core/schema.js` (props, enums, fields, `x-severity`), then
`npm run schema`. New validation codes: a row in `CODES` (core/validate.js)
and in CLAUDE.md's "Validation" table. "None" if the schema is unchanged.

## MCP/REST surface

New or changed tools (`mcp-tools.js` TOOLS, then `npm run manifest`), patch
ops (a row in `core/patch.js` OPS), REST routes (server.js) and their errors.

## Docs to update

CLAUDE.md sections, README.md, AGENTS.md, skills/, CHANGELOG "Unreleased".
The contract tests in test/contract/ name the sections they check.

## Tests

The tests to add, by title, and the files they go in
(`test/core/…`, `test/props/…`, `test/contract/…`).
