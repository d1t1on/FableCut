/* Disk-facing patch transaction shared by MCP and REST. core/patch remains
   the sole interpreter; this layer checks revisions and owns the one write.
   read/write/ctx are explicit so write-time races can be tested without clocks. */
"use strict";
const { patchProject } = require("./core/patch.js");

function applyPatch({ ops, baseRevision, dryRun = false }, { read, write, ctx = {} }) {
  if (baseRevision != null && (!Number.isInteger(baseRevision) || baseRevision < 0))
    throw Object.assign(new Error("baseRevision must be a non-negative integer revision"), { status: 400 });
  const conflict = (revision, base) => Object.assign(new Error(
    `CONFLICT — not saved. project.json is at revision ${revision}, but this patch was based on revision ${base}. ` +
    `Re-read the clips you touch, then retry with baseRevision:${revision}, or omit baseRevision to apply on the latest document.`
  ), { status: 409, revision });
  for (let attempt = 0; attempt < 4; attempt++) {
    const disk = read(), revision = disk.revision || 0;
    if (baseRevision != null && revision !== baseRevision) throw conflict(revision, baseRevision);
    const result = patchProject(disk, structuredClone(ops), { ...ctx, dryRun });
    if (!result.ok) return result;
    const latest = read().revision || 0;
    if (latest !== revision) {
      if (baseRevision != null || attempt === 3) throw conflict(latest, baseRevision ?? revision);
      continue;
    }
    result.revision = revision + 1;
    if (!result.dryRun) {
      result.doc.revision = result.revision;
      write(result.doc);
    }
    return result;
  }
}

module.exports = { applyPatch };
