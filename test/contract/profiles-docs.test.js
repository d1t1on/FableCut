/* Contract: every encoding profile id CLAUDE.md names exists in
   encoding-profiles.json (the source), so an agent that copies an example
   (`encodeProfile: "hq"`) pins a real profile (③). A profile id counts as
   named where the manual sets one (encodeProfile / profile / "default"),
   declares one (a key in the jsonc "profiles" example) or calls one shipped
   ("the shipped `a` and `b` profiles"). A deliberately made-up id belongs in
   HYPOTHETICAL below, with the line that uses it. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const MD = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
const { profiles } = JSON.parse(fs.readFileSync(path.join(ROOT, "encoding-profiles.json"), "utf8"));
const HYPOTHETICAL = new Set([]); // none today

function namedProfiles(md) {
  const ids = [];
  for (const m of md.matchAll(/\b(?:encodeProfile|profile)"?\s*:\s*"([\w-]+)"/g)) ids.push(m[1]);
  for (const m of md.matchAll(/"default"\s*:\s*"([\w-]+)"/g)) ids.push(m[1]);
  // keys of a jsonc "profiles": { "<id>": { … } } example
  for (const m of md.matchAll(/"profiles"\s*:\s*\{\s*(?:\/\/[^\n]*\s*)*"([\w-]+)"\s*:\s*\{/g)) ids.push(m[1]);
  for (const m of md.matchAll(/shipped ((?:`[\w-]+`(?:,\s*|\s+and\s+)?)+) profiles?/g))
    ids.push(...[...m[1].matchAll(/`([\w-]+)`/g)].map((x) => x[1]));
  return [...new Set(ids)];
}

test("the extractor finds settings, declarations and shipped-profile mentions", () => {
  assert.deepEqual(namedProfiles('"encodeProfile": "hq", {profile:"a"} "default": "b"\n"profiles": {\n  "c": {\nthe shipped `d` and `e` profiles'),
    ["hq", "a", "b", "c", "d", "e"]);
});

test("every encoding profile id CLAUDE.md names is defined in encoding-profiles.json", () => {
  const named = namedProfiles(MD);
  assert.ok(named.length >= 3, `found only ${named.length} profile ids in CLAUDE.md — did the wording change? Update namedProfiles() in ${path.relative(ROOT, __filename)}`);
  const unknown = named.filter((id) => !profiles[id] && !HYPOTHETICAL.has(id));
  assert.deepEqual(unknown, [],
    `CLAUDE.md names encoding profile(s) ${unknown.join(", ")} that encoding-profiles.json doesn't define ` +
    `(it has: ${Object.keys(profiles).join(", ")}): use a real id there, or add the profile to encoding-profiles.json`);
});
