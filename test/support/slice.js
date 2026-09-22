/* Source-slicing harness for app.js.

   app.js is a classic browser script with no exports, so tests evaluate the
   parts they need straight from the source: `slice` cuts the text between two
   unique markers, `lift` evaluates a literal (a constant table) in place, and
   `evalBlocks` stitches slices into one sandboxed function body so the sliced
   functions close over the same stubbed globals (`project`, `state`, …).

   Every lookup fails loudly with the marker that went missing — a rename in
   app.js must break the harness, never silently produce an empty slice.
   Policy: only slice code that still lives in app.js. Once a block moves to
   core/, require it instead. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP_JS = path.join(__dirname, "..", "..", "app.js");
let cachedSource = null;
const appSource = () => (cachedSource ??= fs.readFileSync(APP_JS, "utf8"));

/* Text from `startMarker` up to (not including) the next `endMarker`. The start
   marker must be unique, or a later edit could silently shift the slice. */
function slice(startMarker, endMarker, src = appSource()) {
  const a = src.indexOf(startMarker);
  assert.ok(a >= 0, `app.js slice: start marker not found: ${startMarker}`);
  assert.equal(src.indexOf(startMarker, a + 1), -1,
    `app.js slice: start marker is not unique: ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.ok(b > a, `app.js slice: end marker not found after start: ${endMarker}`);
  return src.slice(a, b);
}

/* Evaluate the literal captured by group 1 of `re` (e.g. a constant table). */
function lift(re, src = appSource()) {
  const m = re.exec(src);
  assert.ok(m, `app.js lift: literal not found: ${re}`);
  return new Function(`"use strict"; return (${m[1]});`)();
}

/* Evaluate slices as one strict function body.
   blocks  — [startMarker, endMarker] pairs, or raw source strings
   stubs   — { name: value } injected as parameters (the slices' free variables)
   exports — object-literal body returned to the caller, e.g. "splitAtPlayhead, x: () => TRACKS"
   A stub must not share a name with a declaration inside the slices. */
function evalBlocks({ blocks, stubs = {}, exports }) {
  const body = blocks
    .map((b) => (typeof b === "string" ? b : slice(b[0], b[1])))
    .join("\n");
  const names = Object.keys(stubs);
  const fn = new Function(...names, `"use strict";\n${body}\nreturn { ${exports} };`);
  return fn(...names.map((n) => stubs[n]));
}

module.exports = { APP_JS, appSource, slice, lift, evalBlocks };
