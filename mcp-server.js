/* ═══════════════════════════════════════════════════════════════════════════
   FableCut MCP server — connects Claude (Code / Desktop) to the video editor.
   Zero-dependency stdio JSON-RPC (Model Context Protocol).

   Register once for all Claude Code sessions:
     claude mcp add -s user fablecut -- node "<path-to>/fablecut/mcp-server.js"

   Tools: the TOOLS table in mcp-tools.js (names, descriptions, input schemas).
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { loadEncodeProfiles, listProfilesPublic, resolveProfile, profileSummary } = require("./encode-profiles");

const {
  APP_DIR, DATA_DIR, MEDIA_DIR, ANALYSIS_DIR, LIBRARY_DIR, PROJECT_FILE, ensureDirs,
} = require("./paths");
// one extension → kind table for local copies and https downloads alike
const { downloadImportUrl, kindFromName, maybeFaststart, KIND_BY_EXT } = require("./import-url");
// the release version lives in package.json; the initialize reply reads it
const { version: VERSION } = require("./package.json");
// validator, compact views and the patch interpreter are shared with the UI
// and server.js (core/ = one source of truth)
const { validateProject, formatIssues } = require("./core/validate.js");
const { compactProject } = require("./core/summary.js");
const { formatPatch, gate, gateNotes, defaultIn } = require("./core/patch.js");
const { applyPatch } = require("./patch-store.js");
const { TOOLS } = require("./mcp-tools.js");

/* ROOT is where the code lives (server.js, CLAUDE.md); the user's timeline and
   media live under DATA_DIR. Identical unless FABLECUT_DATA_DIR is set. */
const ROOT = APP_DIR;
ensureDirs();
const PORT = process.env.FABLECUT_PORT || 7777;
const BASE = `http://localhost:${PORT}`;

/* MCP initialize must echo a version we actually speak. Echoing an unknown
   client version (or crashing) fails handshake with stock SDK clients. */
const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];
const MCP_DEFAULT_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
function negotiateProtocolVersion(requested) {
  return MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_DEFAULT_PROTOCOL_VERSION;
}

/* ── Helpers ── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readProject() {
  const raw = fs.readFileSync(PROJECT_FILE, "utf8").replace(new RegExp("^\\uFEFF"), "");
  return JSON.parse(raw);
}
function writeProject(doc) {
  // atomic tmp+rename so the UI's file watcher never sees a half-written doc
  const tmp = PROJECT_FILE + ".mcp.tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, PROJECT_FILE);
}
/* Optimistic concurrency: revision of project.json when this session last read
   the full document. If the file has moved past it by write time, someone else
   (usually the user, in the editor UI) edited in between — refuse to clobber. */
