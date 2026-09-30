/* `npm run crap` — a one-off CRAP report. Not a CI gate: run it after a
   batch of core/ work to pick the next tests to write, and before extracting
   more of app.js to pick what goes next.

     CRAP(f) = c² · (1 − cov)³ + c

   c is f's cyclomatic complexity: 1 + each if, ?:, &&, ||, ??, &&=, ||=,
   ??=, case, for / for-in / for-of / while / do, catch in its own body
   (a nested function counts for itself, not for its parent). cov is f's
   line coverage: the lcov DA lines of node's built-in coverage that belong
   to f (each line goes to the innermost function around it). A high score
   is complex AND untested.

     core/   the suite runs with coverage restricted to core/** (the same
             files and tests as `npm run coverage`) into coverage/lcov.info;
             the top 20 by CRAP, then every function the action rule flags:
             CRAP > 30, or coverage < 80% with c ≥ 8 → write tests for it
     app.js  no coverage (browser UI), so CRAP = c² + c: the top 25 by
             complexity, the backlog for the next extraction into core/

   Writes reports/crap.md (gitignored) and prints compact tables.
     --no-run  reuse coverage/lcov.info from an earlier run
   acorn and acorn-walk are devDependencies (npm ci). */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const LCOV = path.join(ROOT, "coverage", "lcov.info");
const OUT = path.join(ROOT, "reports", "crap.md");
const CORE_TOP = 20, APP_TOP = 25;
const flagged = (f) => f.crap > 30 || (f.cov < 0.8 && f.c >= 8); // the action rule

let acorn, walk;
try { acorn = require("acorn"); walk = require("acorn-walk"); }
catch { console.error("acorn / acorn-walk are not installed — run npm ci"); process.exit(1); }

/* ── Complexity ── */
const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const DECISION = {
  IfStatement: 1, ConditionalExpression: 1, ForStatement: 1, ForInStatement: 1, ForOfStatement: 1,
  WhileStatement: 1, DoWhileStatement: 1, CatchClause: 1,
  SwitchCase: (n) => (n.test ? 1 : 0), // `default:` is not a decision
  LogicalExpression: 1, // && || ??
  AssignmentExpression: (n) => (/^(&&|\|\||\?\?)=$/.test(n.operator) ? 1 : 0),
};
const keyName = (k) => (k.type === "Identifier" ? k.name : k.type === "Literal" ? String(k.value) : "[computed]");

/* Every function in `file`: { name, file, line, endLine, c } — named from
   where it sits (a declaration, `const x =`, `a.b =`, an object key
   qualified by its object, an OPS-style row by its `name`), else <arrow@line>;
   nested ones are prefixed with their enclosing function ("outer/inner"). */
function functionsOf(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true, allowHashBang: true });
  const text = (n) => src.slice(n.start, n.end);
  const fns = new Map(); // node → { own, outer, c, … }
  const complexity = new Map(); // fn node → decisions
  const nearestFn = (anc) => { for (let i = anc.length - 2; i >= 0; i--) if (FN.has(anc[i].type)) return anc[i]; return null; };
  /* the name of an object literal from its context, or "" */
  function objName(anc, i) {
    const obj = anc[i], p = anc[i - 1];
    if (!p) return "";
    if (p.type === "VariableDeclarator" && p.init === obj) return text(p.id);
    if (p.type === "AssignmentExpression" && p.right === obj) return text(p.left);
    if (p.type === "Property" && p.value === obj) { const o = objName(anc, i - 2); return (o ? o + "." : "") + keyName(p.key); }
    if (p.type === "ArrayExpression") {
      const row = obj.properties.find((q) => q.type === "Property" && keyName(q.key) === "name" && q.value.type === "Literal");
      const arr = anc[i - 2] && anc[i - 2].type === "VariableDeclarator" ? text(anc[i - 2].id) : "";
      return (arr ? arr + "." : "") + (row ? row.value.value : `[${p.elements.indexOf(obj)}]`);
    }
    return "";
  }
  function ownName(node, anc) {
    const p = anc[anc.length - 2], line = node.loc.start.line;
    const anon = `<${node.type === "ArrowFunctionExpression" ? "arrow" : "fn"}@${line}>`;
    if (node.id) return node.id.name;
    if (!p) return anon;
    if (p.type === "VariableDeclarator" && p.init === node) return text(p.id);
    if (p.type === "AssignmentExpression" && p.right === node) return text(p.left);
    if (p.type === "Property" && p.value === node) { const o = objName(anc, anc.length - 3); return (o ? o + "." : "") + keyName(p.key); }
    if (p.type === "MethodDefinition") { const cls = anc[anc.length - 4]; return (cls && cls.id ? cls.id.name + "." : "") + keyName(p.key); }
    if (p.type === "CallExpression" && p.callee === node) return `<iife@${line}>`;
    if (p.type === "CallExpression" && p.callee.type === "FunctionExpression") return `<factory@${line}>`; // the dual-mode wrapper's
    if (p.type === "CallExpression" || p.type === "NewExpression") { // a callback: name it by what it is passed to
      const callee = p.callee.type === "MemberExpression" ? keyName(p.callee.property) : p.callee.type === "Identifier" ? p.callee.name : "";
      const arg0 = p.arguments[0] && p.arguments[0].type === "Literal" && typeof p.arguments[0].value === "string" ? `("${p.arguments[0].value}")` : "";
      if (callee) return `<${callee}${arg0} cb@${line}>`;
    }
    return anon;
  }
  walk.fullAncestor(ast, (node, _st, anc) => {
    const d = DECISION[node.type];
    if (d) {
      const f = nearestFn(anc);
      const n = typeof d === "function" ? d(node) : d;
      if (f && n) complexity.set(f, (complexity.get(f) || 0) + n);
    }
    if (FN.has(node.type)) fns.set(node, { node, own: ownName(node, anc), outer: nearestFn(anc) });
  });
  const full = (e) => {
    if (e.name) return e.name;
    const o = e.outer && fns.get(e.outer);
    const prefix = o && !/^<(iife|factory)@/.test(o.own) ? full(o) + "/" : "";
    return (e.name = prefix + e.own);
  };
  return [...fns.values()].map((e) => ({
    name: full(e), file, line: e.node.loc.start.line, endLine: e.node.loc.end.line,
    col: e.node.loc.start.column, c: 1 + (complexity.get(e.node) || 0),
  }));
}

