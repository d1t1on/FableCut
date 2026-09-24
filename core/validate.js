/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — project.json validator.

   Dual-mode classic script like core/schema.js, and loaded after it and
   core/keyframes.js (whose mediaTimeAt it shares): a <script> tag exposes
   FableCore.validate, Node require()s it. Pure (no DOM, no Node APIs), so the
   MCP server, the REST PUT and the UI run the same code.

   validateProject(doc) → Issue[], sorted by pointer then code:
     { severity: "error"|"warning", code, path, pointer, message, hint? }
     path    ids, not indices, so it survives reordering: clips[c_ab].props.speed
             (arrays without ids keep indices: markers[2].t)
     pointer RFC 6901 pointer into doc:                /clips/3/props/speed
   Callers gate on newErrors(before, after), so a problem already on disk never
   blocks an unrelated edit. Every code is listed, with its severity, in CODES.

   Layer 1 — structural: an interpreter for exactly the JSON Schema subset
   core/schema.js documents. Any other keyword (oneOf, pattern, …) or a
   dangling/circular $ref THROWS when the schema is compiled (at load for
   PROJECT_SCHEMA), so nobody adds a rule that silently checks nothing.
   Severity comes from the schema's x-severity (see core/schema.js). A missing
   required key is reported at the key's own pointer (/clips/0/start), an
   unknown key in a closed object at that key's pointer.
   Layer 2 — semantic: what JSON Schema can't say — unique ids, references
   that resolve, lanes that fit clip kinds, a source window that fits the
   media (speed-ramp aware), link groups that agree, keyframes/transitions
   that fit their clip, and typo hints. Where layer 1 already reports a
   problem (start < 0, NaN) layer 2 stays quiet: one owner per problem.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports)
    module.exports = factory(require("./schema.js"), require("./keyframes.js"));
  else {
    const core = root.FableCore || {};
    if (!core.schema) throw new Error("core/schema.js must load before core/validate.js");
    if (!core.keyframes) throw new Error("core/keyframes.js must load before core/validate.js");
    root.FableCore.validate = factory(core.schema, core.keyframes);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (S, K) {
  "use strict";
  const { PROJECT_SCHEMA, ANIMATABLE, CLIP_KINDS, EASE, MIN_DUR, SPEED_MIN, SPEED_MAX } = S;
  const { mediaTimeAt, clearSpeedCache } = K;
  const DEFS = PROJECT_SCHEMA.$defs;

  const code = (severity, layer, meaning) => ({ severity, layer, meaning });
  /* severity "schema" = taken from the failing node's x-severity. */
  const CODES = {
    SCHEMA_TYPE: code("schema", "structural", "value has the wrong JSON type"),
    NON_FINITE: code("schema", "structural", "number is NaN or ±Infinity (only possible in in-memory docs)"),
    SCHEMA_ENUM: code("schema", "structural", "value is not one of the allowed options"),
    SCHEMA_CONST: code("schema", "structural", "value differs from the schema's constant"),
    SCHEMA_MINIMUM: code("schema", "structural", "number below the minimum (e.g. start < 0)"),
    SCHEMA_MAXIMUM: code("schema", "structural", "number above the maximum (e.g. speed > 8)"),
    SCHEMA_EXCLUSIVE_MINIMUM: code("schema", "structural", "number not above the exclusive minimum (e.g. duration ≤ 0)"),
    SCHEMA_REQUIRED: code("schema", "structural", "required field missing"),
    SCHEMA_ADDITIONAL: code("schema", "structural", "unknown field in a closed object (track, keyframe, marker, …)"),
    DUP_CLIP_ID: code("error", "semantic", "two clips share an id"),
    DUP_MEDIA_ID: code("error", "semantic", "two media entries share an id"),
    MEDIA_REQUIRED: code("error", "semantic", "video/audio/image/svg clip without a mediaId"),
    MEDIA_NOT_FOUND: code("error", "semantic", "mediaId names no media entry"),
    TRACK_ID_INVALID: code("error", "semantic", "lane id is not V<n> or A<n> (n ≥ 1)"),
    TRACK_KIND_MISMATCH: code("error", "semantic", "audio clip on a V lane, visual clip on an A lane, or a declared lane whose kind contradicts its letter"),
    DURATION_TOO_SHORT: code("error", "semantic", `clip shorter than MIN_DUR (${MIN_DUR} s) but above 0`),
    TRACK_UNDECLARED: code("warning", "semantic", "clip on a lane missing from tracks (or from the default lanes); the editor adds it"),
    DUP_TRACK_ID: code("warning", "semantic", "lane declared twice; the editor keeps the first"),
    DISABLED_TRACK_UNKNOWN: code("warning", "semantic", "disabledTracks names a lane that doesn't exist; the editor drops it"),
    IN_MISSING: code("warning", "semantic", "clip without `in`; the editor assumes 0"),
    MEDIA_KIND_MISMATCH: code("warning", "semantic", "clip kind can't play its media's kind"),
    MEDIA_OVERRUN: code("warning", "semantic", "source window (in + ∫speed dt) runs past media.duration"),
    LINK_DESYNC: code("warning", "semantic", "linkGroup members disagree on start/in/duration/speed/speed keyframes"),
    LEGACY_LINKED_ID: code("warning", "semantic", "pairwise linkedId (superseded by linkGroup; the editor turns the pair into a group)"),
    KEYFRAMES_UNSORTED: code("warning", "semantic", "keyframe channel not sorted by t"),
    KEYFRAME_OUT_OF_RANGE: code("warning", "semantic", "keyframe outside the clip beyond its anchor: one key per side may sit before 0 / past the end"),
    KEYFRAME_NOT_ANIMATABLE: code("warning", "semantic", "keyframes on a prop that can't be animated; ignored"),
    TRANSITION_TOO_LONG: code("warning", "semantic", "transitionIn/Out (or both together) longer than the clip"),
    TRANSITION_ALIAS: code("warning", "semantic", "legacy transition spelling (dissolve, wipe-left) or a {type:\"none\"} placeholder"),
    UNKNOWN_PROP: code("warning", "semantic", "props key the editor doesn't know; kept but inert"),
    UNKNOWN_CLIP_FIELD: code("warning", "semantic", "clip field the editor doesn't know; dropped on the next UI save"),
    FOLDER_NOT_FOUND: code("warning", "semantic", "folderId/parentId names no folder; the editor resets it"),
    WORK_AREA_INVALID: code("warning", "semantic", "outPoint ≤ inPoint; the editor clears both"),
  };

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const has = Object.hasOwn;
  const q = (s) => JSON.stringify(String(s));
  const num = (n) => String(+n.toFixed(4)); // 12.500000001 → "12.5" in messages

  function describe(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isFinite(v) ? "number " + v : String(v);
    if (typeof v === "string") return "string " + JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v);
    return typeof v;
  }
  /* JSON-value equality (enum / const). */
  function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && same(a[k], b[k]));
  }
  function distance(a, b) {
    if (Math.abs(a.length - b.length) > 2 || a.length > 64) return 3; // only near-misses of short names matter
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  /* Closest option within edit distance 2 (and shorter than the word itself). */
  function didYouMean(word, options) {
    if (typeof word !== "string") return undefined;
    let best, bestD = 3;
    for (const o of options) {
      if (typeof o !== "string") continue;
      const d = distance(word, o);
      if (d < bestD && d < word.length) { best = o; bestD = d; }
    }
    return best === undefined ? undefined : `did you mean ${q(best)}?`;
  }

  /* ── Layer 1: structural interpreter ── */
  const KEYWORDS = new Set(["$schema", "$id", "title", "description", "$defs", "$ref", "type", "enum",
    "const", "minimum", "maximum", "exclusiveMinimum", "required", "properties",
    "additionalProperties", "items", "default"]);
  const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
  const SEVERITIES = ["error", "warning"];
  const GRADED = ["type", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "required", "additionalProperties"];

  function isType(t, v) {
    switch (t) {
      case "null": return v === null;
      case "boolean": return typeof v === "boolean";
      case "string": return typeof v === "string";
      case "number": return typeof v === "number" && Number.isFinite(v);
      case "integer": return Number.isInteger(v);
      case "object": return isObj(v);
      case "array": return Array.isArray(v);
    }
    return false;
  }

  /* Check a schema against the subset and return run(value, out), which appends
     raw issues { code, severity, segs, message, hint } to out. */
  function compile(rootSchema) {
    const fail = (at, msg) => { throw new Error(`unsupported schema at ${at}: ${msg}`); };
    const refs = new Map();
    function resolve(ref, at) {
      if (refs.has(ref)) return refs.get(ref);
      let node = typeof ref === "string" && (ref === "#" || ref.startsWith("#/")) ? rootSchema : undefined;
      if (node && ref !== "#") for (const raw of ref.slice(2).split("/")) {
        let seg;
        try { seg = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { fail(at, `bad $ref ${q(ref)}`); }
        node = isObj(node) && has(node, seg) ? node[seg] : undefined;
      }
      if (!isObj(node)) fail(at, `$ref ${q(ref)} does not resolve to a local subschema`);
      refs.set(ref, node);
      return node;
    }
    const seen = new Set();
    function check(node, at) {
      if (!isObj(node)) fail(at, "a subschema must be an object (booleans only as additionalProperties)");
      if (seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("x-")) {
          if (k !== "x-severity") continue;
          const ok = typeof v === "string" ? SEVERITIES.includes(v)
            : isObj(v) && Object.entries(v).every(([kw, s]) => GRADED.includes(kw) && SEVERITIES.includes(s));
          if (!ok) fail(at, `x-severity must be "error", "warning" or {${GRADED.join("|")}: severity}`);
          continue;
        }
        if (!KEYWORDS.has(k)) fail(at, `keyword ${q(k)} is outside the supported subset`);
        if (k === "type" && !([].concat(v).length && [].concat(v).every((t) => TYPES.includes(t)))) fail(at, `bad type ${JSON.stringify(v)} (use ${TYPES.join("/")})`);
        else if (k === "enum" && !(Array.isArray(v) && v.length)) fail(at, "enum must be a non-empty array");
        else if ((k === "minimum" || k === "maximum" || k === "exclusiveMinimum") && !Number.isFinite(v)) fail(at, `${k} must be a number`);
        else if (k === "required" && !(Array.isArray(v) && v.every((r) => typeof r === "string"))) fail(at, "required must list strings");
        else if (k === "properties" || k === "$defs") {
          if (!isObj(v)) fail(at, `${k} must be an object`);
          for (const [name, sub] of Object.entries(v)) check(sub, `${at}/${k}/${name}`);
        } else if (k === "additionalProperties") { if (typeof v !== "boolean") check(v, `${at}/${k}`); }
        else if (k === "items") check(v, `${at}/items`);
        else if (k === "$ref") check(resolve(v, at), v);
      }
    }
    check(rootSchema, "#");
    // a $ref cycle that consumes no data would recurse forever at validate time
    for (const start of seen) {
      const chain = new Set();
      for (let n = start; n.$ref !== undefined; n = resolve(n.$ref)) {
        if (chain.has(n)) fail("#", `circular $ref ${q(n.$ref)}`);
        chain.add(n);
      }
    }

    function emit(out, code, severity, segs, message, hint) {
      out.push({ code, severity, segs, message, hint });
    }
    function run(node, v, segs, inherited, out) {
      const xs = node["x-severity"];
      const sev = typeof xs === "string" ? xs : inherited;
      const kw = isObj(xs) ? (k) => xs[k] || sev : () => sev;
      if (node.type !== undefined) {
        const types = [].concat(node.type);
        if (!types.some((t) => isType(t, v))) {
          if (typeof v === "number" && !Number.isFinite(v) && (types.includes("number") || types.includes("integer")))
            emit(out, "NON_FINITE", kw("type"), segs.slice(), `expected a finite number, got ${v}`);
          else emit(out, "SCHEMA_TYPE", kw("type"), segs.slice(), `expected ${types.join(" or ")}, got ${describe(v)}`);
          return; // one issue per value: skip enum/range/children of a mistyped value
        }
      }
      if (node.$ref !== undefined) run(resolve(node.$ref), v, segs, sev, out);
      if (node.enum && !node.enum.some((e) => same(e, v))) {
        const shown = node.enum.length > 8 ? node.enum.slice(0, 8).join(", ") + ", …" : node.enum.join(", ");
        emit(out, "SCHEMA_ENUM", kw("enum"), segs.slice(), `${describe(v)} is not one of: ${shown}`, didYouMean(v, node.enum));
      }
      if (has(node, "const") && !same(node.const, v))
        emit(out, "SCHEMA_CONST", kw("const"), segs.slice(), `must be ${JSON.stringify(node.const)}`);
      if (typeof v === "number") {
        if (node.minimum !== undefined && v < node.minimum)
          emit(out, "SCHEMA_MINIMUM", kw("minimum"), segs.slice(), `${v} is below the minimum ${node.minimum}`);
        if (node.maximum !== undefined && v > node.maximum)
          emit(out, "SCHEMA_MAXIMUM", kw("maximum"), segs.slice(), `${v} is above the maximum ${node.maximum}`);
        if (node.exclusiveMinimum !== undefined && v <= node.exclusiveMinimum)
          emit(out, "SCHEMA_EXCLUSIVE_MINIMUM", kw("exclusiveMinimum"), segs.slice(), `${v} must be greater than ${node.exclusiveMinimum}`);
      }
      if (isObj(v)) {
        if (node.required) for (const k of node.required)
          if (!has(v, k)) emit(out, "SCHEMA_REQUIRED", kw("required"), segs.concat(k), `missing required field ${q(k)}`);
        const props = node.properties, extra = node.additionalProperties;
        if (props || extra !== undefined) for (const k of Object.keys(v)) {
          segs.push(k);
          if (props && has(props, k)) run(props[k], v[k], segs, sev, out);
          else if (extra === false)
            emit(out, "SCHEMA_ADDITIONAL", kw("additionalProperties"), segs.slice(), `unknown field ${q(k)}`, didYouMean(k, Object.keys(props || {})));
          else if (isObj(extra)) run(extra, v[k], segs, sev, out);
          segs.pop();
        }
      }
      if (Array.isArray(v) && node.items) for (let i = 0; i < v.length; i++) {
        segs.push(i);
        run(node.items, v[i], segs, sev, out);
        segs.pop();
      }
    }
    return (value, out) => run(rootSchema, value, [], "error", out);
  }

  /* ── Issue formatting ── */
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const toPointer = (segs) => segs.map((s) => "/" + String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("");
  /* Array elements with a string id print as [id], others as [index]. */
  function toPath(doc, segs) {
    let out = "", cur = doc;
    for (const s of segs) {
      if (typeof s === "number") {
        const el = Array.isArray(cur) ? cur[s] : undefined;
        out += "[" + (isObj(el) && typeof el.id === "string" && el.id ? el.id : s) + "]";
      } else out += IDENT.test(s) ? (out ? "." : "") + s : "[" + JSON.stringify(s) + "]";
      cur = cur !== null && typeof cur === "object" ? cur[s] : undefined;
    }
    return out;
  }
  function cmpSegs(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const x = a[i], y = b[i];
      if (x === y) continue;
      if (typeof x === "number" && typeof y === "number") return x - y;
      return String(x) < String(y) ? -1 : 1;
    }
    return a.length - b.length;
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  function finish(doc, raw) {
    raw.sort((a, b) => cmpSegs(a.segs, b.segs) || cmp(a.code, b.code) || cmp(a.message, b.message));
    const out = [];
    let last = "";
    for (const r of raw) {
      const pointer = toPointer(r.segs);
      const key = r.code + " " + pointer + " " + r.message;
      if (key === last) continue; // e.g. a $ref and its sibling failing identically
      last = key;
      const issue = { severity: r.severity, code: r.code, path: toPath(doc, r.segs), pointer, message: r.message };
      if (r.hint) issue.hint = r.hint;
      out.push(issue);
    }
    return out;
  }

  /* Compile any schema in the subset (tests use this on custom schemas). */
  function compileSchema(schema) {
    const run = compile(schema);
    return Object.freeze({ validate: (value) => { const out = []; run(value, out); return finish(value, out); } });
  }

  /* ── Layer 2: semantic checks ── */
  const LANE = /^[VA][1-9]\d*$/;
  const DEFAULT_LANES = DEFS.project.properties.tracks.default.map((t) => t.id);
  const PROP_KEYS = Object.keys(DEFS.props.properties);
  const CLIP_KEYS = Object.keys(DEFS.clip.properties);
  const PLAYS = { video: ["video"], audio: ["audio", "video"], image: ["image"], svg: ["svg"] }; // clip kind → media kinds
  const ANIM = new Set(ANIMATABLE);
  const ALIAS = { dissolve: "fade", "wipe-left": "wipe" };
  const EPS = 1e-3;
  const laneHint = (id) => (LANE.test(id.trim().toUpperCase()) ? `use ${q(id.trim().toUpperCase())}` : undefined);
  const clampSpeed = (s) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, s));
  const baseSpeed = (c) => clampSpeed(+(isObj(c.props) ? c.props.speed : undefined) || 1);

  /* Media time at the clip's end: the editor's own mediaTimeAt (core/keyframes.js
     — same 1/120 s trapezoid grid), so the verdict matches playback.
     It runs on a probe clip: speed keys sorted like the editor does on load,
     and a private cache id, dropped afterwards so the validator neither keeps
     tables alive nor touches the UI's per-clip entries (in the browser both
     share one module). null = can't tell (malformed ramp, or over MAX_WORK). */
  const MAX_WORK = 2e7; // grid steps × keyframes (~2.3 h of a 10-key ramp); the validator also runs server-side
  const STEP = 1 / 120; // mediaTimeAt's grid
  const PROBE_ID = Symbol("validate"); // a cache key no clip id can collide with
  /* An ease named after an Object.prototype member ("constructor",
     "__proto__", …) is an enum error the schema layer reports; kfChannel runs
     it as linear (BUG-18), but the editor would not, so here it is "can't
     tell" — one owner per problem. */
  const inheritedEase = (k) => { const n = k.ease || "ease-in-out"; return !has(EASE, n) && EASE[n] !== undefined; };
  function sourceEnd(c, inn) {
    const d = c.duration;
    let kfs = isObj(c.keyframes) && Array.isArray(c.keyframes.speed) && c.keyframes.speed.length ? c.keyframes.speed : null;
    if (kfs) {
      if (!kfs.every((k) => isObj(k) && Number.isFinite(k.t) && Number.isFinite(k.v) && !inheritedEase(k))) return null;
      if (Math.max(2, Math.ceil(d / STEP) + 1) * kfs.length > MAX_WORK) return null;
      kfs = kfs.slice().sort((a, b) => a.t - b.t);
    }
    const probe = { id: PROBE_ID, start: 0, in: inn, duration: d,
      props: isObj(c.props) ? c.props : undefined, keyframes: kfs ? { speed: kfs } : undefined };
    try { return mediaTimeAt(probe, d); }
    finally { if (kfs) clearSpeedCache(PROBE_ID); }
  }
  /* What linked partners must agree on (syncLinkedTiming's fields). */
  function timing(c) {
    const ramp = isObj(c.keyframes) && Array.isArray(c.keyframes.speed) && c.keyframes.speed.length ? c.keyframes.speed : null;
    return { start: c.start, in: c.in === undefined ? 0 : c.in, duration: c.duration, speed: baseSpeed(c), "speed ramp": ramp };
  }
  const agree = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1e-6 : same(a, b));
  const show = (v) => (typeof v === "number" ? num(v) : v === null ? "none"
    : Array.isArray(v) ? `${v.length} keyframe${v.length === 1 ? "" : "s"}` : JSON.stringify(v));

  function semantic(doc, out) {
    if (!isObj(doc)) return;
    const add = (code, segs, message, hint) => out.push({ code, severity: CODES[code].severity, segs, message, hint });
    const media = Array.isArray(doc.media) ? doc.media : [];
    const clips = Array.isArray(doc.clips) ? doc.clips : [];

    const mediaById = new Map();
    media.forEach((m, i) => {
      if (!isObj(m) || typeof m.id !== "string") return;
      if (mediaById.has(m.id)) add("DUP_MEDIA_ID", ["media", i, "id"], `media id ${q(m.id)} is already used by media #${mediaById.get(m.id).i}`);
      else mediaById.set(m.id, { m, i });
    });

    const folders = Array.isArray(doc.folders) ? doc.folders.filter(isObj) : [];
    const folderIds = new Set(folders.map((f) => f.id).filter((id) => typeof id === "string"));
    const noFolder = (id) => typeof id === "string" && id !== "" && !folderIds.has(id);
    (Array.isArray(doc.folders) ? doc.folders : []).forEach((f, i) => {
      if (isObj(f) && noFolder(f.parentId)) add("FOLDER_NOT_FOUND", ["folders", i, "parentId"], `no folder has id ${q(f.parentId)}`);
    });
    media.forEach((m, i) => {
      if (isObj(m) && noFolder(m.folderId)) add("FOLDER_NOT_FOUND", ["media", i, "folderId"], `no folder has id ${q(m.folderId)}`);
    });

    // lanes: declared ones, or the defaults when tracks is absent/empty (like applyTracksFromProject)
    const declared = Array.isArray(doc.tracks) && doc.tracks.length ? doc.tracks : null;
    const lanes = new Set(declared ? [] : DEFAULT_LANES);
    const declaredIds = new Set();
    if (declared) declared.forEach((t, i) => {
      if (!isObj(t) || typeof t.id !== "string") return; // layer 1 reports it
      if (!LANE.test(t.id)) add("TRACK_ID_INVALID", ["tracks", i, "id"], `lane id ${q(t.id)} is not V<n> or A<n>`, laneHint(t.id));
      else if ((t.kind === "audio" || t.kind === "video") && (t.kind === "audio") !== (t.id[0] === "A"))
        add("TRACK_KIND_MISMATCH", ["tracks", i, "kind"], `lane ${t.id} is declared ${t.kind}, but ${t.id[0]} lanes are ${t.id[0] === "A" ? "audio" : "video"}`);
      if (declaredIds.has(t.id)) add("DUP_TRACK_ID", ["tracks", i, "id"], `lane ${t.id} is declared twice; the editor keeps the first`);
      declaredIds.add(t.id);
      if (t.kind === "audio" || t.kind === "video") lanes.add(t.id); // other kinds are dropped on load
    });

    const clipIdx = new Map();
    const groups = new Map();
    const onLanes = new Set(); // valid lanes clips sit on — the editor creates missing ones
    clips.forEach((c, i) => {
      if (!isObj(c)) return;
      const at = (...s) => ["clips", i, ...s];
      if (typeof c.id === "string") {
        if (clipIdx.has(c.id)) add("DUP_CLIP_ID", at("id"), `clip id ${q(c.id)} is already used by clip #${clipIdx.get(c.id)}`);
        else clipIdx.set(c.id, i);
      }
      for (const k of Object.keys(c)) if (!has(DEFS.clip.properties, k))
        add("UNKNOWN_CLIP_FIELD", at(k), `unknown clip field ${q(k)}; the next UI save drops it`,
          has(DEFS.props.properties, k) ? `${q(k)} is a prop — move it into props` : didYouMean(k, CLIP_KEYS));
      if (!has(c, "in")) add("IN_MISSING", at("in"), "clip has no \"in\"; the editor assumes 0", "add \"in\": 0");
      if (has(c, "linkedId")) add("LEGACY_LINKED_ID", at("linkedId"), "pairwise linkedId is legacy; the editor turns the pair into a linkGroup on load", "give the partners a shared linkGroup instead");
      const kind = CLIP_KINDS.includes(c.kind) ? c.kind : null; // unknown kinds: layer 1

      if (typeof c.track === "string") {
        if (!LANE.test(c.track)) add("TRACK_ID_INVALID", at("track"), `lane id ${q(c.track)} is not V<n> or A<n>`, laneHint(c.track));
        else {
          if (kind && (kind === "audio") !== (c.track[0] === "A"))
            add("TRACK_KIND_MISMATCH", at("track"), kind === "audio" ? `audio clip on video lane ${c.track}` : `${kind} clip on audio lane ${c.track}`);
          if (!lanes.has(c.track) && !onLanes.has(c.track))
            add("TRACK_UNDECLARED", at("track"), `lane ${c.track} is not ${declared ? "declared in tracks" : "a default lane (V3…V1, A1…A4)"}; the editor adds it on load`,
              `add {"id":"${c.track}","kind":"${c.track[0] === "A" ? "audio" : "video"}"} to tracks`);
          onLanes.add(c.track);
        }
      }

      const d = typeof c.duration === "number" && Number.isFinite(c.duration) && c.duration > 0 ? c.duration : null;
      if (d !== null && d < MIN_DUR - 1e-6) add("DURATION_TOO_SHORT", at("duration"), `duration ${d} is below the ${MIN_DUR} s minimum`);

      if (kind && has(PLAYS, kind)) {
        const mid = c.mediaId;
        if (mid === undefined || mid === null || mid === "") add("MEDIA_REQUIRED", at("mediaId"), `${kind} clip has no mediaId`);
        else if (typeof mid === "string") {
          const hit = mediaById.get(mid);
          if (!hit) add("MEDIA_NOT_FOUND", at("mediaId"), `no media entry has id ${q(mid)}`, didYouMean(mid, [...mediaById.keys()]));
          else if (typeof hit.m.kind === "string" && !PLAYS[kind].includes(hit.m.kind))
            add("MEDIA_KIND_MISMATCH", at("mediaId"), `${kind} clip plays ${hit.m.kind} media ${q(mid)}`);
          else if ((kind === "video" || kind === "audio") && d !== null && typeof hit.m.duration === "number" && hit.m.duration > 0) {
            const inn = c.in === undefined ? 0 : c.in;
            const end = typeof inn === "number" && Number.isFinite(inn) ? sourceEnd(c, inn) : null;
            if (end !== null && end > hit.m.duration + EPS) {
              const fit = (hit.m.duration - inn) / baseSpeed(c);
              add("MEDIA_OVERRUN", at(), `source window ${num(inn)}–${num(end)} s runs past the end of ${q(mid)} (${num(hit.m.duration)} s)`,
                fit > 0 && !timing(c)["speed ramp"] ? `at in ${num(inn)} the clip can last ${num(fit)} s` : "lower in or shorten the clip");
            }
          }
        }
      }

      if (typeof c.linkGroup === "string" && c.linkGroup) {
        if (!groups.has(c.linkGroup)) groups.set(c.linkGroup, []);
        groups.get(c.linkGroup).push({ c, i });
      }

      if (isObj(c.keyframes)) for (const [ch, arr] of Object.entries(c.keyframes)) {
        if (!ANIM.has(ch)) add("KEYFRAME_NOT_ANIMATABLE", at("keyframes", ch), `${q(ch)} can't be keyframed; the editor ignores this channel`, didYouMean(ch, ANIMATABLE));
        if (!Array.isArray(arr)) continue;
        let prevT = -Infinity, unsorted = false;
        const before = [], after = []; // [t, j] of the keys outside the clip
        arr.forEach((k, j) => {
          if (!isObj(k) || typeof k.t !== "number" || !Number.isFinite(k.t)) return;
          if (k.t < prevT) unsorted = true;
          prevT = k.t;
          if (k.t < -EPS) before.push([k.t, j]);
          else if (d !== null && k.t > d + EPS) after.push([k.t, j]);
        });
        // D4: the nearest key outside each edge is an anchor (it shapes the
        // curve there, and splits / trims keep it); the ones beyond it are not
        const anchor = (list, nearest) => list.reduce((a, b) => (nearest(b[0], a[0]) ? b : a), list[0]);
        if (before.length) {
          const [ta, ja] = anchor(before, (x, y) => x > y);
          for (const [t, j] of before) if (j !== ja) add("KEYFRAME_OUT_OF_RANGE", at("keyframes", ch, j, "t"),
            `keyframe at ${num(t)} s is before the clip start, beyond the anchor at ${num(ta)} s`, "one key before 0 is enough to shape the start; drop the others");
        }
        if (after.length) {
          const [ta, ja] = anchor(after, (x, y) => x < y);
          for (const [t, j] of after) if (j !== ja) add("KEYFRAME_OUT_OF_RANGE", at("keyframes", ch, j, "t"),
            `keyframe at ${num(t)} s is past the clip's end (${num(d)} s), beyond the anchor at ${num(ta)} s`, "one key past the end is enough to shape the end; drop the others");
        }
        if (unsorted) add("KEYFRAMES_UNSORTED", at("keyframes", ch), `${q(ch)} keyframes are not in t order`, "sort them by t");
      }

      const tr = { transitionIn: 0, transitionOut: 0 };
      for (const side of ["transitionIn", "transitionOut"]) {
        const t = c[side];
        if (!isObj(t)) continue;
        if (t.type === "none") { add("TRANSITION_ALIAS", at(side), `${side} {type:"none"} draws nothing`, `remove ${side} or set it to null`); continue; }
        if (typeof t.type === "string" && has(ALIAS, t.type)) add("TRANSITION_ALIAS", at(side, "type"), `${q(t.type)} is a legacy alias of ${q(ALIAS[t.type])}`, `use ${q(ALIAS[t.type])}`);
        tr[side] = typeof t.duration === "number" && Number.isFinite(t.duration) && t.duration > 0 ? t.duration : 0;
        if (d !== null && tr[side] > d + EPS) add("TRANSITION_TOO_LONG", at(side, "duration"), `${side} (${num(tr[side])} s) is longer than the clip (${num(d)} s)`);
      }
      if (d !== null && tr.transitionIn <= d + EPS && tr.transitionOut <= d + EPS && tr.transitionIn + tr.transitionOut > d + EPS)
        add("TRANSITION_TOO_LONG", at("transitionOut", "duration"), `transitionIn + transitionOut (${num(tr.transitionIn + tr.transitionOut)} s) overlap inside the clip (${num(d)} s)`);

      if (isObj(c.props)) for (const k of Object.keys(c.props)) if (!has(DEFS.props.properties, k))
        add("UNKNOWN_PROP", at("props", k), `unknown prop ${q(k)}; kept, but the editor ignores it`,
          has(DEFS.clip.properties, k) ? `${q(k)} is a clip field, not a prop — move it out of props` : didYouMean(k, PROP_KEYS));
    });

    // link groups: the picture (else the first member) is the reference
    for (const [lg, members] of groups) {
      if (members.length < 2) continue;
      const ref = members.find((m) => m.c.kind === "video") || members[0];
      const want = timing(ref.c);
      for (const m of members) {
        if (m === ref) continue;
        const got = timing(m.c);
        const diff = Object.keys(want).filter((k) => !agree(want[k], got[k])).map((k) =>
          (Array.isArray(want[k]) && Array.isArray(got[k]) ? `${k} differs` : `${k} ${show(got[k])} ≠ ${show(want[k])}`));
        if (diff.length) add("LINK_DESYNC", ["clips", m.i], `linkGroup ${q(lg)} out of sync with ${ref.c.id}: ${diff.join(", ")}`,
          "linked picture and stems must share start, in, duration and speed");
      }
    }

    if (Array.isArray(doc.disabledTracks)) doc.disabledTracks.forEach((id, i) => {
      if (typeof id === "string" && !lanes.has(id) && !onLanes.has(id))
        add("DISABLED_TRACK_UNKNOWN", ["disabledTracks", i], `lane ${q(id)} doesn't exist; the editor drops it`);
    });

    const a = doc.inPoint, b = doc.outPoint;
    if (Number.isFinite(a) && Number.isFinite(b) && b <= a)
      add("WORK_AREA_INVALID", ["outPoint"], `outPoint ${num(b)} is not after inPoint ${num(a)}; the editor clears both`);
  }

  /* ── Public API ── */
  const runProject = compile(PROJECT_SCHEMA); // throws at load if the schema leaves the subset

  /* Layer 1 only (the schema contract; the ajv differential test compares this). */
  function validateStructure(doc) {
    const out = [];
    runProject(doc, out);
    return finish(doc, out);
  }
  function validateProject(doc) {
    const out = [];
    runProject(doc, out);
    semantic(doc, out);
    return finish(doc, out);
  }

  const issueKey = (issue) => issue.code + " " + issue.path;
  /* Errors in `after` that `before` didn't have (counted per key, so a second
     duplicate id is new even when the first one was already on disk). */
  function newErrors(before, after) {
    const had = new Map();
    for (const i of before || []) if (i.severity === "error") had.set(issueKey(i), (had.get(issueKey(i)) || 0) + 1);
    return (after || []).filter((i) => {
      if (i.severity !== "error") return false;
      const n = had.get(issueKey(i)) || 0;
      if (n) had.set(issueKey(i), n - 1);
      return !n;
    });
  }
  /* One line per issue, errors first: "error SCHEMA_MAXIMUM clips[c_a].props.speed: 9 is above … — hint". */
  function formatIssues(issues, { limit = 10 } = {}) {
    const list = (issues || []).slice().sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
    const lines = list.slice(0, limit).map((i) =>
      `${i.severity} ${i.code} ${i.path || "(root)"}: ${i.message}${i.hint ? " — " + i.hint : ""}`);
    if (list.length > limit) lines.push(`… +${list.length - limit} more`);
    return lines.join("\n");
  }

  const deepFreeze = (o) => {
    if (o && (typeof o === "object" || typeof o === "function") && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  return deepFreeze({
    CODES,
    validateProject, validateStructure, compileSchema,
    issueKey, newErrors, formatIssues,
  });
});
