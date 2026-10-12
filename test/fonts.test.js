"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evalBlocks } = require("./support/slice");

function fonts({ files = [], clips = [], buf = new ArrayBuffer(64), linkError = false } = {}) {
  const faces = new Set(), links = [], loads = [], descriptors = [];
  const runtime = { customFonts: [], googleLoaded: new Set(), libraryFontReq: new Set(), fontReq: new Map() };
  const document = {
    fonts: Object.assign(faces, { check: () => true, ready: Promise.resolve(), load: async (spec) => { loads.push(spec); } }),
    createElement: (tag) => tag === "canvas" ? { getContext: () => ({ measureText: () => ({ width: 10 }) }) } : { remove() {} },
    head: { appendChild: (link) => { links.push(link); queueMicrotask(() => linkError ? link.onerror?.() : link.onload?.()); } },
  };
  class FontFace {
    constructor(family, _buf, desc) { this.family = family; descriptors.push(desc); }
    async load() { return this; }
  }
  const api = evalBlocks({
    blocks: [["/* Custom fonts:", "/* ── Main loop ── */"]],
    stubs: { runtime, document, FontFace, SYSTEM_FONTS: ["Segoe UI"], FONT_CUT_DEFAULT: ["Anton"],
      project: { clips }, textFontWeight: (p) => p.weight || 700,
      fetch: async () => ({ json: async () => files, arrayBuffer: async () => buf }) },
    exports: "ensureFont, loadLibraryFonts, loadProjectFonts: typeof loadProjectFonts === 'function' ? loadProjectFonts : null",
  });
  return { ...api, runtime, links, loads, descriptors, document };
}

test("BUG-34: an unregistered Google font loads even when FontFaceSet.check says true", async () => {
  const f = fonts();
  await f.ensureFont("Cinzel");
  assert.equal(f.links.length, 1);
  assert.match(f.links[0].href, /family=Cinzel/);
  await f.ensureFont("Cinzel");
  assert.equal(f.links.length, 1, "one request per family");
});

test("library variable faces support the whole weight axis in sfnt, WOFF and WOFF2", async () => {
  for (const type of ["sfnt", "woff", "woff2"]) {
    const buf = new ArrayBuffer(64), v = new DataView(buf);
    v.setUint32(0, type === "woff2" ? 0x774f4632 : type === "woff" ? 0x774f4646 : 0x00010000);
    v.setUint16(type === "sfnt" ? 4 : 12, 1);
    if (type === "woff2") v.setUint8(48, 47);
    else v.setUint32(type === "sfnt" ? 12 : 44, 0x66766172);
    const f = fonts({ buf, files: [{ name: "Variable.woff2", src: "/face" }] });
    await f.loadLibraryFonts();
    assert.deepEqual(f.descriptors, [{ weight: "1 1000" }], type);
  }
});

test("a Google stylesheet failure is reported and is not registered as loaded", async () => {
  const f = fonts({ linkError: true });
  assert.equal(await f.ensureFont("Missing Face"), false);
  assert.equal(f.runtime.googleLoaded.has("Missing Face"), false);
});

test("export font wait is bounded even when FontFaceSet.ready never resolves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fonts();
  f.document.fonts.ready = new Promise(() => {});
  const pending = f.loadProjectFonts();
  t.mock.timers.tick(8000);
  await pending;
});

test("BUG-34: overlapping library refreshes register each family only once", async () => {
  const f = fonts({ files: [{ name: "Anton.woff2", src: "/library/fonts/Anton.woff2" }] });
  await Promise.all([f.loadLibraryFonts(), f.loadLibraryFonts()]);
  assert.deepEqual(f.runtime.customFonts, ["Anton"]);
  assert.equal(f.descriptors.length, 1);
});

test("BUG-34: export preloads the selected face and every font-cut family", async () => {
  const f = fonts({ clips: [{ kind: "text", props: { font: "Cinzel", weight: 900, italic: true,
    textAnim: "font-cut", fontCutSet: ["Anton", "Caveat"] } }] });
  assert.equal(typeof f.loadProjectFonts, "function");
  await f.loadProjectFonts();
  for (const name of ["Cinzel", "Anton", "Caveat"])
    assert.ok(f.loads.includes(`italic 900 64px "${name}"`), name);
});
