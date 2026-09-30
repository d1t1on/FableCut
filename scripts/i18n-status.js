/* `npm run i18n:status` — how far each docs/i18n translation lags README.md.

   Each translation ends with a sync note naming the README.md commit it was
   written against (<code>3dd1d55</code>; test/contract/i18n.test.js checks
   the note is there). CONTRIBUTING lets translations lag, so this reports,
   never fails: per file, the commit and how many commits since then changed
   README.md. Needs git history; a missing commit or a shallow clone
   (CI's default) is reported, not fatal. Always exits 0. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "docs", "i18n");
/* The last <code>sha</code> in the file's final <sub>…</sub> block. */
const SYNC_NOTE = /<sub>(?:(?!<sub>)[\s\S])*?<code>([0-9a-f]{7,40})<\/code>(?:(?!<sub>)[\s\S])*<\/sub>\s*$/;

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

function status() {
  const files = fs.readdirSync(DIR).filter((f) => /^README\..+\.md$/.test(f)).sort();
  const inRepo = git("rev-parse", "--is-inside-work-tree") === "true";
  const shallow = inRepo && git("rev-parse", "--is-shallow-repository") === "true";
  const head = inRepo ? git("log", "-1", "--format=%h", "--", "README.md") : null;
  const rows = files.map((f) => {
    const sha = (fs.readFileSync(path.join(DIR, f), "utf8").match(SYNC_NOTE) || [])[1];
    if (!sha) return `${f}: no sync note (<sub>… <code>sha</code> …</sub> at the end) — see CONTRIBUTING → Translations`;
    if (!inRepo) return `${f}: synced at ${sha} (not a git checkout — lag unknown)`;
    if (git("cat-file", "-e", `${sha}^{commit}`) === null)
      return `${f}: synced at ${sha} — commit not in this clone${shallow ? " (shallow: git fetch --unshallow)" : ""}, lag unknown`;
    const behind = +git("rev-list", "--count", `${sha}..HEAD`, "--", "README.md");
    return `${f}: synced at ${sha}, ${behind ? `${behind} README.md commit${behind === 1 ? "" : "s"} behind` : "up to date"}`;
  });
  const dirty = inRepo && git("status", "--porcelain", "--", "README.md") ? " (plus uncommitted changes)" : "";
  return [`README.md last changed in ${head || "(unknown)"}${dirty}`, ...rows].join("\n");
}

if (require.main === module) console.log(status());
module.exports = { SYNC_NOTE };
