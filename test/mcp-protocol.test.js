/* MCP wire protocol: the handshake and JSON-RPC framing every client depends on.
   Regression cover for #58 / #59 — an initialize that echoed a version the
   server does not speak, and handshake edge cases that must not kill the
   process. Each case also proves the server is still alive afterwards, because
   "answered once, then died" is exactly the failure that was reported. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, makeDataDir, startMcp } = require("./helpers");
const { TOOLS } = require("../mcp-tools.js");

const SUPPORTED = ["2025-11-25", "2025-06-18", "2024-11-05"];
const LATEST = "2025-11-25";

async function stillAlive(mcp) {
  const pong = await mcp.request("ping", {});
  assert.deepEqual(pong.result, {}, "server should answer ping after the handshake");
}

test("initialize echoes each protocol version the server actually speaks", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  for (const version of SUPPORTED) {
    const res = await mcp.request("initialize", { protocolVersion: version, capabilities: {} });
    assert.equal(res.result.protocolVersion, version, `should echo supported ${version}`);
  }
  await stillAlive(mcp);
});

test("initialize downgrades an unsupported version instead of echoing it", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  for (const bogus of ["2099-01-01", "not-a-version", "2024-01-01", ""]) {
    const res = await mcp.request("initialize", { protocolVersion: bogus, capabilities: {} });
    assert.notEqual(res.result.protocolVersion, bogus,
      `must not claim to speak ${JSON.stringify(bogus)}`);
    assert.equal(res.result.protocolVersion, LATEST);
  }
  await stillAlive(mcp);
});

test("initialize without a version is served on the default and does not kill the server", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  for (const params of [undefined, {}, { capabilities: {} }]) {
    const res = await mcp.request("initialize", params);
    assert.equal(res.result.protocolVersion, LATEST);
  }
  await stillAlive(mcp);
});

test("initialize result carries the capabilities and serverInfo clients read", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  const { result } = await mcp.request("initialize", { protocolVersion: LATEST });
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.serverInfo.name, "fablecut");
  // read from package.json at runtime (①) — a wrong value means the require broke
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(result.serverInfo.version, version,
    "serverInfo.version must be package.json's version — mcp-server.js should read it with require(\"./package.json\")");
});

test("tools/list advertises well-formed tools", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: LATEST });
  const { result } = await mcp.request("tools/list");
  assert.ok(Array.isArray(result.tools) && result.tools.length > 0);
  for (const tool of result.tools) {
    assert.match(tool.name, /^fablecut_[a-z_]+$/, `odd tool name: ${tool.name}`);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema must be an object schema`);
    for (const req of tool.inputSchema.required || []) {
      assert.ok(tool.inputSchema.properties?.[req],
        `${tool.name} marks "${req}" required but never defines it`);
    }
  }
  // The documented surface must stay present; extra tools are allowed to appear.
  const names = result.tools.map((x) => x.name);
  for (const expected of ["fablecut_status", "fablecut_docs", "fablecut_get_project",
    "fablecut_set_project", "fablecut_patch_project", "fablecut_import_media",
    "fablecut_analyze_reference", "fablecut_encode_profiles", "fablecut_validate"]) {
    assert.ok(names.includes(expected), `missing documented tool ${expected}`);
  }
  // fablecut_validate: no required args, an optional candidate `project` object
  const validate = result.tools.find((x) => x.name === "fablecut_validate");
  assert.deepEqual(validate.inputSchema.required ?? [], []);
  assert.equal(validate.inputSchema.properties.project.type, "object");

  // the wire shape is TOOLS minus `summary` (that one feeds manifest.json only)
  assert.deepEqual(result.tools, TOOLS.map(({ summary, ...tool }) => tool),
    "tools/list must serve mcp-tools.js TOOLS, each without its `summary` (see WIRE_TOOLS in mcp-server.js)");
  // the MCPB manifest advertises exactly the tools the server serves
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.tools.map((x) => x.name), names,
    "manifest.json `tools` drifted from mcp-tools.js TOOLS — run: npm run manifest");
});

test("tools/call on an unknown tool is an error result, not a crash", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: LATEST });
  const { text, isError } = await mcp.callTool("fablecut_does_not_exist", {});
  assert.ok(isError, "unknown tool must be flagged isError");
  assert.match(text, /Unknown tool/i);
  await stillAlive(mcp);
});

test("an unknown method returns JSON-RPC -32601", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  const res = await mcp.request("resources/list");
  assert.equal(res.error.code, -32601);
  assert.equal(res.result, undefined, "an error response must not also carry a result");
  await stillAlive(mcp);
});

test("notifications get no reply", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: LATEST });
  mcp.notify("notifications/initialized", {});
  mcp.notify("notifications/cancelled", { requestId: 999 });
  // Round-trip a real request: anything the notifications wrongly emitted would
  // have arrived by the time this reply does.
  await stillAlive(mcp);
  assert.deepEqual(mcp.unmatched(), [], "notifications must not produce responses");
});
