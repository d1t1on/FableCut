/* Contract: the translations in docs/i18n/ stay findable and their lag stays
   measurable. README.md is the source; translations may lag (CONTRIBUTING →
   Translations), so this never compares content — `npm run i18n:status`
   reports how far behind each one is. What it checks (③):
   - each translation ends with a well-formed sync note naming the README.md
     commit it tracks (the note i18n-status reads);
   - the language selector line in README.md and in every translation links
     every language (the files in docs/i18n/ are the source of that list). */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { SYNC_NOTE } = require("../../scripts/i18n-status.js");

const ROOT = path.join(__dirname, "..", "..");
const DIR = path.join(ROOT, "docs", "i18n");
const FILES = fs.readdirSync(DIR).filter((f) => /^README\..+\.md$/.test(f)).sort();
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");

test("every translation ends with a sync note naming the README.md commit it tracks", () => {
  assert.ok(FILES.length >= 1, "no docs/i18n/README.*.md found");
  const bad = FILES.filter((f) => {
    const m = read(f).match(SYNC_NOTE);
    return !m || !m[0].includes('<a href="../../README.md">');
  });
  assert.deepEqual(bad, [],
    `docs/i18n/${bad.join(", ")}: end the file with the sync note — ` +
    '<sub>… <a href="../../README.md">README.md</a> … <code>SHORT_SHA</code> …</sub> — ' +
    "naming the README.md commit it was translated from (copy the shape from another translation; see CONTRIBUTING → Translations)");
});

test("the language selector in README.md and in every translation links every language", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const selector = (text) => text.split("\n").find((l) => / · /.test(l) && /README\.[\w-]+\.md\)/.test(l)) || "";
  const problems = [];
  const top = selector(readme);
  for (const f of FILES) if (!top.includes(`(docs/i18n/${f})`)) problems.push(`README.md: add [<language>](docs/i18n/${f})`);
  for (const f of FILES) {
    const line = selector(read(f));
    if (!line.includes("(../../README.md)")) problems.push(`docs/i18n/${f}: add [English](../../README.md)`);
    for (const g of FILES) if (g !== f && !line.includes(`(${g})`)) problems.push(`docs/i18n/${f}: add [<language>](${g})`);
  }
  assert.deepEqual(problems, [],
    `the language selector line (line ~25, "English · 简体中文 · …") is missing links — ${problems.join("; ")}`);
});