let lastReadRevision = null;
function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (r) => { r.resume(); resolve(r.statusCode < 500); });
    req.on("error", () => resolve(false));
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
  });
}
async function ensureUIServer() {
  if (await httpOk(BASE + "/api/project")) return true;
  // server.js reads PORT, not FABLECUT_PORT — pass it on, or a non-default
  // FABLECUT_PORT would spawn the editor on 7777 and then never find it
  spawn(process.execPath, [path.join(ROOT, "server.js")],
    { cwd: ROOT, detached: true, stdio: "ignore", env: { ...process.env, PORT: String(PORT) } }).unref();
  for (let i = 0; i < 12; i++) {
    await sleep(300);
    if (await httpOk(BASE + "/api/project")) return true;
  }
  return false;
}
function ffprobeDuration(file) {
  try {
    const r = spawnSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8", timeout: 10_000 });
    const d = parseFloat((r.stdout || "").trim());
    return isNaN(d) ? undefined : Math.round(d * 1000) / 1000;
  } catch { return undefined; }
}
const uid = () => Math.random().toString(36).slice(2, 9);
/* ids for ops that create things; core/patch skips any already in the doc */
const PATCH_CTX = {
  newId: (prefix = "c_") => prefix + uid(),
  newLinkId: () => "lg_" + uid(),
  checkProfile: (id) => resolveProfile(id), // throws on an unknown encodeProfile id
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const countIssues = (issues) => {
  const errors = issues.filter((i) => i.severity === "error").length;
  return `${plural(errors, "error")}, ${plural(issues.length - errors, "warning")}`;
};

/* ── Tool definitions: mcp-tools.js (TOOLS). `summary` feeds manifest.json only
   (scripts/build-manifest.js), so tools/list serves each tool without it. ── */
const WIRE_TOOLS = TOOLS.map(({ summary, ...tool }) => tool);

/* ── Tool implementations ── */
async function callTool(name, args) {
  switch (name) {
    case "fablecut_status": {
      const up = await ensureUIServer();
      const proj = readProject();
      const dur = proj.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const files = fs.existsSync(MEDIA_DIR)
        ? fs.readdirSync(MEDIA_DIR).filter((f) => fs.statSync(path.join(MEDIA_DIR, f)).isFile())
        : [];
      const libSummary = ["sfx", "elements", "svg", "fonts"].map((d) => {
        const dir = path.join(LIBRARY_DIR, d);
        const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
        return `${d}: ${n}`;
      }).join(", ");
      const cap = (arr, n) => arr.length > n ? arr.slice(0, n).concat(`… +${arr.length - n} more`) : arr;
      let encLine = "";
      try {
        const cfg = loadEncodeProfiles();
        const describe = (id) => {
          const p = cfg.profiles[id];
          return p ? `${id} (${p.label}) — ${profileSummary(p)}` : null;
        };
        const pinned = proj.encodeProfile;
        if (pinned && !cfg.profiles[pinned]) {
          /* a project pinning a since-deleted profile must not read as "nothing
             configured" — the bad id and the fallback are two separate facts */
          encLine = `Export profile: project encodeProfile "${pinned}" is NOT DEFINED in encoding-profiles.json` +
            ` — falling back to default ${describe(cfg.default) || `"${cfg.default}"`}`;
        } else {
          encLine = `Export profile: ${describe(pinned || cfg.default) || `server default "${cfg.default}"`}`;
        }
      } catch { encLine = "Export profile: (encoding-profiles.json unavailable)"; }
      const issues = validateProject(proj);
      return [
        `Editor server: ${up ? "RUNNING — open " + BASE + " in a browser to watch edits live" : "FAILED TO START (check node / port " + PORT + ")"}`,
        `Project: "${proj.name}" — ${proj.width}x${proj.height} @ ${proj.fps}fps, ${proj.clips.length} clip(s), ${dur.toFixed(2)}s, revision ${proj.revision}`,
        `Validation: ${countIssues(issues)}${issues.length ? " — fablecut_validate lists them" : ""}`,
        encLine,
        `Registered media: ${cap(proj.media.map((m) => `${m.id} (${m.kind}, ${m.name}${m.duration ? ", " + m.duration + "s" : ""})`), 25).join("; ") || "none"}`,
        `Files in media/: ${cap(files, 25).join(", ") || "none"}`,
        `Library assets (./library): ${libSummary}`,
        `Project file: ${PROJECT_FILE}`,
        `Tips: fablecut_docs (use \`section\`) for the schema · fablecut_get_project {compact:true} to see the timeline · fablecut_patch_project for edits (cheapest) · fablecut_validate to check them · fablecut_encode_profiles for export presets.`,
      ].join("\n");
    }
    case "fablecut_docs": {
      const md = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
      if (!args.section) return md;
      const q = args.section.toLowerCase();
      const parts = md.split(/^(?=## )/m);
      const hits = parts.filter((s) => s.startsWith("## ") && s.slice(0, s.indexOf("\n")).toLowerCase().includes(q));
      return hits.length ? hits.join("\n") :
        `No '## ' section matches "${args.section}". Headings: ` +
        parts.filter((s) => s.startsWith("## ")).map((s) => s.slice(3, s.indexOf("\n"))).join(" · ");
    }
    case "fablecut_get_project": {
      const doc = readProject();
      lastReadRevision = doc.revision || 0;
      if (!args.compact) return JSON.stringify(doc);
      return compactProject(doc);
    }
    case "fablecut_patch_project": {
      const res = applyPatch({ ...args, dryRun: !!args.dryRun }, { read: readProject, write: writeProject, ctx: PATCH_CTX });
      if (!res.ok) throw new Error(res.error);
      if (!res.dryRun) lastReadRevision = res.revision;
      return formatPatch(res, { revision: res.revision });
    }
    case "fablecut_set_project": {
      const doc = args.project;
      if (!doc || typeof doc !== "object") throw new Error("`project` must be an object");
      if (!Array.isArray(doc.clips) || !Array.isArray(doc.media))
        throw new Error("project must contain `clips` and `media` arrays");
      let cur = { revision: 0 }, before = [];
      try { cur = readProject(); before = validateProject(cur); } catch {}
      // the validator owns per-clip checks (ids, timing, media refs, kinds, lanes):
      // refuse new errors before the conflict check, as the old hand-rolled checks did
      const defaulted = defaultIn(doc.clips);
      const checked = gate(before, doc, "document");
      if (checked.message) throw new Error(checked.message);
      const curRev = cur.revision || 0;
      // strict check when this session read via the tool; otherwise fall back to
      // the revision baked into the submitted doc (e.g. it was read as a file)
      const stale = lastReadRevision !== null
        ? curRev !== lastReadRevision
        : (doc.revision || 0) < curRev;
      if (stale && !args.force) {
        throw new Error(
          `CONFLICT — not saved. project.json is at revision ${curRev}, but this edit was based on ` +
          `revision ${lastReadRevision ?? (doc.revision || 0)}: the project changed in between ` +
          `(the user probably tweaked something in the editor UI). ` +
          `Call fablecut_get_project, re-apply your edit on top of the latest document, then save again. ` +
          `Pass force:true only if the user explicitly wants those changes discarded.`);
      }
      doc.revision = Math.max(curRev + 1, (doc.revision || 0));
      // Agents often omit top-level flags they don't know about. Keep panSchema
      // once established so a rewrite that drops pan:0 cannot re-trigger L/R migration.
      if (!(doc.panSchema >= 1) && (cur.panSchema >= 1)) doc.panSchema = 1;
      writeProject(doc);
      lastReadRevision = doc.revision;
      return `Saved (revision ${doc.revision}). ${doc.clips.length} clip(s). The editor UI (if open at ${BASE}) has hot-reloaded.` +
        gateNotes({ defaulted, newWarnings: checked.newWarnings });
    }
    case "fablecut_validate": {
      const candidate = args.project !== undefined;
      if (candidate && !isObj(args.project))
        throw new Error("`project` must be an object (omit it to validate project.json on disk)");
      const doc = candidate ? args.project : readProject();
      const issues = validateProject(doc);
      return [
        `${candidate ? "Candidate project (not saved)" : `project.json (revision ${doc.revision ?? 0})`}: ${countIssues(issues)}.`,
        issues.length ? formatIssues(issues, { limit: 40 }) : "No problems found.",
        `Errors = what patch/set refuse to introduce; warnings are advisory. ` +
        `Contract: ${path.join(ROOT, "schema", "project.schema.json")} (JSON Schema) + semantic checks; ` +
        `every code is explained in fablecut_docs {section:"Validation"}.`,
      ].join("\n");
    }
    case "fablecut_analyze_reference": {
      let src = args.path || "";
      let file = /^\/media\//i.test(src)
        ? path.join(MEDIA_DIR, decodeURIComponent(src.replace(/^\/media\//i, "")))
        : src;
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new Error("File not found: " + src);
      // keep the reference inside media/ so the user can preview it in the UI
      if (path.dirname(path.resolve(file)).toLowerCase() !== MEDIA_DIR.toLowerCase()) {
        if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
        const ext = path.extname(file);
        const stem = path.basename(file, ext).replace(/[^\w.\- ()\[\]]+/g, "_");
        let target = path.join(MEDIA_DIR, stem + ext);
        let i = 1;
        while (fs.existsSync(target)) target = path.join(MEDIA_DIR, `${stem}_${i++}${ext}`);
        fs.copyFileSync(file, target);
        file = target;
      }
      const { analyze } = require("./analyze.js");
      const bp = await analyze(file, {
        threshold: args.threshold,
        music: args.registerMusic !== false,
        musicDir: MEDIA_DIR,
        srcUrl: "/media/" + encodeURIComponent(path.basename(file)),
      });
      let musicNote = "Reference has no audio track — no music extracted.";
      if (bp.music) {
        bp.music.src = "/media/" + encodeURIComponent(bp.music.name);
        // merge-safe append, same protocol as fablecut_import_media
        const entry = {
          id: "m_" + uid(), name: bp.music.name, kind: "audio",
          src: bp.music.src, duration: bp.duration,
        };
        const proj = readProject();
        const wasCurrent = lastReadRevision === (proj.revision || 0);
        proj.media.push(entry);
        proj.revision = (proj.revision || 0) + 1;
        writeProject(proj);
        if (wasCurrent) lastReadRevision = proj.revision;
        bp.music.mediaId = entry.id;
        musicNote = `Music extracted and registered as media "${entry.id}" — place it on A1 (in:0, duration:${bp.duration}).`;
      }
      const dir = ANALYSIS_DIR;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, path.basename(file, path.extname(file)) + ".json"),
        JSON.stringify(bp, null, 2));
      return JSON.stringify(bp, null, 2) + "\n\n" + [
        musicNote,
        `REMAKE RECIPE: 1) set project width/height/fps to ${bp.width}x${bp.height} @ ${bp.fps} — 2) write beats[] into project markers — 3) extracted music on A1 — 4) one clip per shots[] entry at the same start/duration on V1 (hard cuts; footage energy should track each shot's energy value) — 5) biggest moment on drop (${bp.drop}s)${bp.bpm ? ` — tempo ${bp.bpm} BPM` : ""}. Full recipe: fablecut_docs → "Remake a reference video".`,
      ].join("\n");
    }
    case "fablecut_import_media": {
      const src = args.path;
      if (!src) throw new Error("path is required");
      let target, kind;
      if (/^https?:\/\//i.test(src)) {
        if (!/^https:\/\//i.test(src)) throw new Error("URL must be https");
        const got = await downloadImportUrl(src, MEDIA_DIR);
        target = got.target;
        kind = kindFromName(got.name);
        await maybeFaststart(target);
      } else {
        if (!fs.existsSync(src) || !fs.statSync(src).isFile())
          throw new Error("File not found: " + src);
        const ext = path.extname(src).toLowerCase();
        kind = KIND_BY_EXT[ext];
        if (!kind) throw new Error(`Unsupported extension ${ext}`);
        if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
        let base = path.basename(src).replace(/[^\w.\- ()\[\]]+/g, "_");
        target = path.join(MEDIA_DIR, base);
        let i = 1;
        const stem = path.basename(base, ext);
        while (fs.existsSync(target)) target = path.join(MEDIA_DIR, `${stem}_${i++}${ext}`);
        fs.copyFileSync(src, target);
      }
      if (!kind) throw new Error("Unsupported media type");
      const entry = {
        id: "m_" + uid(),
        name: path.basename(target),
        kind,
        src: "/media/" + encodeURIComponent(path.basename(target)),
        duration: kind === "image" || kind === "svg" ? undefined : ffprobeDuration(target),
      };
      const proj = readProject();
      // import only appends a media entry (never touches clips), so it merges
      // into the live document; keep lastReadRevision in step only if it
      // already was — otherwise a later set_project must still re-read
      const wasCurrent = lastReadRevision === (proj.revision || 0);
      proj.media.push(entry);
      proj.revision = (proj.revision || 0) + 1;
      writeProject(proj);
      if (wasCurrent) lastReadRevision = proj.revision;
      return `Imported → ${JSON.stringify(entry)}\n` +
        (entry.duration == null && kind !== "image"
          ? "Note: duration unknown (no ffprobe). The browser UI will probe and fill it in; re-read the project before trimming this media."
          : "Ready to use in clips via mediaId.");
    }
    case "fablecut_encode_profiles": {
      if (args.profile) {
        const p = resolveProfile(String(args.profile));
        return JSON.stringify({
          default: loadEncodeProfiles().default,
          profile: args.profile,
          label: p.label,
          description: p.description,
          jpegQuality: p.jpegQuality,
          extension: p.extension,
          color: p.color,
          args: p.args,
        }, null, 2);
      }
      return JSON.stringify(listProfilesPublic(!!args.detail), null, 2);
    }
    default:
      throw new Error("Unknown tool: " + name);
  }
}

/* ── MCP stdio plumbing (newline-delimited JSON-RPC 2.0) ── */
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: "fablecut", version: VERSION },
        },
      });
    }
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: WIRE_TOOLS } });
    if (method === "tools/call") {
      pending++;
      try {
        const text = await callTool(params.name, params.arguments || {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
      } finally {
        if (--pending === 0 && stdinClosed) process.exit(0);
      }
      return;
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (!isRequest) return; // ignore other notifications (e.g. notifications/initialized)
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e) } });
  }
}

let buf = "", pending = 0, stdinClosed = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
});
process.stdin.on("end", () => { stdinClosed = true; if (pending === 0) process.exit(0); });
