/* Contract: CLAUDE.md's props reference and enum lines match core/schema.js.
   PROJECT_SCHEMA is the source (DEFAULT_PROPS, ANIMATABLE and the enums are
   derived from it, ①); CLAUDE.md restates them for agents by hand, so this
   checks every restatement (③):
   - every props-schema key has a row in a "| prop | default | notes |" table
     of '### props reference', with its default ("—" or "(…)" when the schema
     has none), and no row names a prop the schema lacks;
   - an enum prop's row lists exactly its values (the default cell counts);
   - the "Animatable props" line is ANIMATABLE, the "Transition types" line
     covers TRANSITIONS, and the jsonc schema's ease / kind comments list
     EASE, CLIP_KINDS and MEDIA_KINDS. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PROJECT_SCHEMA, DEFAULT_PROPS, ANIMATABLE, TRANSITIONS, EASE, CLIP_KINDS, MEDIA_KINDS } = require("../../core/schema");

const MD = fs.readFileSync(path.join(__dirname, "..", "..", "CLAUDE.md"), "utf8");
const PROPS = PROJECT_SCHEMA.$defs.props.properties;
const SECTION = (MD.split(/^(?=### )/m).find((s) => s.startsWith("### props reference")) || "");
const WHERE = "CLAUDE.md → '## project.json schema' → '### props reference'";
const NONE = Symbol("no default");

/* "true" → true, "\"#000\"" → "#000", "—" / "(curated)" → NONE */
function value(cell) {
  const s = cell.trim();
  if (s === "—" || /^\(.*\)$/.test(s)) return NONE;
  try { return JSON.parse(s); } catch { return `unparsed: ${s}`; }
}
/* One entry per prop named in a "| prop | default | notes |" row. */
function propRows(text) {
  const rows = [];
  for (const table of text.split(/\n(?=\| prop \| default \|)/).filter((t) => t.startsWith("| prop | default |"))) {
    for (const line of table.split("\n").slice(2)) {
      if (!line.startsWith("|")) break;
      const [, names, dflt, ...notes] = line.split("|");
      const keys = [...names.matchAll(/`(\w+)`/g)].map((m) => m[1]);
      // "`bold` / `weight` | true / 0" and "`strokeWidth` `strokeColor` | 0, \"#000000\"" are positional
      const parts = [" / ", ", "].map((sep) => dflt.split(sep)).find((p) => p.length === keys.length && keys.length > 1);
      keys.forEach((key, i) => rows.push({ key, dflt: value(parts ? parts[i] : dflt), notes: notes.join("|"), line }));
    }
  }
  return rows;
}
/* "contain · cover (fill canvas) · **justify** (…)" → ["contain", "cover", "justify"] */
const listed = (notes) => (notes.includes(" · ")
  ? notes.replace(/^\s*one of:/, "").split(" · ").map((p) => (p.replace(/^[\s*`"]+/, "").match(/^[a-z][\w-]*/i) || [""])[0]).filter(Boolean)
  : []);
const sorted = (a) => [...new Set(a)].sort();

test("the table parser reads grouped rows and placeholders", () => {
  const rows = propRows('| prop | default | notes |\n|---|---|---|\n| `a` / `b` | true / 0 | x |\n| `c` `d` | 0, "#000000" | y |\n| `e`, `f` | "" | a · b |\n| `g` | — | |\n');
  assert.deepEqual(rows.map((r) => [r.key, r.dflt]), [["a", true], ["b", 0], ["c", 0], ["d", "#000000"], ["e", ""], ["f", ""], ["g", NONE]]);
  assert.deepEqual(listed("one of: x · y-z (note) · **w** — more. Tail"), ["x", "y-z", "w"]);
});

test("every prop in the schema has a props-reference row with its default", () => {
  assert.ok(SECTION, `${WHERE} is gone — restore it, or point this test at the props tables`);
  const rows = propRows(SECTION);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const problems = [];
  for (const [k, s] of Object.entries(PROPS)) {
    const r = byKey.get(k);
    const want = "default" in s ? s.default : NONE;
    if (!r) problems.push(`add a row for \`${k}\` (default ${want === NONE ? "—" : JSON.stringify(want)})`);
    else if (r.dflt !== want) problems.push(`\`${k}\`: default cell should be ${want === NONE ? "— (no default)" : JSON.stringify(want)}, not ${r.dflt === NONE ? "a placeholder" : JSON.stringify(r.dflt)}`);
  }
  for (const r of rows) if (!PROPS[r.key]) problems.push(`\`${r.key}\` is not a prop in core/schema.js PROPS — remove its row, or add it to the schema`);
  assert.deepEqual(problems, [], `${WHERE} drifted from core/schema.js:\n  ${problems.join("\n  ")}`);
});

test("an enum prop's row lists exactly its values", () => {
  const byKey = new Map(propRows(SECTION).map((r) => [r.key, r]));
  const problems = [];
  for (const [k, s] of Object.entries(PROPS)) {
    if (!s.enum || !byKey.has(k)) continue; // a missing row is the test above
    const r = byKey.get(k);
    const have = sorted([...listed(r.notes), r.dflt]);
    const missing = s.enum.filter((v) => !have.includes(v)), extra = have.filter((v) => !s.enum.includes(v));
    if (missing.length || extra.length)
      problems.push(`\`${k}\` row: ${missing.length ? `add ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `remove ${extra.join(", ")}` : ""}` +
        " (values separated by \" · \" in the notes cell, the default in the default cell)");
  }
  assert.deepEqual(problems, [], `${WHERE} enum rows drifted from core/schema.js:\n  ${problems.join("\n  ")}`);
});

/* The paragraph after a bold label: "**Label** …: body" up to a blank line. */
function para(label) {
  const at = SECTION.indexOf(`**${label}**`);
  assert.ok(at >= 0, `${WHERE} lost its **${label}** line — restore it`);
  return SECTION.slice(at).split(/\n\s*\n/)[0].replace(/\s+/g, " ");
}

test("the Animatable props line is ANIMATABLE", () => {
  const names = para("Animatable props").split("):")[1].replace(/\.\s*$/, "").split(",").map((s) => s.trim());
  assert.deepEqual(names, ANIMATABLE,
    `${WHERE} → **Animatable props**: make the list read (the x-animatable props, in core/schema.js order):\n${ANIMATABLE.join(", ")}.`);
});

test("the Transition types line names every transition", () => {
  const enumAll = PROJECT_SCHEMA.$defs.transition.properties.type.enum;
  const aliases = enumAll.filter((t) => !TRANSITIONS.includes(t));
  // "slide-left/right/up/down" → slide-left, slide-right, …; "wipe (=wipe-left)" → wipe (the alias may be named)
  const names = para("Transition types").split("**:")[1].split(" · ").flatMap((p) => {
    const [head, ...alts] = (p.trim().match(/^[a-z][\w-]*(?:\/[a-z]+)*/) || [""])[0].split("/");
    return [head, ...alts.map((a) => head.replace(/-[a-z]+$/, "-") + a)];
  }).filter(Boolean);
  // "none" is no transition (validation flags {type:"none"} as a placeholder), so it isn't listed
  const missing = TRANSITIONS.filter((t) => t !== "none" && !names.includes(t));
  const unknown = names.filter((n) => !enumAll.includes(n));
  assert.deepEqual(missing, [], `${WHERE} → **Transition types**: add ${missing.join(", ")} (core/schema.js TRANSITIONS)`);
  assert.deepEqual(unknown, [], `${WHERE} → **Transition types**: ${unknown.join(", ")} is not in TRANSITIONS (aliases allowed: ${aliases.join(", ")}) — remove or rename it`);
});

test("the jsonc schema's ease and kind comments list EASE, CLIP_KINDS and MEDIA_KINDS", () => {
  const schemaSection = MD.split(/^(?=## )/m).find((s) => s.startsWith("## project.json schema")) || "";
  const commentAfter = (re) => {
    const m = schemaSection.match(re);
    assert.ok(m, `CLAUDE.md → '## project.json schema': the jsonc comment matching ${re} is gone — restore it`);
    return m[1].split("|").map((s) => s.trim());
  };
  const where = "CLAUDE.md → '## project.json schema' (the jsonc block)";
  const ease = commentAfter(/"ease" sits on the DESTINATION[^\n]*\n\s*\/\/ ([\w| -]+?) \(default/);
  assert.deepEqual(sorted(ease), sorted(Object.keys(EASE)), `${where}: the ease comment should read // ${Object.keys(EASE).join(" | ")} (core/schema.js EASE)`);
  const dflt = (schemaSection.match(/\(default ([\w-]+)\)\./) || [])[1];
  assert.equal(dflt, PROJECT_SCHEMA.$defs.keyframe.properties.ease.default, `${where}: the ease comment's "(default …)" should name the keyframe ease default`);
  assert.deepEqual(commentAfter(/"kind": "video",\s+\/\/ ([\w| ]+)\n\s+"track"/), CLIP_KINDS,
    `${where}: the clip "kind" comment should read // ${CLIP_KINDS.join(" | ")} (core/schema.js clip kind enum)`);
  assert.deepEqual(commentAfter(/"media": \[\s*\{[^\n]*"kind": "video",\s+\/\/ ([\w|]+)/), MEDIA_KINDS,
    `${where}: the media "kind" comment should read // ${MEDIA_KINDS.join("|")} (core/schema.js media kind enum)`);
});
