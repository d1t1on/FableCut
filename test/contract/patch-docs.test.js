/* Contract: the OPS table in core/patch.js is the one source of truth for
   patch ops. The MCP tool description and the unknown-op error are derived
   from it at runtime; CLAUDE.md, README.md and manifest.json are written by
   hand, so this checks they name every op (CLAUDE.md: and no op that is
   gone, and every settable project field). */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { OPS, TIMELINE_OPS, describeOps } = require("../../core/patch");
const { PATCHABLE_PROJECT_FIELDS } = require("../../core/schema");
const { makeDataDir, startMcp } = require("../helpers");

const ROOT = path.join(__dirname, "..", "..");
const MD = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
const MCP_SECTION = MD.split(/^(?=## )/m).find((s) => s.startsWith("## MCP connection"));
const WHERE = "the fablecut_patch_project op list in CLAUDE.md → '## MCP connection'";

test("CLAUDE.md documents every patch op in OPS", () => {
  assert.ok(MCP_SECTION, "CLAUDE.md needs its '## MCP connection' section (the patch op list lives there)");
  const missing = OPS.map((o) => o.name).filter((name) => !MCP_SECTION.includes(`op:"${name}"`));
  assert.deepEqual(missing, [],
    `CLAUDE.md doesn't document patch op(s) ${missing.join(", ")}: add a line for each to ${WHERE}, ` +
    `shaped like its row in describeOps() (core/patch.js OPS: {op:"name", params} — doc)`);
});

test("CLAUDE.md names no patch op that OPS doesn't have", () => {
  const names = new Set(OPS.map((o) => o.name));
  const stale = [...new Set([...MCP_SECTION.matchAll(/op:"(\w+)"/g)].map((m) => m[1]))].filter((n) => !names.has(n));
  assert.deepEqual(stale, [],
    `CLAUDE.md → '## MCP connection' mentions op(s) ${stale.join(", ")} that core/patch.js OPS doesn't have: ` +
    `remove or rename them there, or add a row to OPS in core/patch.js`);
});

test("CLAUDE.md's setProject line lists exactly the patchable project fields", () => {
  const at = MCP_SECTION.indexOf('{op:"setProject"');
  assert.ok(at >= 0, `add the setProject line to ${WHERE}`);
  const line = MCP_SECTION.slice(at).split(/\n\s*\n/)[0];
  const listed = [...(line.split("May change:")[1] || "").matchAll(/`(\w+)`/g)].map((m) => m[1]);
  const fix = `edit the "May change:" list on the setProject line in ${WHERE} ` +
    "(the fields are the x-patchable ones in core/schema.js — PATCHABLE_PROJECT_FIELDS)";
  assert.deepEqual(PATCHABLE_PROJECT_FIELDS.filter((k) => !listed.includes(k)), [], `settable field(s) missing: ${fix}`);
  assert.deepEqual(listed.filter((k) => !PATCHABLE_PROJECT_FIELDS.includes(k)), [], `field(s) listed that setProject refuses: ${fix}`);
});

test("the MCP patch tool description embeds describeOps() and names the timeline ops", async (t) => {
  const mcp = startMcp(t, makeDataDir(t));
  await mcp.request("initialize", { protocolVersion: "2025-11-25" });
  const { result } = await mcp.request("tools/list");
  const tool = result.tools.find((x) => x.name === "fablecut_patch_project");
  assert.ok(tool.description.includes(describeOps()),
    "mcp-server.js TOOLS → fablecut_patch_project: build the op list with ${describeOps()} from core/patch.js " +
    "(derived at runtime — never hand-write it)");
  assert.ok(tool.description.includes(`The timeline ops (${TIMELINE_OPS.join(", ")}`),
    "mcp-server.js TOOLS → fablecut_patch_project: name the timeline ops with ${TIMELINE_OPS.join(\", \")} from core/patch.js");
  assert.equal(tool.inputSchema.properties.dryRun.type, "boolean", "fablecut_patch_project must accept dryRun");
});

/* The prose that tells agents which ops to prefer lists names by hand, so it
   is checked against OPS too: every op in README's MCP paragraph, every
   timeline op (OPS rows with timeline: true) wherever agents are told to
   prefer them. */
test("README and the prefer-the-timeline-ops prose name the ops OPS has", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const para = readme.split(/\n\s*\n/).find((p) => p.includes("token-efficient by design")) || "";
  const tokenSection = MD.split(/^(?=### )/m).find((s) => s.startsWith("### Token-efficient editing")) || "";
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const patchTool = (manifest.tools || []).find((t) => t.name === "fablecut_patch_project") || {};
  const places = [
    ["README.md → the MCP paragraph that says 'token-efficient by design'", para, OPS.map((o) => o.name)],
    ["CLAUDE.md → '### Token-efficient editing' (the 'timeline ops' item)", tokenSection, TIMELINE_OPS],
    ["manifest.json → tools[fablecut_patch_project].description", patchTool.description || "", TIMELINE_OPS],
  ];
  for (const [where, text, names] of places) {
    assert.ok(text, `${where} is gone — restore it, or point this test at where the ops are listed now`);
    const missing = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(text));
    assert.deepEqual(missing, [], `${where} doesn't name op(s) ${missing.join(", ")}: add them there ` +
      "(the ops are the rows of OPS in core/patch.js; the timeline ones have timeline: true)");
  }
});
