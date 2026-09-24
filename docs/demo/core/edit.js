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
               "no-clip", "at-start"
   plus op-specific fields (trackId, gap, trimmed).

   Known bugs kept as-is until Phase 3 (edit-ops.test.js has todo tests; the
   core tests label them "current behavior"):
     BUG-09  closeGapAt moves only clips on enabled lanes (linked partners on
             disabled lanes stay behind)
     BUG-10  trimToRange skips linked partners on disabled lanes
     BUG-12  splitClipAt and trim-l advance `in` by static speed, not by
             mediaTimeAt (wrong on speed ramps)
     BUG-13  shiftKF drops keyframes outside a piece without boundary keys
     BUG-14  trimClipTo: no keyframe shift, keeps the trimmed edge's
             transition, advances `in` for non-media clips, and goes ahead
             (undo recorded) even when the playhead is outside the clip
     BUG-15  splitClipAt copies props shallowly (array props are shared)
     BUG-16  split keeps transitions longer than the new piece
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
  const { MIN_DUR } = S;
  const { clipEnd, clipSpeed, shiftKF } = K;
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
  const done = (extra) => ({ changed: true, created: [], removed: [], ...extra });
  const refused = (reason, extra) => ({ changed: false, created: [], removed: [], reason, ...extra });
  const begin = (ctx) => { if (ctx && typeof ctx.beforeChange === "function") ctx.beforeChange(); };
  /* t falls strictly inside c, at least minDur from either edge */
  const inside = (c, t, minDur) => t > c.start + minDur && t < clipEnd(c) - minDur;
  const isMediaKind = (c) => c.kind === "video" || c.kind === "audio";

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
      ...c, id: newId(), props: { ...c.props }, // BUG-15: shallow props copy
      start: t, in: c.in + cut * clipSpeed(c), duration: clipEnd(c) - t, // BUG-12: static speed
      keyframes: shiftKF(c.keyframes, cut, clipEnd(c) - t),
      transitionIn: undefined,
      linkedId: undefined,
      linkGroup: undefined,
    };
    c.duration = cut;
    c.keyframes = shiftKF(c.keyframes, 0, cut);
    c.transitionOut = undefined;
    doc.clips.push(right);
    return right;
  }
  /* Split every clip in `targets` that t falls inside; the right halves of
     linked partners get linked to each other. Returns the new pieces. */
  function splitSet(doc, targets, t, ctx) {
    const newLink = new Map(); // oldClipId -> right half
    for (const c of targets) {
      const right = splitClipAt(doc, c, t, ctx);
      if (right) newLink.set(c.id, right);
    }
    relinkSplitRights(targets, newLink, ctx);
    return [...newLink.values()];
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
    return done({ created: splitSet(doc, targets, t, ctx) });
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
    const created = [];
    // Right-to-left so each successive cut still lands on the left-hand piece
    for (const t of ts.slice().sort((a, b) => b - a)) {
      created.push(...splitSet(doc, targets.filter((c) => inside(c, t, minDur)), t, ctx));
    }
    return done({ created });
  }

  /* ── Trim ── */
  /* Trim c's head ("in") or tail ("out") to timeline time t; linked partners
     follow. Refused only for a missing clip or an "in" trim at/before the
     clip start. Current behavior (BUG-14, changes in Phase 3): no keyframe
     shift, the trimmed edge keeps its transition, `in` advances for
     non-media clips too, and a t outside the trimmable range still goes
     ahead — beforeChange fires, partners re-sync, changed is true — with
     trimmed: false. */
  function trimClipTo(doc, c, t, side, ctx) {
    const minDur = minDurOf(ctx);
    if (!c) return refused("no-clip");
    if (t <= c.start && side === "in") return refused("at-start");
    begin(ctx);
    let trimmed = false;
    if (side === "in" && t > c.start && t < clipEnd(c) - minDur) {
      const d = t - c.start;
      c.start = t; c.in += d * clipSpeed(c); c.duration -= d;
      trimmed = true;
    } else if (side === "out" && t > c.start + minDur && t < clipEnd(c)) {
      c.duration = t - c.start;
      trimmed = true;
    }
    syncLinkedTiming(doc.clips, c);
    return done({ trimmed });
  }
  /* Trim to the work area: on enabled lanes, drop clip heads before inPoint
     and tails after outPoint (either may be null = open), and remove clips
     that would be left shorter than minDur. Trimmed edges lose their
     transition and keyframes are re-based. Linked partners on disabled lanes
     are left alone (BUG-10, changes in Phase 3). */
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
    const willChange = doc.clips.some((c) => {
      if (!isEnabled(c.track)) return false;
      const [t0, t1] = span(c);
      return t1 - t0 < minDur || t0 > c.start + 1e-6 || t1 < clipEnd(c) - 1e-6;
    });
    if (!willChange) return refused("nothing");
    begin(ctx);
    const doomed = new Set();
    for (const c of doc.clips) {
      if (!isEnabled(c.track)) continue;
      const [t0, t1] = span(c);
      if (t1 - t0 < minDur) { doomed.add(c.id); continue; }
      const dIn = t0 - c.start;
      if (dIn > 1e-6) {
        c.start = t0;
        if (isMediaKind(c)) c.in += dIn * clipSpeed(c);
        else c.in = 0;
        c.duration -= dIn;
        c.keyframes = shiftKF(c.keyframes, dIn, c.duration);
        c.transitionIn = undefined;
      }
      if (clipEnd(c) - t1 > 1e-6) {
        c.duration = Math.max(minDur, t1 - c.start);
        c.keyframes = shiftKF(c.keyframes, 0, c.duration);
        c.transitionOut = undefined;
      }
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
     enabled lane left. → { ok, reason?, trackId?, gap, movers } */
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
    // BUG-09 (changes in Phase 3): partners on disabled lanes don't move
    const movers = doc.clips.filter((c) => isEnabled(c.track) && c.start >= R - GAP_EPS);
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

  /* ── Clip drag gestures ──
     beginDrag captures the originals at pointerdown; dragTo re-applies the
     gesture from them for the pointer's total offset dt (seconds), so every
     pointermove is absolute, never incremental. Lane changes, undo and
     redraws stay with the app. */
  function beginDrag(doc, c, mode, { selIds } = {}) {
    const orig = {
      start: c.start, in: c.in, duration: c.duration, track: c.track,
      keyframes: c.keyframes ? JSON.parse(JSON.stringify(c.keyframes)) : undefined,
    };
    // moving a clip that belongs to a multi-selection drags the whole group;
    // AV-linked partners (video+audio from one file) always move together
    const picked = mode === "move" && selIds && selIds.has(c.id) ? doc.clips.filter((x) => selIds.has(x.id)) : [c];
    const group = withLinked(doc.clips, picked);
    return {
      clip: c, mode, orig, group,
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
      const sp = clipSpeed(c); // BUG-12: static speed, not mediaTimeAt
      const maxShiftLeft = isMediaKind(c) ? orig.in / sp : 1e6;
      ns = clamp(ns, Math.max(0, orig.start - maxShiftLeft), orig.start + orig.duration - minDur);
      const d = ns - orig.start;
      c.start = ns;
      c.in = isMediaKind(c) ? orig.in + d * sp : 0;
      c.duration = orig.duration - d;
      c.keyframes = shiftKF(orig.keyframes, d, c.duration);
      syncLinkedTiming(doc.clips, c);
    } else { // trim-r
      const ne = snap(orig.start + orig.duration + dt);
      let maxDur = 1e6;
      if (isMediaKind(c) && drag.media?.duration)
        maxDur = (drag.media.duration - orig.in) / clipSpeed(c);
      // a source replaced by a shorter file can leave maxDur below minDur (or
      // negative) — never let the clamp's upper bound drop under its lower one
      c.duration = clamp(ne - orig.start, minDur, Math.max(minDur, maxDur));
      c.keyframes = shiftKF(orig.keyframes, 0, c.duration);
      syncLinkedTiming(doc.clips, c);
    }
  }

  return Object.freeze({
    GAP_EPS,
    splitClipAt, splitAt, splitAtTimes,
    trimClipTo, trimToRange,
    gapAt, planCloseGap, closeGapAt, listAlignedGaps, nextGap,
    removeClips,
    beginDrag, dragTo,
  });
});
