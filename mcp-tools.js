/* The MCP tool list — the single source for every tool name, description and
   input schema. Split out of mcp-server.js so scripts and tests can require it
   without starting the stdio server.

   - mcp-server.js serves TOOLS on tools/list, minus `summary`.
   - `summary` is the one-line description the MCPB manifest shows:
     scripts/build-manifest.js writes manifest.json `tools` from it
     (`npm run manifest`; CI runs `npm run manifest -- --check`).
   - CLAUDE.md and README.md name every tool by hand;
     test/contract/mcp-docs.test.js checks they name each one.
   The patch tool's op list is derived from core/patch.js OPS at load time. */
"use strict";
const { describeOps, TIMELINE_OPS } = require("./core/patch.js");

const TOOLS = [
  {
    name: "fablecut_status",
    summary: "Auto-start the editor server and return its URL plus a project summary",
    description: "FableCut video editor: ensure the editor web server is running (auto-starts it), and get the editor URL, project summary and media library. Call this first in a session.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fablecut_docs",
    summary: "Return the full editor manual (project.json schema, props, recipes), optionally a single section",
    description: "Return the FableCut project schema documentation: clips, tracks, props, keyframe animation, transitions, and editing recipes. Read this before editing. TOKEN TIP: pass `section` to fetch only the '## …' section(s) you need (substring match, e.g. \"props\", \"Recipes\", \"Remake\") instead of the whole manual.",
    inputSchema: {
      type: "object",
      properties: { section: { type: "string", description: "Return only '## ' sections whose heading contains this text (case-insensitive). Omit for the full document." } },
    },
  },
  {
    name: "fablecut_get_project",
    summary: "Read the timeline JSON (compact mode available for token-efficient planning)",
    description: "Get the FableCut project (the timeline document). TOKEN TIP: pass compact:true for a one-line-per-clip summary (ids, tracks, timings, non-default props) — usually all you need to plan an edit; fetch the full JSON only when you must inspect exact keyframes.",
    inputSchema: {
      type: "object",
      properties: { compact: { type: "boolean", description: "Return a compact human-readable summary instead of the full JSON" } },
    },
  },
  {
    name: "fablecut_patch_project",
    summary: `Apply targeted, merge-safe ops (add/update/remove clip or media, set project fields) plus the editor's own timeline edits (${TIMELINE_OPS.join(", ")} — link groups and speed ramps included); refuses edits that add validation errors, returns a compact diff, and can dry-run`,
    description: `Apply targeted edits to the FableCut project WITHOUT round-tripping the whole document — PREFER THIS over get+set for every edit (it is ~10-100x cheaper in tokens and merge-safe by design: it re-reads the latest document from disk, applies your ops in order, bumps revision once, saves atomically). Ops, applied in order:\n${describeOps()}\nThe timeline ops (${TIMELINE_OPS.join(", ")}, and removeClip with linked:true) run the editor's own edit code, exactly as the UI does: prefer them to a cut, trim or move computed by hand with updateClip/addClip — they keep link groups (picture + audio stems), speed ramps, keyframes and transitions right. All-or-nothing: an invalid op — or a result with a NEW validation error (duplicate id, missing start, unknown media, speed out of range, …; problems already on disk don't count) — aborts the whole patch unsaved with the error codes; new warnings are listed in the result. The result ends with "Changes:", a compact diff of what the patch did (+added, -removed, ~id field: old→new), so there is no need to re-read the project to check it. dryRun:true returns the same result — validation and diff included — without saving anything.`,
    inputSchema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: { type: "object" },
          description: "Edit operations, applied in order (see tool description for shapes)",
        },
        dryRun: { type: "boolean", description: "Preview only: validate the patch and return its result and Changes diff, but save nothing" },
      },
      required: ["ops"],
    },
  },
  {
    name: "fablecut_set_project",
    summary: "Replace the timeline JSON with optimistic-concurrency conflict detection",
    description: "Replace the FableCut project JSON. Pass the COMPLETE document (read with fablecut_get_project, modify, send back whole). Revision is auto-bumped; the open editor UI hot-reloads instantly so the user sees the edit live. CONFLICT-SAFE: if the project changed on disk since your last fablecut_get_project (e.g. the user tweaked something in the UI), the call errors instead of overwriting — re-read, re-apply your edit on top of the latest document, and retry. VALIDATED: a document that would add a validation error (duplicate id, missing start/duration, unknown mediaId, bad kind/lane, …) is refused with the error codes; problems already on disk don't count. Clips without `in` get in:0.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "object", description: "The complete project document (see fablecut_docs for schema)" },
        force: { type: "boolean", description: "Overwrite even if the project changed since it was last read (discards those external/user changes). Only when the user explicitly asks." },
      },
      required: ["project"],
    },
  },
  {
    name: "fablecut_validate",
    summary: "Check project.json (or a candidate document) against the schema and the editor's semantic rules; read-only",
    description: "Check a FableCut project against its schema and the editor's semantic rules — unique ids, media and lanes that resolve, clip kind vs lane, source windows that fit the media (speed-ramp aware), link groups in sync, keyframes/transitions inside their clip, unknown props (with typo hints). Read-only, never saves. No args: validates project.json on disk. With `project`: validates that candidate document instead. Errors are what fablecut_patch_project / fablecut_set_project refuse to introduce; warnings are advisory. Call it after a batch of edits.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "object", description: "A candidate project document to check without saving. Omit to validate project.json on disk." },
      },
    },
  },
  {
    name: "fablecut_analyze_reference",
    summary: "Analyze a reference video into an edit blueprint: shot cuts, beats, BPM, energy curve, drop; extracts its music",
    description: "Analyze a reference video into an EDIT BLUEPRINT so a similar edit can be rebuilt with different footage over the same music. Returns: shot boundaries (cuts) with per-shot audio energy, music beats + BPM, a loudness curve, the detected drop, and extracts the reference's music track into media/ (registered in the project, ready to place on A1). Remake recipe: copy the reference's width/height/fps to the project, write `beats` into project `markers`, lay the extracted music on A1, then place one clip per blueprint `shot` at the same start/duration — pick calm footage for low-energy shots and action for high-energy ones, and make the biggest moment land on `drop`. See the 'Remake a reference video' section of fablecut_docs.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The reference video: an absolute file path (copied into media/ automatically) or an existing '/media/…' src" },
        threshold: { type: "number", description: "Scene-cut sensitivity 0–1 (default: adaptive 0.30→0.20→0.12). Lower it if obvious cuts are missed, raise it if too many false cuts." },
        registerMusic: { type: "boolean", description: "Extract the reference's music and register it as project media (default true)" },
      },
      required: ["path"],
    },
  },
  {
    name: "fablecut_import_media",
    summary: "Copy a local file, or download an https:// URL, into the project's media folder and register it",
    description: "Import a media file into FableCut's media library and register it in the project. Pass a local absolute path (copied, including .svg) or an https:// URL (downloaded into ./media/; video/audio/image only — remote SVG is refused). The URL is never kept as the playback src — CORS would break export. Returns the created media entry (use its id in clips).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to a local file, or an https:// URL to download" } },
      required: ["path"],
    },
  },
  {
    name: "fablecut_encode_profiles",
    summary: "List the ffmpeg encoding profiles for Fast export (encoding-profiles.json)",
    description: "List ffmpeg encoding profiles for Fast export (from encoding-profiles.json). Each profile is a raw ffmpeg argument list plus jpegQuality, extension, and optional color (output matrix/range — default BT.709 tv). Use to pick a profile id for project.encodeProfile. Edit encoding-profiles.json on disk to add custom profiles — anything the local ffmpeg supports works, and the server hot-reloads the file. Profiles are dry-run against ffmpeg when an export starts, so a bad argument is rejected before rendering.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "boolean", description: "Include the full ffmpeg args array per profile (default: a truncated summary)" },
        profile: { type: "string", description: "Return one profile by id instead of the full list" },
      },
    },
  },
];

module.exports = { TOOLS };
