/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — AV links: which clips move, trim and split together.

   Dual-mode classic script like core/schema.js: a <script> tag exposes
   FableCore.links, Node require()s it. Pure and dependency-free — every
   function takes the clip array it works on (`clips`, normally
   project.clips) instead of reading app state, and id factories come in
   through `ctx`. app.js keeps its old names (withLinked(list),
   syncLinkedTiming(c), relinkClips(), …) as thin wrappers that pass
   project.clips and its uid-based factories.

   Two link flavors exist on disk:
     linkGroup  N-way: a video clip and its per-channel audio stems share one
                id (the current format)
     linkedId   legacy pairwise link; relinkClips() replaces it on load

   Known gaps kept as-is until Phase 3 (edit-ops.test.js has todo tests):
     BUG-07  syncLinkedTiming copies props.speed but not keyframes.speed
     BUG-11  relinkClips regenerates every linkGroup id on load and silently
             unlinks members whose timing drifted
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports) module.exports = factory();
  else (root.FableCore = root.FableCore || {}).links = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* Legacy pairwise partner of c (by linkedId), else null/undefined. */
  function linkedClip(clips, c) {
    return c?.linkedId ? clips.find((x) => x.id === c.linkedId) : null;
  }
  /* Expand `list` so each AV-linked partner in `clips` is included once
     (N-way linkGroup and legacy linkedId). Order: list order, then partners
     in `clips` order; each clip object appears once, by id. */
  function withLinked(clips, list) {
    const out = new Map();
    const groups = new Set();
    for (const c of list) {
      out.set(c.id, c);
      if (c.linkGroup) groups.add(c.linkGroup);
      else {
        const L = linkedClip(clips, c);
        if (L) out.set(L.id, L);
      }
    }
    if (groups.size) {
      for (const x of clips) {
        if (x.linkGroup && groups.has(x.linkGroup)) out.set(x.id, x);
      }
    }
    return [...out.values()];
  }
  /* Copy c's timing (start / in / duration / props.speed) onto its partners. */
  function syncLinkedTiming(clips, c) {
    for (const L of withLinked(clips, [c])) {
      if (L.id === c.id) continue;
      L.start = c.start;
      L.in = c.in;
      L.duration = c.duration;
      if (c.props?.speed != null) {
        L.props = L.props || {};
        L.props.speed = c.props.speed;
      }
    }
  }
  /* Rebuild AV linkGroups after load. Unlinking isn't supported, so any video +
     audio clips that share mediaId and the same start/in/duration belong
     together (e.g. picture + L/R/C stems from one file). Legacy pairwise
     linkedId is cleared in favor of linkGroup. ctx.newLinkId() → a fresh
     linkGroup id, called once per video that gets partners, in clip order. */
  function relinkClips(clips, ctx) {
    const newLinkId = need(ctx, "newLinkId");
    const near = (a, b) => Math.abs((+a || 0) - (+b || 0)) < 1e-3;
    for (const c of clips) {
      delete c.linkGroup;
      delete c.linkedId;
    }
    const audios = clips.filter((c) => c.kind === "audio" && c.mediaId);
    const used = new Set();
    for (const v of clips) {
      if (v.kind !== "video" || !v.mediaId) continue;
      const partners = audios.filter((a) =>
        !used.has(a.id) &&
        a.mediaId === v.mediaId &&
        near(a.start, v.start) &&
        near(a.in, v.in) &&
        near(a.duration, v.duration)
      );
      if (!partners.length) continue;
      const lg = newLinkId();
      v.linkGroup = lg;
      for (const a of partners) {
        a.linkGroup = lg;
        used.add(a.id);
      }
    }
  }
  /* After splitting a set of clips, wire each new right half to its partner's
     right half. newLink: Map oldClipId → right half (clips that did not split
     are absent). ctx.newLinkId() is called once per old linkGroup, in
     `targets` order. */
  function relinkSplitRights(targets, newLink, ctx) {
    const newLinkId = need(ctx, "newLinkId");
    const newGroups = new Map(); // old linkGroup -> new linkGroup for right halves
    for (const c of targets) {
      const right = newLink.get(c.id);
      if (!right) continue;
      if (c.linkGroup) {
        if (!newGroups.has(c.linkGroup)) newGroups.set(c.linkGroup, newLinkId());
        right.linkGroup = newGroups.get(c.linkGroup);
      } else {
        const partner = c.linkedId ? newLink.get(c.linkedId) : null;
        if (partner) {
          right.linkedId = partner.id;
          partner.linkedId = right.id;
        } else {
          delete right.linkedId;
        }
      }
    }
  }
  /* Default stereo pan for an isolated linked stem (L −1, R +1, else center). */
  function defaultPanForChannel(ch) {
    if (ch === 0) return -1;
    if (ch === 1) return 1;
    return 0;
  }

  /* A ctx factory the caller must supply — failing loudly beats a silent default. */
  function need(ctx, key) {
    const f = ctx && ctx[key];
    if (typeof f !== "function") throw new TypeError(`FableCore.links: ctx.${key} must be a function`);
    return f;
  }

  return Object.freeze({
    linkedClip, withLinked, syncLinkedTiming, relinkClips, relinkSplitRights, defaultPanForChannel,
  });
});
