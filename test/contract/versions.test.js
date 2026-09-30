/* Contract: package.json's version is the release version; every other place
   that states it repeats it by hand, and this checks they agree (③).

   Why a check and not a generator: server.json pins the release's .mcpb
   download URL and its fileSha256, which only exist once the bundle is built.
   A version bump is a deliberate release step; the failure names each file
   and the exact value. mcp-server.js's serverInfo reads package.json at
   runtime (①), so it has no copy to check here — test/mcp-protocol.test.js
   asserts the initialize reply carries package.json's version. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const json = (f) => JSON.parse(read(f));

test("every stated version equals package.json's", () => {
  const v = json("package.json").version;
  assert.match(v, /^\d+\.\d+\.\d+(-[\w.]+)?$/, "package.json version is not semver");
  const server = json("server.json");
  const places = [
    ["manifest.json → version", json("manifest.json").version, v],
    [".claude-plugin/plugin.json → version", json(".claude-plugin/plugin.json").version, v],
    ["server.json → version", server.version, v],
    // the MCP registry installs this URL; a new version needs its release asset
    ["server.json → packages[0].identifier", server.packages?.[0]?.identifier,
      `${server.repository?.url}/releases/download/v${v}/fablecut.mcpb`],
  ];
  const stale = places.filter(([, have, want]) => have !== want)
    .map(([where, have, want]) => `${where} is ${JSON.stringify(have)}; set it to ${JSON.stringify(want)}`);
  assert.deepEqual(stale, [], `version drift from package.json (${v}):\n  ${stale.join("\n  ")}\n` +
    "(server.json's fileSha256 must then be the new .mcpb's SHA-256 — set it when the release asset is built)");
});
