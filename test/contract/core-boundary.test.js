/* Contract: what core/ owns is not re-declared in app.js.

   The timeline core (schema tables, keyframe/compositor math, links, edit
   ops, load/save normalization, undo history) lives in core/*.js. app.js
   destructures what it needs from FableCore and may keep an old global name
   only as a thin wrapper that DELEGATES to core (the demo shim and old call
   sites use the global names). A copy that drifts from core is exactly the
   bug class this guards against. A static scan of app.js — it runs nothing. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

/* Tables core owns: app.js may destructure them, never declare a literal. */
const CORE_CONSTANTS = [
  "PROJECT_SCHEMA", "DEFAULT_PROPS", "ANIMATABLE", "TRANSITIONS", "TEXT_ANIMS", "BLEND_MODES", "FILTER_PRESETS",
  "EASE", "MIN_DUR", "SPEED_MIN", "SPEED_MAX", "DEFAULT_TRACK_DEFS", "TIMELINE_START_TIME",
];
/* Logic core owns: absent from app.js, or a one-statement delegating wrapper. */
const CORE_FUNCTIONS = [
  "kfChannel", "mediaTimeAt", "shiftKF", "clipSpeed", "hasSpeedRamp",
  "evalProps", "transOffsetAt", "applyTransition", "applyFilterPreset",
  "linkedClip", "withLinked", "syncLinkedTiming", "relinkClips", "relinkSplitRights",
  "splitClipAt", "trimClipTo", "planCloseGap", "removeClips",
  "normalizeWorkArea", "normalizeFolders", "normalizeMediaEntry", "evenFloor", "normalizeExportFrame",
  "normalizeDisabledTracks", "normalizeTrackDefs", "ensureLanesCoverClips",
  "normalizeProject", "serializeProject", "createHistory",
  "compactClipLine", "compactProject", "diffProjects", "patchProject", "describeOps",
];

/* `const { a, b: c } = FableCore.ns;` → [{ ns, key: "b", local: "c" }, …] */
function coreImports(src) {
  const out = [];
  for (const m of src.matchAll(/^const\s*\{([^}]*)\}\s*=\s*FableCore\.(\w+)\s*;/gm)) {
    for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [key, local = key] = part.split(":").map((s) => s.trim());
      out.push({ ns: m[2], key, local });
    }
  }
  return out;
}
const declRe = (name) => new RegExp(
  `^[ \\t]*(?:(?:async[ \\t]+)?function\\*?[ \\t]+${name}[ \\t]*\\(|(?:const|let|var|class)[ \\t]+${name}\\b(?![ \\t]*[,}:]))`, "m");
/* A plain `const/let/var NAME` (or `function NAME(` / `class NAME`) declaration. */
const declares = (src, name) => declRe(name).test(src);

/* Body text of `function NAME(…) { … }`, or null when there is none. */
function functionBody(src, name) {
  const m = new RegExp(`^[ \\t]*(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`, "m").exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  for (; depth && i < src.length; i++) depth += src[i] === "(" ? 1 : src[i] === ")" ? -1 : 0;
  const open = src.indexOf("{", i);
  let j = open + 1;
  for (depth = 1; depth && j < src.length; j++) depth += src[j] === "{" ? 1 : src[j] === "}" ? -1 : 0;
  return src.slice(open + 1, j - 1).trim();
}
/* One statement, no control flow, calling <x>Core.NAME( or FableCore.<ns>.NAME( */
function delegates(body, name) {
  const code = body.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  return code.length <= 200
    && !/\b(for|while|if|switch|function)\b|=>/.test(code)
    && (code.match(/;/g) || []).length <= 1
    && new RegExp(`\\b(?:\\w+Core|FableCore\\.\\w+)\\.${name}\\(`).test(code);
}

test("the checker itself: flags re-declarations and bodies, accepts delegating wrappers", () => {
  assert.ok(declares("const EASE = {};", "EASE"));
  assert.ok(declares("  let MIN_DUR=0.05;", "MIN_DUR"));
  assert.ok(!declares("const { EASE, MIN_DUR } = FableCore.schema;", "EASE"));
  assert.ok(!declares("const EASE_OUT = 1;", "EASE"));
  assert.ok(declares("async function withLinked(list) {}", "withLinked"));
  const wrap = "function evalProps(c, t) { return composeCore.evalProps(c, t, W, H); }";
  assert.ok(delegates(functionBody(wrap, "evalProps"), "evalProps"));
  const copy = "function kfChannel(c, k, t, f) {\n  const kfs = c.keyframes?.[k];\n  for (let i = 0; i < kfs.length; i++) {}\n  return f;\n}";
  assert.ok(!delegates(functionBody(copy, "kfChannel"), "kfChannel"));
  assert.ok(!delegates("return other.kfChannel(c);", "kfChannel"), "must call into core");
  assert.equal(functionBody("function x(a, { b = 1 } = {}) { return y; }", "x"), "return y;");
  assert.deepEqual(coreImports("const { a, b: c } = FableCore.links;\nconst d = FableCore.edit;"),
    [{ ns: "links", key: "a", local: "a" }, { ns: "links", key: "b", local: "c" }]);
});

test("every name app.js destructures from FableCore exists in core and is not declared again", () => {
  const imports = coreImports(APP);
  assert.ok(imports.length >= 20, `found only ${imports.length} FableCore imports — did the pattern change?`);
  for (const { ns, key, local } of imports) {
    const mod = require(path.join(ROOT, "core", ns + ".js"));
    assert.ok(Object.hasOwn(mod, key), `app.js imports ${key} from FableCore.${ns}, which does not export it`);
    assert.ok(!declares(APP, local), `app.js re-declares ${local}, which it already takes from FableCore.${ns}`);
  }
});

test("core-owned tables are not declared in app.js", () => {
  for (const name of CORE_CONSTANTS) assert.ok(!declares(APP, name), `app.js declares ${name}; it belongs in core/`);
});

test("core-owned functions are absent from app.js or only delegate to core", () => {
  for (const name of CORE_FUNCTIONS) {
    assert.ok(!new RegExp(`^[ \\t]*(?:const|let|var)[ \\t]+${name}[ \\t]*=`, "m").test(APP),
      `app.js defines ${name} as a value; take it from FableCore instead`);
    const body = functionBody(APP, name);
    if (body == null) continue;
    assert.ok(delegates(body, name), `app.js function ${name} has a body of its own — delegate to core:\n${body}`);
  }
});

test("app.js has one undo history, from core/history.js", () => {
  assert.equal((APP.match(/\bcreateHistory\(/g) || []).length, 1, "exactly one createHistory() call");
  assert.ok(!/\bruntime\.(undo|redo)\b/.test(APP), "no hand-rolled undo/redo stacks on runtime");
  assert.ok(!/^\s*undo:\s*\[\]/m.test(APP), "no undo array in the runtime literal");
});
