/* Refresh the playground copy of the editor from the repo root.
   Run:  npm run demo:sync    (node docs/demo/sync.js: write the copy)
         npm run demo:check   (node docs/demo/sync.js --check: write nothing;
                               exit 1 listing stale files — CI runs it)
   The playground is the REAL editor (same index.html / core/ / app.js /
   style.css), with one extra script (static-shim.js) loaded first: it answers
   the /api calls from memory so the whole thing runs on GitHub Pages with no
   server. */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = __dirname;
const CHECK = process.argv.includes("--check");

/* out-relative path -> content (Buffer). Built fully before anything is written. */
const plan = new Map();

/* index.html: same markup, plus the shim ahead of the first script (core/ must
   load after it, and app.js after core/ — keep whatever order index.html has). */
let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const firstScript = /<script\b[^>]*\bsrc=/;
if (!firstScript.test(html)) {
  console.error("! could not inject the shim - no <script src=> tag in index.html");
  process.exit(1);
}
html = html
  .replace(/<title>[^<]*<\/title>/, "<title>FableCut playground</title>")
  .replace(firstScript, (tag) => '<script src="static-shim.js"></script>\n' + tag);
plan.set("index.html", Buffer.from(html));

/* App files are copied verbatim. Some of these only exist on branches that
   add them, so a missing one is skipped rather than fatal. */
for (const f of ["app.js", "style.css", "favicon.svg", "ruler-worker.js", "meter-worklet.js", "svg-sanitize.js", "credits.js"]) {
  const from = path.join(ROOT, f);
  if (fs.existsSync(from)) plan.set(f, fs.readFileSync(from));
}

/* core/ is mirrored whole: every dual-mode module index.html may load. */
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const f of walk("core")) plan.set(f, fs.readFileSync(path.join(ROOT, f)));

/* Files in docs/demo/core that core/ no longer has would be served stale. */
const outCore = path.join(OUT, "core");
const stale = fs.existsSync(outCore)
  ? walk(path.relative(ROOT, outCore)).map((f) => path.relative(OUT, path.join(ROOT, f))).filter((f) => !plan.has(f))
  : [];

if (CHECK) {
  const differ = [...plan].filter(([f, buf]) => {
    const to = path.join(OUT, f);
    return !fs.existsSync(to) || !fs.readFileSync(to).equals(buf);
  }).map(([f]) => f);
  const bad = [...differ, ...stale.map((f) => f + " (not in core/ any more)")];
  if (bad.length) {
    console.error("playground (docs/demo/) is out of date - run: npm run demo:sync\n  " + bad.join("\n  "));
    process.exit(1);
  }
  console.log("playground up to date:", plan.size, "files");
  process.exit(0);
}

for (const [f, buf] of plan) {
  const to = path.join(OUT, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, buf);
}
for (const f of stale) fs.rmSync(path.join(OUT, f));

/* Footage is generated, not borrowed: see make-media.js. It is left alone
   here so a sync never overwrites it. */
const mediaDir = path.join(OUT, "media");
const have = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
if (!have.length) console.log("! docs/demo/media is empty - run: node docs/demo/make-media.js");

console.log("playground synced. media files present:", have.length);