/* ── Coverage ── */
function runCoverage() {
  fs.mkdirSync(path.dirname(LCOV), { recursive: true });
  const args = ["--test", "--experimental-test-coverage", '--test-coverage-include=core/**',
    "--test-reporter=lcov", `--test-reporter-destination=${path.relative(ROOT, LCOV)}`,
    "--test-reporter=spec", "--test-reporter-destination=stdout", "test/**/*.test.js"];
  console.log(`running: node ${args.join(" ")}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  const summary = (r.stdout || "").split("\n").filter((l) => /^ℹ (tests|pass|fail|duration_ms) /.test(l));
  if (r.status !== 0) {
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
    console.error("the test suite failed — fix it first (coverage from a failing run misleads)");
    process.exit(r.status || 1);
  }
  console.log(summary.join("  ·  ").replace(/ℹ /g, ""));
}
/* lcov → Map(file → { da: Map(line → hits), br: [[line, hits]] }) */
function readLcov() {
  if (!fs.existsSync(LCOV)) { console.error(`${path.relative(ROOT, LCOV)} is missing — run without --no-run`); process.exit(1); }
  const out = new Map();
  let cur = null;
  for (const l of fs.readFileSync(LCOV, "utf8").split("\n")) {
    if (l.startsWith("SF:")) out.set(path.relative(ROOT, path.resolve(ROOT, l.slice(3))).split(path.sep).join("/"), (cur = { da: new Map(), br: [] }));
    else if (l.startsWith("DA:") && cur) { const [line, hits] = l.slice(3).split(",").map(Number); cur.da.set(line, hits); }
    else if (l.startsWith("BRDA:") && cur) { const f = l.slice(5).split(","); cur.br.push([+f[0], f[3] === "-" ? 0 : +f[3]]); }
    else if (l === "end_of_record") cur = null;
  }
  return out;
}
/* Give each DA line (and each BRDA branch, by its line) to the innermost
   function around it. cov = hit / total of a function's own lines (all of
   its range when nested ones took them all); br = its branches hit / total,
   the uncovered ones listed by line — what the next test should reach. */
function attachCoverage(fns, { da, br }) {
  const innermost = (line) => {
    let best = null;
    for (const f of fns) {
      if (line < f.line || line > f.endLine) continue;
      if (!best || f.endLine - f.line < best.endLine - best.line
        || (f.endLine - f.line === best.endLine - best.line && (f.line > best.line || f.col > best.col))) best = f;
    }
    return best;
  };
  const own = new Map(fns.map((f) => [f, { lines: [], br: [] }]));
  for (const [line] of da) { const f = innermost(line); if (f) own.get(f).lines.push(line); }
  for (const b of br) { const f = innermost(b[0]); if (f) own.get(f).br.push(b); }
  for (const f of fns) {
    let { lines, br: bs } = own.get(f);
    if (!lines.length) lines = [...da.keys()].filter((l) => l >= f.line && l <= f.endLine);
    const missed = lines.filter((l) => !(da.get(l) > 0));
    f.cov = lines.length ? 1 - missed.length / lines.length : 0;
    f.missed = ranges(missed);
    const brMissed = bs.filter(([, hits]) => !(hits > 0)).map(([l]) => l);
    f.br = bs.length ? `${bs.length - brMissed.length}/${bs.length}` : "—";
    f.brMissed = [...new Set(brMissed)].sort((a, b) => a - b).join(" ");
  }
}
const ranges = (ls) => {
  const out = [];
  for (const l of [...ls].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && l === last[1] + 1) last[1] = l; else out.push([l, l]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(" ");
};
const crap = (c, cov) => c * c * (1 - cov) ** 3 + c;

/* ── Output ── */
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
function table(head, rows, widths) {
  const pad = (cells) => cells.map((c, i) => (i < widths.length && widths[i] ? String(c).padEnd(widths[i]) : String(c))).join("  ").trimEnd();
  return [pad(head), pad(head.map((h, i) => "─".repeat(widths[i] || h.length))), ...rows.map(pad)].join("\n");
}
const md = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`,
  ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`)].join("\n");

function main() {
  const noRun = process.argv.includes("--no-run");
  if (!noRun) runCoverage();
  const da = readLcov();
  const coreFiles = fs.readdirSync(path.join(ROOT, "core")).filter((f) => f.endsWith(".js")).sort().map((f) => "core/" + f);
  const core = [];
  for (const file of coreFiles) {
    const fns = functionsOf(file);
    const cov = da.get(file);
    if (!cov) { console.warn(`no coverage for ${file} in the lcov — counted as 0%`); fns.forEach((f) => Object.assign(f, { cov: 0, missed: "all", br: "—", brMissed: "" })); }
    else attachCoverage(fns, cov);
    for (const f of fns) f.crap = crap(f.c, f.cov);
    core.push(...fns);
  }
  const app = functionsOf("app.js");
  for (const f of app) f.crap = crap(f.c, 0);

  const byCrap = (a, b) => b.crap - a.crap || b.c - a.c || a.file.localeCompare(b.file) || a.line - b.line;
  const topCore = [...core].sort(byCrap).slice(0, CORE_TOP);
  const flags = core.filter(flagged).sort(byCrap);
  const topApp = [...app].sort((a, b) => b.c - a.c || a.line - b.line).slice(0, APP_TOP);

  const coreRow = (f, i) => [i + 1, f.name, `${f.file}:${f.line}`, f.c, `${(f.cov * 100).toFixed(1)}%`, fmt(+f.crap.toFixed(1)),
    f.br, [f.missed && `lines ${f.missed}`, f.brMissed && `branches @ ${f.brMissed}`].filter(Boolean).join("; ") || "—"];
  const appRow = (f, i) => [i + 1, f.name, `app.js:${f.line}`, f.c, f.endLine - f.line + 1, f.crap];
  const coreHead = ["#", "function", "where", "c", "cov", "CRAP", "branches", "uncovered"];
  const appHead = ["#", "function", "where", "c", "lines", "CRAP (no cov)"];

  const when = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const report = [
    "# CRAP report", "",
    `Generated ${when} by \`npm run crap\` (scripts/crap.js). CRAP = c²·(1−cov)³ + c: cyclomatic complexity c, line coverage cov from node's built-in coverage over the whole suite (core/** only). "branches" is V8 block coverage (hit/total) for the same function; "uncovered" lists its unhit lines and the lines of its unhit branches — the next tests to write. CRAP never drops below c: past full coverage only splitting a function lowers it.`, "",
    `## core/ — top ${CORE_TOP} by CRAP (${core.length} functions)`, "",
    md(coreHead, topCore.map(coreRow)), "",
    "## core/ — flagged: CRAP > 30, or coverage < 80% with c ≥ 8", "",
    flags.length ? md(coreHead, flags.map(coreRow)) : "None — every core function is below both bars.", "",
    `## app.js — top ${APP_TOP} by complexity (${app.length} functions, no coverage: CRAP = c² + c)`, "",
    "The backlog for the next extraction into core/.", "",
    md(appHead, topApp.map(appRow)), "",
  ].join("\n");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, report);

  const w = [3, 44, 21, 3, 7, 6, 8];
  const short = (rows) => rows.map((r) => r.map((c, i) => (i === 1 ? cut(String(c), 44) : c)));
  console.log(`\ncore/ — top ${CORE_TOP} by CRAP (${core.length} functions)`);
  console.log(table(coreHead, short(topCore.map(coreRow)), w));
  console.log(`\nflagged (CRAP > 30, or cov < 80% with c ≥ 8): ${flags.length ? flags.map((f) => `${f.name} (${f.file}:${f.line})`).join(", ") : "none"}`);
  console.log(`\napp.js — top ${APP_TOP} by complexity (${app.length} functions, no coverage)`);
  console.log(table(appHead, short(topApp.map(appRow)), [3, 44, 21, 3, 6]));
  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
}

main();
