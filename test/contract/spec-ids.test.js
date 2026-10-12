/* Contract: the specs and the tests point at each other (③). A spec names
   what must hold (INV-…, AC-nnn) and which tests pin a decision ("Pinned
   by"); this checks every such reference resolves to a test title, so a spec
   can't claim coverage that isn't there. Titles come from test/support/
   titles.js: what node:test would register, computed titles included.
   - every INV id in docs/specs/invariants.md leads some test title;
   - every INV id another spec cites is one invariants.md defines;
   - every AC-nnn in docs/specs/*.md (not TEMPLATE.md) is in some test title;
   - every quoted test name under "**Pinned by.**" in a spec (0001 today) is a
     test title ("…" in a quote stands for elided text).
   So a spec lands in the same change as the tests it names. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { testTitles } = require("../support/titles");

const ROOT = path.join(__dirname, "..", "..");
const SPECS = path.join(ROOT, "docs", "specs");
const read = (f) => fs.readFileSync(path.join(SPECS, f), "utf8");
const SPEC_FILES = fs.readdirSync(SPECS).filter((f) => f.endsWith(".md") && f !== "TEMPLATE.md").sort();
const squash = (s) => s.replace(/\s+/g, " ").trim();

let cache;
const titles = () => (cache ??= testTitles().titles.map((t) => ({ ...t, title: squash(t.title) })));

/* "INV-04" also counts as covered by "INV-04a: …" (the family), "INV-04a" only by itself. */
const idRe = (id) => new RegExp(`(^|[^\\w-])${id}${/\d$/.test(id) ? "[a-z]?" : ""}(?![\\w-])`);
/* "INV-09a/b/c" → INV-09a, INV-09b, INV-09c */
const invIds = (text) => [...new Set([...text.matchAll(/\bINV-(\d+)([a-z](?:\/[a-z])*)?/g)]
  .flatMap(([, n, sfx]) => (sfx ? sfx.split("/").map((l) => `INV-${n}${l}`) : [`INV-${n}`])))];
/* A quoted name matches a title that holds each "…"-separated fragment, in order. */
function matches(quote, title) {
  let at = 0;
  for (const frag of quote.split("…").map((s) => s.trim()).filter(Boolean)) {
    const i = title.indexOf(frag, at);
    if (i < 0) return false;
    at = i + frag.length;
  }
  return true;
}
function pinnedQuotes(md) {
  const out = [];
  for (const m of md.matchAll(/\*\*Pinned by\.\*\*([\s\S]*?)(?=\n## |\n\*\*|$)/g))
    for (const q of squash(m[1]).matchAll(/"([^"]+)"/g)) out.push(q[1]);
  return out;
}

test("the checkers: id families, slash lists, elided quotes, Pinned-by blocks", () => {
  assert.deepEqual(invIds("INV-09a/b/c, INV-15 and INV-01b"), ["INV-09a", "INV-09b", "INV-09c", "INV-15", "INV-01b"]);
  assert.ok(idRe("INV-04").test("INV-04a: x") && idRe("INV-04a").test("INV-04a: x"));
  assert.ok(!idRe("INV-04a").test("INV-04b: x") && !idRe("INV-1").test("INV-15a: x") && !idRe("AC-001").test("AC-0012"));
  assert.ok(matches("shiftKF: … one anchor per side (D4)", "shiftKF: keeps one anchor per side (D4)"));
  assert.ok(!matches("b … a", "a then b"));
  assert.deepEqual(pinnedQuotes('**Pinned by.** `x` "A: one,\n two" and "B …".\n\n**Decision.** "C"\n## D6\n**Pinned by.**\n\n- "E"'),
    ["A: one, two", "B …", "E"]);
});

test("every invariant in docs/specs/invariants.md leads a test title", () => {
  const ids = invIds(read("invariants.md"));
  assert.ok(ids.length >= 40, `found only ${ids.length} INV ids in docs/specs/invariants.md — did the id format change? Update invIds() in ${path.relative(ROOT, __filename)}`);
  const missing = ids.filter((id) => !titles().some((t) => idRe(id).test(t.title)));
  assert.deepEqual(missing, [],
    `no test title names ${missing.join(", ")}: start the title of the property that checks each with its id ` +
    '(propTest("INV-xx: …") in test/props/), or remove the row from docs/specs/invariants.md');
});

test("every INV id a spec cites is defined in docs/specs/invariants.md", () => {
  const defined = invIds(read("invariants.md"));
  const known = (id) => defined.some((d) => d === id || (/\d$/.test(id) && d.startsWith(id) && /^[a-z]$/.test(d.slice(id.length))));
  const bad = SPEC_FILES.filter((f) => f !== "invariants.md")
    .flatMap((f) => invIds(read(f)).filter((id) => !known(id)).map((id) => `${id} (docs/specs/${f})`));
  assert.deepEqual(bad, [], `unknown invariant id(s) ${bad.join(", ")}: fix the id, or add its row to docs/specs/invariants.md`);
});

test("every acceptance criterion (AC-nnn) in docs/specs/ is in a test title", () => {
  const missing = SPEC_FILES.flatMap((f) => [...new Set([...read(f).matchAll(/\bAC-\d{3}\b/g)].map((m) => m[0]))]
    .filter((id) => !titles().some((t) => idRe(id).test(t.title))).map((id) => `${id} (docs/specs/${f})`));
  assert.deepEqual(missing, [],
    `no test title names ${missing.join(", ")}: add a test whose title starts with the id ("AC-nnn: given …, when …, then …"), ` +
    "or drop the criterion from the spec");
});

test("every quoted test under 'Pinned by' in docs/specs/ exists", () => {
  const quotes = SPEC_FILES.flatMap((f) => pinnedQuotes(read(f)).map((q) => ({ f, q })));
  assert.ok(quotes.length >= 15, `found only ${quotes.length} quoted test names under "**Pinned by.**" — did the format change? Update pinnedQuotes()`);
  // a nested "…" splits one name into scraps that start or end with a space
  const scraps = quotes.filter(({ q }) => /^\s|\s$/.test(q));
  const show = (list) => list.map(({ f, q }) => `docs/specs/${f}: ${JSON.stringify(q)}`);
  assert.deepEqual(show(scraps), [],
    `"Pinned by" quotes that look cut by a nested " — write the inner part as … instead:\n  ${show(scraps).join("\n  ")}`);
  const missing = quotes.filter(({ q }) => !titles().some((t) => matches(q, t.title)));
  assert.deepEqual(show(missing), [], `"Pinned by" quotes test(s) that no longer exist:\n  ${show(missing).join("\n  ")}\n` +
    'Quote each title as the test spells it ("…" may elide a part), or fix the test title if it was renamed by mistake.');
});
