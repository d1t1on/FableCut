/* The fixture is the byte-identical Anton shipped in 1.9 (OFL; LICENSES.md).
   Only this old subset may be replaced in a persistent user data directory. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeDataDir, ROOT } = require("./helpers");

test("BUG-34: seeding replaces an unchanged old shipped font and preserves customized files", (t) => {
  const dir = makeDataDir(t);
  const fonts = path.join(dir, "library", "fonts");
  fs.mkdirSync(fonts, { recursive: true });
  const anton = path.join(fonts, "Anton.woff2");
  fs.copyFileSync(path.join(__dirname, "fixtures", "anton-v1.9.woff2"), anton);
  const custom = path.join(fonts, "Inter.woff2");
  fs.writeFileSync(custom, "user customized face");
  const seed = () => {
    const r = spawnSync(process.execPath, ["-e", 'require("./paths").ensureDirs()'], {
      cwd: ROOT, env: { ...process.env, FABLECUT_DATA_DIR: dir }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  seed();
  assert.deepEqual(fs.readFileSync(anton), fs.readFileSync(path.join(ROOT, "library", "fonts", "Anton.woff2")));
  assert.equal(fs.readFileSync(custom, "utf8"), "user customized face");
  seed();
  assert.equal(fs.readFileSync(custom, "utf8"), "user customized face");
});
