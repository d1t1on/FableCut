"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EXPORT_RANGES, EXPORT_DESTINATIONS } = require("../../export-jobs");
const { TOOLS } = require("../../mcp-tools");

test("export MCP enums are derived and documented", () => {
  const props = TOOLS.find((t) => t.name === "fablecut_export").inputSchema.properties;
  assert.equal(props.range.enum, EXPORT_RANGES);
  assert.equal(props.where.enum, EXPORT_DESTINATIONS);
  const docs = fs.readFileSync(path.join(__dirname, "../../CLAUDE.md"), "utf8")
    .split(/^(?=## )/m).find((s) => s.startsWith("## MCP connection"));
  for (const value of [...EXPORT_RANGES, ...EXPORT_DESTINATIONS])
    assert.ok(docs.includes("`" + value + "`"), `Document export value ${value} in CLAUDE.md → MCP connection`);
});
