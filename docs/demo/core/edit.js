/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — timeline edit operations: split, trim, close gaps, delete,
   and the math of the clip drag gestures (move / trim-l / trim-r).

   Dual-mode classic script, loaded after core/schema.js, core/keyframes.js and
   core/links.js: a <script> tag exposes FableCore.edit, Node require()s it.
   No DOM and no app state: every operation takes the project document `doc`
   and changes it IN PLACE. Untouched clip objects keep their identity (the
   app keys media elements by clip id, and gestures hold clip references);
   new pieces are pushed onto doc.clips, and removals re-assign doc.clips to
   a filtered copy. app.js keeps its old names and signatures (splitAtPlayhead,
   trimToWorkArea, closeGapAtPlayhead, …) as thin wrappers that read the
   playhead / selection / lanes, call in here, and own every side effect:
   undo, save, toasts, inspector, selection, media-element release.

   ctx — what the app supplies (explicit, never read from globals):
     newId()          fresh clip id ("c_…"), called once per new piece
     newLinkId()      fresh linkGroup id ("lg_…")
     isEnabled(lane)  is a track enabled? (disabled lanes are skipped where
                      noted; required — there is no "all enabled" default)
     minDur           shortest clip an edit may leave (default MIN_DUR)
     beforeChange()   optional; called once, right before an operation first
                      writes to doc — the app records its undo snapshot here,
                      so the snapshot is always the pre-edit state
   Id factories are called in a fixed order (clips in doc order, cuts right to
   left, then link ids), so a deterministic factory gives deterministic ids.

   Results — every operation returns a fresh record:
     changed   the operation went ahead (beforeChange was called)
     created   clip objects it added, in creation order
     removed   ids of clips it removed
     reason    why it did not go ahead: a short code the app maps to its own
               toast text — "no-markers", "nothing", "no-lanes", "covered",
               "no-clip", "at-start", "no-media"
   plus op-specific fields (trackId, gap, trimmed; a split's `from`: the id
   of the clip each created piece was cut from, aligned with `created`).
   closeGapMessage(r) is the editor's wording for a closeGapAt result — app.js
   toasts it, the patch op closeGap throws it (one source for both).

   Link groups (docs/specs/0001, D2): split, delete, close gap, trim to IN/OUT,
   trims, edge drags and inspector timing edits act on whole link groups,
   members on disabled lanes included — a disabled lane is hidden from
   preview and export, not unlinked. A trim applies the same edge change to
   every member, and each re-bases its OWN keyframes (a stem's volume fade
   keeps its place); start / in / duration / speed are then shared.

   Source time (docs/specs/0001, D5 / D6): every new edge of a timed clip
   (video, audio, svg — schema TIMED_KINDS) takes `in` from mediaTimeAt of
   the clip as it was, so speed ramps and svg animations stay continuous;
   image/text/adjust keep in == 0.

   A cut changes nothing that plays (D4 / D6): every split and trim re-bases
   keyframes with shiftKF, which keeps one anchor key per side outside the
   new piece, so each curve — speed ramps included — keeps its exact shape;
   extending a head plays the curve before 0 (keyframes headRamp). Pieces
   own deep copies of props and keyframes. Transitions fit what is left:
   a split and a keyboard trim drop the cut edge's transition, an edge drag
   keeps it; then each ≤ duration and both together ≤ duration, shortening
   the edited edge's first. An edit that would change nothing is refused
   before beforeChange, so it records no undo step.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports)
    module.exports = factory(require("./schema.js"), require("./keyframes.js"), require("./links.js"));
  else {
    const core = root.FableCore || {};
    if (!core.schema) throw new Error("core/schema.js must load before core/edit.js");
    if (!core.keyframes) throw new Error("core/keyframes.js must load before core/edit.js");
    if (!core.links) throw new Error("core/links.js must load before core/edit.js");
    root.FableCore.edit = factory(core.schema, core.keyframes, core.links);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (S, K, L) {
  "use strict";
  const { MIN_DUR, TIMED_KINDS } = S;
  const { clipEnd, shiftKF, mediaTimeAt, durationUntil, headRamp } = K;
  const { withLinked, syncLinkedTiming, relinkSplitRights } = L;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v)); // app.js clamp (same NaN behavior)
  const GAP_EPS = 1e-4; // gaps (and gap edges) closer than this count as none

  /* ── Helpers ── */
  function need(ctx, key) {
    const f = ctx && ctx[key];
    if (typeof f !== "function") throw new TypeError(`FableCore.edit: ctx.${key} must be a function`);
    return f;
  }
  const minDurOf = (ctx) => (ctx && ctx.minDur != null ? ctx.minDur : MIN_DUR);
  /* A deep copy of plain JSON props: no two clips may share an array or
     object (fontCutSet) — editing one would silently edit the other. */
  const copyProps = (p) => (p ? JSON.parse(JSON.stringify(p)) : p);
  const done = (extra) => ({ changed: true, created: [], removed: [], ...extra });
  const refused = (reason, extra) => ({ changed: false, created: [], removed: [], reason, ...extra });
  const begin = (ctx) => { if (ctx && typeof ctx.beforeChange === "function") ctx.beforeChange(); };
  /* t falls strictly inside c, at least minDur from either edge */
  const inside = (c, t, minDur) => t > c.start + minDur && t < clipEnd(c) - minDur;
  const isMediaKind = (c) => c.kind === "video" || c.kind === "audio"; // has a media end
  /* `in` is a source position (D5): the other kinds keep in == 0 */
  const isTimed = (c) => TIMED_KINDS.includes(c.kind);
  /* A pre-edit copy of c for mediaTimeAt, cached under a slot no clip id can
     take (a drag re-reads it on every pointermove) */
  const PROBE = Symbol("edit");
  const probeOf = (c, o) => ({ id: PROBE, start: o.start, in: o.in, duration: o.duration, props: c.props, keyframes: o.keyframes });
  /* Transitions fit the clip after an edit that shortened it (D6, BUG-16 /
     BUG-22): each ≤ duration and both together ≤ duration. What has to go
     comes off the edited edge's transition first ("in" | "out"), then the
     other one; one squeezed to nothing is removed. Shortened ones are new
     objects, so a piece never shares one with the clip it came from. */
  const trLen = (tr) => (tr && Number.isFinite(tr.duration) && tr.duration > 0 ? tr.duration : 0);
  function fitTransitions(c, edge) {
    let over = trLen(c.transitionIn) + trLen(c.transitionOut) - c.duration;
    for (const side of edge === "in" ? ["transitionIn", "transitionOut"] : ["transitionOut", "transitionIn"]) {
      const len = trLen(c[side]);
      if (!(over > 0) || !len) continue;
      const cut = Math.min(len, over);
      c[side] = len - cut > 0 ? { ...c[side], duration: len - cut } : undefined;
      over -= cut;
    }
  }

  /* ── Split ── */
  /* Cut c at timeline time t (strictly inside, ≥ minDur from both edges):
     c keeps the left piece, the right piece is pushed onto doc.clips and
     returned (null when t is not inside). A primitive: no beforeChange, no
     relinking — the ops below do both. */
  function splitClipAt(doc, c, t, ctx) {
    const newId = need(ctx, "newId");
    if (!inside(c, t, minDurOf(ctx))) return null;
    const cut = t - c.start;
    const right = {
      ...c, id: newId(), props: copyProps(c.props), // own arrays too (BUG-15)
      start: t, in: isTimed(c) ? mediaTimeAt(c, t) : 0, duration: clipEnd(c) - t, // the source under the cut (BUG-12, BUG-19)
      keyframes: shiftKF(c.keyframes, cut, clipEnd(c) - t),
      transitionIn: undefined,
      linkedId: undefined,
      linkGroup: undefined,
    };
    c.duration = cut;
    c.keyframes = shiftKF(c.keyframes, 0, cut);
    c.transitionOut = undefined;
    fitTransitions(c, "out"); // each piece keeps its outer edge's transition, shortened to fit
    fitTransitions(right, "in");
    doc.clips.push(right);
    return right;
  }
  /* Split every clip in `targets` that t falls inside; the right halves of
     linked partners get linked to each other. → Map: cut clip's id → its new
     right piece, in creation order. */
  function splitSet(doc, targets, t, ctx) {
    const newLink = new Map(); // oldClipId -> right half
    for (const c of targets) {
      const right = splitClipAt(doc, c, t, ctx);
      if (right) newLink.set(c.id, right);
    }
    relinkSplitRights(targets, newLink, ctx);
    return newLink;
  }
  /* Split at the playhead: the selected clips (selIds, a Set, when non-empty)
     or every clip, plus their linked partners, on any lane. */
  function splitAt(doc, t, { selIds } = {}, ctx) {
    need(ctx, "newId"); need(ctx, "newLinkId");
    const minDur = minDurOf(ctx);
    const picked = selIds && selIds.size ? doc.clips.filter((c) => selIds.has(c.id)) : doc.clips;
    const targets = withLinked(doc.clips, picked.filter((c) => inside(c, t, minDur)));
    if (!targets.length) return refused("nothing");
    begin(ctx);
    const pieces = splitSet(doc, targets, t, ctx);
    return done({ created: [...pieces.values()], from: [...pieces.keys()] });
  }
  /* Split every clip on an enabled lane that crosses one of `times` (null
     entries — an unset IN or OUT marker — are ignored), plus the linked
     partners of those clips on any lane. No head/tail removal. */
  function splitAtTimes(doc, times, ctx) {
    need(ctx, "newId"); need(ctx, "newLinkId");
    const isEnabled = need(ctx, "isEnabled");
    const minDur = minDurOf(ctx);
    const ts = times.filter((t) => t != null);
    if (!ts.length) return refused("no-markers");
    const targets = withLinked(doc.clips, doc.clips.filter((c) =>
      isEnabled(c.track) && ts.some((t) => inside(c, t, minDur))
    ));
    if (!targets.length) return refused("nothing");
    begin(ctx);
    const created = [], from = [];
    // Right-to-left so each successive cut still lands on the left-hand piece
    for (const t of ts.slice().sort((a, b) => b - a)) {
      const pieces = splitSet(doc, targets.filter((c) => inside(c, t, minDur)), t, ctx);
      created.push(...pieces.values());
      from.push(...pieces.keys());
    }
    return done({ created, from });
  }

  /* ── Trim ── */
  /* Trim c's head ("in") or tail ("out") to timeline time t, with its whole
     link group — the keyboard trim (trim to playhead). It acts like a cut
     (D6): every member re-bases its own keyframes (D4 anchors, BUG-14a) and
     loses the trimmed edge's transition (BUG-14b); the other transition is
     fitted to the shorter clip (BUG-22). Refused — no beforeChange, so no
     undo step (BUG-14d) — for a missing clip ("no-clip"), an "in" trim
     at/before the start ("at-start"), or a t that leaves nothing to trim or
     under minDur ("nothing"). → trimmed: whether it went ahead. */
  function trimClipTo(doc, c, t, side, ctx) {
    const minDur = minDurOf(ctx);
    if (!c) return refused("no-clip", { trimmed: false });
    if (t <= c.start && side === "in") return refused("at-start", { trimmed: false });
    const ok = side === "in" ? t < clipEnd(c) - minDur : side === "out" && t > c.start + minDur && t < clipEnd(c);
    if (!ok) return refused("nothing", { trimmed: false });
    begin(ctx);
    const group = withLinked(doc.clips, [c]);
    const d = side === "in" ? t - c.start : 0;
    const dur = side === "in" ? clipEnd(c) - t : t - c.start;
    if (side === "in") c.in = isTimed(c) ? mediaTimeAt(c, t) : 0; // before the keys move
    for (const x of group) {
      x.keyframes = shiftKF(x.keyframes, d, dur);
      x[side === "in" ? "transitionIn" : "transitionOut"] = undefined;
    }
    if (side === "in") c.start = t;
    c.duration = dur;
    syncLinkedTiming(doc.clips, c);
    for (const x of group) fitTransitions(x, side);
    return done({ trimmed: true });
  }
  /* Trim to the work area: on enabled lanes, drop clip heads before inPoint
     and tails after outPoint (either may be null = open), and remove clips
     that would be left shorter than minDur. Linked partners go with them,
     on any lane. Trimmed edges lose their transition and keyframes are
     re-based. */
  function trimToRange(doc, inPoint, outPoint, ctx) {
    const isEnabled = need(ctx, "isEnabled");
    const minDur = minDurOf(ctx);
    if (inPoint == null && outPoint == null) return refused("no-markers");
    const span = (c) => {
      let t0 = c.start, t1 = clipEnd(c);
      if (inPoint != null) t0 = Math.max(t0, inPoint);
      if (outPoint != null) t1 = Math.min(t1, outPoint);
      return [t0, t1];
    };
    const targets = new Set(withLinked(doc.clips, doc.clips.filter((c) => isEnabled(c.track))));
    const willChange = [...targets].some((c) => {
      const [t0, t1] = span(c);
      return t1 - t0 < minDur || t0 > c.start + 1e-6 || t1 < clipEnd(c) - 1e-6;
    });
    if (!willChange) return refused("nothing");
    begin(ctx);
    const doomed = new Set();
    for (const c of doc.clips) {
      if (!targets.has(c)) continue;
      const [t0, t1] = span(c);
      if (t1 - t0 < minDur) { doomed.add(c.id); continue; }
      const dIn = t0 - c.start;
      if (dIn > 1e-6) {
        c.in = isTimed(c) ? mediaTimeAt(c, t0) : 0;
        c.start = t0;
        c.duration -= dIn;
        c.keyframes = shiftKF(c.keyframes, dIn, c.duration);
        c.transitionIn = undefined;
      }
      if (clipEnd(c) - t1 > 1e-6) {
        c.duration = Math.max(minDur, t1 - c.start);
        c.keyframes = shiftKF(c.keyframes, 0, c.duration);
        c.transitionOut = undefined;
      }
      fitTransitions(c, dIn > 1e-6 ? "in" : "out");
    }
    if (doomed.size) doc.clips = doc.clips.filter((c) => !doomed.has(c.id));
    return done({ removed: [...doomed] });
  }

  /* ── Gaps ── */
  /* The gap on one lane around time t: { gapStart, gapEnd }, or null when a
     clip covers t. Empty lane → [0, Infinity]; trailing void → gapEnd Infinity. */
  function gapAt(doc, trackId, t) {
    const clips = doc.clips.filter((c) => c.track === trackId).sort((a, b) => a.start - b.start);
    for (const c of clips) {
      if (c.start <= t && t < clipEnd(c)) return null;
    }
    let gapStart = 0;
    for (const c of clips) {
      if (clipEnd(c) <= t) gapStart = Math.max(gapStart, clipEnd(c));
    }
    let gapEnd = Infinity;
    for (const c of clips) {
      if (c.start > t) gapEnd = Math.min(gapEnd, c.start);
    }
    return { gapStart, gapEnd };
  }
  /* Sync-safe close, planned: every lane in laneIds (the enabled lanes, in
     display order — the first covered one is reported) must have a gap at t;
     the intersection of those gaps closes by shifting every later clip on an
     enabled lane left, with its linked partners on any lane.
     → { ok, reason?, trackId?, gap, movers } */
  function planCloseGap(doc, t, laneIds, ctx) {
    const isEnabled = need(ctx, "isEnabled");
    if (!laneIds.length) return { ok: false, reason: "no-lanes" };
    let L = 0, R = Infinity;
    for (const id of laneIds) {
      const g = gapAt(doc, id, t);
      if (!g) return { ok: false, reason: "covered", trackId: id };
      L = Math.max(L, g.gapStart);
      R = Math.min(R, g.gapEnd);
    }
    const G = R - L;
    if (!isFinite(R) || G <= GAP_EPS) return { ok: false, reason: "nothing" };
    const movers = withLinked(doc.clips, doc.clips.filter((c) => isEnabled(c.track) && c.start >= R - GAP_EPS));
    if (!movers.length) return { ok: false, reason: "nothing" };
    return { ok: true, gap: G, movers };
  }
  /* Close the aligned gap at t (see planCloseGap). → gap: the seconds closed */
  function closeGapAt(doc, t, laneIds, ctx) {
    const plan = planCloseGap(doc, t, laneIds, ctx);
    if (!plan.ok) return refused(plan.reason, plan.trackId ? { trackId: plan.trackId } : undefined);
    begin(ctx);
    for (const c of plan.movers) c.start = Math.max(0, c.start - plan.gap);
    return done({ gap: plan.gap });
  }
  /* The editor's words for a closeGapAt result: the toast after a close, or
     why nothing closed (the first covered lane is named). */
  function closeGapMessage(r) {
    if (r.changed) return `Closed ${r.gap >= 1 ? r.gap.toFixed(2) : r.gap.toFixed(3)}s gap`;
    return r.reason === "no-lanes" ? "No enabled tracks"
      : r.reason === "covered" ? `No gap on ${r.trackId} — disable the track or move the playhead`
        : "Nothing to close at playhead";
  }
  /* Aligned gaps (the closeGapAt notion) inside [t0, t1], sorted: [{ L, R }]. */
  function listAlignedGaps(doc, t0, t1, laneIds, ctx) {
    const isEnabled = need(ctx, "isEnabled");
    if (!laneIds.length || t1 - t0 <= GAP_EPS) return [];
    const edges = new Set([t0, t1]);
    for (const c of doc.clips) {
      if (!isEnabled(c.track)) continue;
      const s = c.start, e = clipEnd(c);
      if (s > t0 && s < t1) edges.add(s);
      if (e > t0 && e < t1) edges.add(e);
    }
    const ts = [...edges].sort((a, b) => a - b);
    const gaps = [];
    const seen = new Set();
    for (let i = 0; i < ts.length - 1; i++) {
      const a = ts[i], b = ts[i + 1];
      if (b - a <= GAP_EPS) continue;
      const mid = (a + b) / 2;
      let L = -Infinity, R = Infinity;
      let ok = true;
      for (const id of laneIds) {
        const g = gapAt(doc, id, mid);
        if (!g) { ok = false; break; }
        L = Math.max(L, g.gapStart);
        R = Math.min(R, g.gapEnd);
      }
      if (!ok) continue;
      L = Math.max(L, t0);
      R = Math.min(isFinite(R) ? R : t1, t1);
      if (R - L <= GAP_EPS) continue;
      const key = L.toFixed(5) + ":" + R.toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      gaps.push({ L, R });
    }
    gaps.sort((a, b) => a.L - b.L);
    return gaps;
  }
  /* The gap "next gap" jumps to from time t: the first aligned gap in
     [t0, t1] whose middle lies after t, else the first one (wraps).
     → { gap: {L, R} } or { gap: null, reason: "empty-range" | "no-gaps" } */
  function nextGap(doc, t0, t1, t, laneIds, ctx) {
    if (t1 - t0 <= GAP_EPS) return { gap: null, reason: "empty-range" };
    const gaps = listAlignedGaps(doc, t0, t1, laneIds, ctx);
    if (!gaps.length) return { gap: null, reason: "no-gaps" };
    return { gap: gaps.find((x) => (x.L + x.R) / 2 > t + GAP_EPS) || gaps[0] };
  }

  /* ── Delete ── */
  /* Remove `list` and every clip linked to it. */
  function removeClips(doc, list, ctx) {
    const doomed = withLinked(doc.clips, list);
    if (!doomed.length) return refused("nothing");
    begin(ctx);
    const ids = new Set(doomed.map((c) => c.id));
    doc.clips = doc.clips.filter((x) => !ids.has(x.id));
    return done({ removed: [...ids] });
  }
  /* The bin's delete: media entry `mediaId` and every clip that uses it. */
  function removeMedia(doc, mediaId, ctx) {
    if (!(doc.media || []).some((m) => m.id === mediaId)) return refused("no-media");
    begin(ctx);
    const removed = doc.clips.filter((c) => c.mediaId === mediaId).map((c) => c.id);
    doc.media = doc.media.filter((m) => m.id !== mediaId);
    doc.clips = doc.clips.filter((c) => c.mediaId !== mediaId);
    return done({ removed });
  }

  /* ── Inspector timing ── */
  /* Set c's start and/or duration (fields left undefined keep their value)
     for its whole link group: start ≥ 0 and duration ≥ minDur (a non-number
     counts as 0), then the partners take c's in and speed as well. Keyframes
     stay clip-local, as typed: a shorter length keeps the keys past the end,
     so typing "1" on the way to "10" loses nothing. Refused "nothing" when
     no member would change. */
  function setClipTiming(doc, c, { start, duration } = {}, ctx) {
    if (!c) return refused("no-clip");
    const num = (v) => (Number.isFinite(+v) ? +v : 0);
    const s = start === undefined ? c.start : Math.max(0, num(start));
    const d = duration === undefined ? c.duration : Math.max(minDurOf(ctx), num(duration));
    const group = withLinked(doc.clips, [c]);
    if (group.every((x) => x.start === s && x.duration === d)) return refused("nothing");
    begin(ctx);
    c.start = s;
    c.duration = d;
    syncLinkedTiming(doc.clips, c);
    return done();
  }

  /* ── Source replaced ── */
  /* c's media was swapped for a file `end` seconds long: cap `in` inside it,
     then cut the duration where c's source window — speed ramp included —
     reaches `end` (BUG-27), like a trim-r: keys past the new end keep one
     anchor (D4) and the transitions fit (D6). No beforeChange (the app's
     replace records its own undo step). → did it trim? */
  function capToSource(c, end, ctx) {
    let trimmed = false;
    const maxIn = Math.max(0, end - 0.001);
    if (c.in > maxIn) { c.in = maxIn; trimmed = true; }
    const maxDur = Math.max(minDurOf(ctx), durationUntil(c, end));
    if (c.duration > maxDur) {
      c.duration = maxDur;
      c.keyframes = shiftKF(c.keyframes, 0, maxDur);
      fitTransitions(c, "out");
      trimmed = true;
    }
    return trimmed;
  }

  /* ── Clip drag gestures ──
     beginDrag captures the originals at pointerdown; dragTo re-applies the
     gesture from them for the pointer's total offset dt (seconds), so every
     pointermove is absolute, never incremental. A trim-r also caches its
     ramp-aware media cap on the drag (drag.cap). Lane changes, undo and
     redraws stay with the app. */
  function beginDrag(doc, c, mode, { selIds } = {}) {
    const snap = (x) => ({
      start: x.start, in: x.in, duration: x.duration, track: x.track,
      keyframes: x.keyframes ? JSON.parse(JSON.stringify(x.keyframes)) : undefined,
      transitionIn: x.transitionIn, transitionOut: x.transitionOut, // fitTransitions never mutates one
    });
    // moving a clip that belongs to a multi-selection drags the whole group;
    // AV-linked partners (video+audio from one file) always move together
    const picked = mode === "move" && selIds && selIds.has(c.id) ? doc.clips.filter((x) => selIds.has(x.id)) : [c];
    const group = withLinked(doc.clips, picked);
    // a trim re-bases every member's own keyframes from its pointerdown state
    const origs = new Map(mode === "move" ? [[c.id, snap(c)]] : group.map((x) => [x.id, snap(x)]));
    return {
      clip: c, mode, orig: origs.get(c.id), origs, group,
      starts: new Map(group.map((x) => [x.id, x.start])),
      groupIds: new Set(group.map((x) => x.id)), // what snapping must ignore
      media: (doc.media || []).find((m) => m.id === c.mediaId),
    };
  }
  /* ctx: { snap(t) → snapped t (default: none), minDur } */
  function dragTo(doc, drag, dt, ctx) {
    const snap = (ctx && ctx.snap) || ((t) => t);
    const minDur = minDurOf(ctx);
    const { clip: c, orig } = drag;
    if (drag.mode === "move") {
      // Snap whichever edge is closer to a target. A non-snapping edge has
      // distance 0, which must NOT beat a real snap on the other edge.
      const rawStart = orig.start + dt;
      const rawEnd = orig.start + orig.duration + dt;
      const snapStart = snap(rawStart);
      const snapEnd = snap(rawEnd);
      const dStart = Math.abs(snapStart - rawStart);
      const dEnd = Math.abs(snapEnd - rawEnd);
      let ns = rawStart;
      if (dEnd > 0 && (dStart === 0 || dEnd < dStart)) ns = snapEnd - orig.duration;
      else if (dStart > 0) ns = snapStart;
      // one time-delta for the whole group, clamped so nothing crosses 0
      let d = ns - orig.start;
      d = Math.max(d, -Math.min(...drag.group.map((x) => drag.starts.get(x.id))));
      for (const x of drag.group) x.start = drag.starts.get(x.id) + d;
    } else if (drag.mode === "trim-l") {
      let ns = snap(orig.start + dt);
      const timed = isTimed(c); // svg too: its animation stops at in = 0 (D5)
      const probe = probeOf(c, orig);
      // extending the head plays the speed curve before 0 — an anchor's ramp,
      // then the first key held (D4, BUG-12); solved once per gesture
      if (timed && !drag.head) drag.head = headRamp(probe);
      const mediaStart = timed ? orig.start - drag.head.reach(orig.in) : -Infinity; // where in reaches 0
      const hi = orig.start + orig.duration - minDur;
      ns = clamp(ns, Math.max(0, mediaStart), hi);
      const d = ns - orig.start;
      // a clamped edge lands exactly on its bound: float residue like
      // in = −5.6e-17 is a validation error on disk (BUG-24)
      c.start = ns;
      c.in = !timed || ns === mediaStart ? 0
        : Math.max(0, d >= 0 ? mediaTimeAt(probe, ns) : orig.in - drag.head.back(-d)); // the source under the new edge
      c.duration = ns === hi ? minDur : orig.duration - d;
      retime(doc, drag, c, d, "in");
    } else { // trim-r
      const ne = snap(orig.start + orig.duration + dt);
      let maxDur = 1e6;
      if (isMediaKind(c) && drag.media?.duration) {
        // where the source runs out along the ramp, not at static speed
        // (BUG-23); solved once per gesture and media length
        if (drag.cap?.media !== drag.media.duration)
          drag.cap = { media: drag.media.duration, dur: durationUntil(probeOf(c, orig), drag.media.duration) };
        maxDur = drag.cap.dur;
      }
      // a source replaced by a shorter file can leave maxDur below minDur (or
      // negative) — never let the clamp's upper bound drop under its lower one
      c.duration = clamp(ne - orig.start, minDur, Math.max(minDur, maxDur));
      retime(doc, drag, c, 0, "out");
    }
  }
  /* The rest of an edge drag: every member of the dragged group re-bases its
     own pointerdown keyframes by the edge change d (head trims shift them,
     tail trims only clip them) onto the new duration, then the partners take
     c's start / in / duration / speed (BUG-21, BUG-07). A drag keeps the
     dragged edge's transition, fitted to the new duration from its
     pointerdown length, so dragging back out gives it back (D6, BUG-22). */
  function retime(doc, drag, c, d, edge) {
    for (const x of drag.group) x.keyframes = shiftKF(drag.origs.get(x.id).keyframes, d, c.duration);
    syncLinkedTiming(doc.clips, c);
    for (const x of drag.group) {
      const o = drag.origs.get(x.id);
      if (o.transitionIn || o.transitionOut) {
        x.transitionIn = o.transitionIn;
        x.transitionOut = o.transitionOut;
        fitTransitions(x, edge);
      }
    }
  }

  return Object.freeze({
    GAP_EPS,
    splitClipAt, splitAt, splitAtTimes,
    trimClipTo, trimToRange,
    gapAt, planCloseGap, closeGapAt, closeGapMessage, listAlignedGaps, nextGap,
    removeClips, removeMedia, setClipTiming, capToSource,
    beginDrag, dragTo,
  });
});
