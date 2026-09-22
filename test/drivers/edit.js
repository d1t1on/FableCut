/* Edit driver — the stable surface timeline tests talk to.

   Tests never touch app.js slices directly: they load a project through the
   driver and call operations by name (split, trimToPlayhead, drag, undo, …).
   Today the driver is backed by the real app.js code, sliced into one sandbox
   with the UI/DOM stubbed out. When the timeline core moves to core/ (plan
   Phase 2), only this file changes — the tests stay byte-identical, which is
   what makes them a refactor safety net.

   Everything is deterministic: uid() is a counter, toasts and saves are
   recorded, and pointer gestures are replayed from explicit timeline times. */
"use strict";
const { lift, evalBlocks } = require("../support/slice");

const DEFAULT_PROPS = lift(/const DEFAULT_PROPS = (\{[\s\S]*?\n\});/);
const EASE = lift(/const EASE = (\{[\s\S]*?\n\});/);
const MIN_DUR = lift(/const MIN_DUR = ([\d.]+);/);

/* Keeps reconcileAudioChannels' A-lane growth testable without the DOM-heavy
   original (which also rebuilds track headers and the audio graph). */
const ENSURE_AUDIO_TRACK_COUNT = `
function ensureAudioTrackCount(need) {
  need = Math.min(Math.max(0, need | 0), MAX_TRACKS_PER_KIND);
  let added = 0;
  while (audioTrackIds().length < need) {
    if (TRACKS.filter((t) => t.kind === "audio").length >= MAX_TRACKS_PER_KIND) break;
    TRACKS.push(makeTrack(nextTrackId("audio"), "audio"));
    added++;
  }
  if (added) { sortTracksInPlace(); project.tracks = serializeTracks(); scheduleSave(); }
  return added;
}`;

const BLOCKS = [
  ["const VIDEO_TRACK_COLORS", "/** Live track list"],           // track colors, MAX_TRACKS_PER_KIND, DEFAULT_TRACK_DEFS, makeTrack
  ["function syncTrackIds(", "function addTimelineTrack("],      // serialize / sort / apply / ensure lanes, audioTrackIds, nextTrackId
  ["function projectFps(", "const state = {"],
  ["function normalizeDisabledTracks(", "function syncTrackDisabledUI("], // + isTrackEnabled
  ["const getMedia = ", "/* ── Speed ramps"],                     // getMedia getClip clipEnd trackOf projDur clipSpeed
  ["function kfChannel(", "const kfTimeEps"],
  ["function hasSpeedRamp(", "let toastTimer"],                   // + mediaTimeAt
  ["const TIMELINE_START_TIME", "function folderChildren("],      // normalizeWorkArea getFolder normalizeFolders normalizeMediaEntry
  ["/** Floor to even", "/** Largest axis-aligned rect"],         // evenFloor normalizeExportFrame getExportFrame
  ["function applyProject(", "function scheduleSave("],
  ["function projectJSON(", "function listenSSE("],
  ["async function syncFromServer(", "/** Populate a media entry"],
  ["function pushUndo(", "function defaultTrackFor("],            // + undo, redo
  ["function linkedClip(", "/* Discrete-channel labels"],         // withLinked syncLinkedTiming relinkClips
  ["function defaultPanForChannel(", "function clipPan("],
  ["async function reconcileAudioChannels(", "/* Apply a named title style"],
  ["function deleteSelected(", "/* Gap under playhead"],
  ["const GAP_EPS", "function clearFocusedTransition("],          // gapAtPlayhead enabledTracks closeGapAtPlayhead
  ["function splitAtPlayhead(", "/* Split at IN/OUT and discard"], // splitClipAt relinkSplitRights splitAtWorkArea trimToPlayhead
  ["function trimToWorkArea(", "function hasWorkArea("],
  ["function startClipGesture(", "/* ── Marquee"],
  ["function shiftKF(", "function parseSvgSize("],
  ["function pruneSelection(", "function renderInspector("],      // + selectedClips
  ENSURE_AUDIO_TRACK_COUNT,
];

const EXPORTS = `
  applyProject, projectJSON, syncFromServer,
  pushUndo, undo, redo, pruneSelection, selectedClips,
  splitAtPlayhead, splitClipAt, splitAtWorkArea, trimToPlayhead, trimToWorkArea,
  closeGapAtPlayhead, deleteSelected, startClipGesture, reconcileAudioChannels,
  withLinked, syncLinkedTiming, relinkClips, shiftKF, kfChannel, mediaTimeAt,
  getClip, getMedia, clipEnd, clipSpeed, isTrackEnabled,
  tracks: () => TRACKS,
`;

const noop = () => {};

/* Load `doc` (a project.json object) and return a driver bound to it. */
function createEditDriver(doc, { channels } = {}) {
  let n = 0;
  const log = { toasts: [], saves: 0 };
  const project = {
    name: "Untitled Project", width: 1280, height: 720, fps: 30, background: "#000000",
    revision: 0, folders: [], media: [], clips: [], markers: [], inPoint: null, outPoint: null,
    disabledTracks: [], exportFrame: null, encodeProfile: null, tracks: null, panSchema: 1,
  };
  const state = {
    time: 0, selId: null, selIds: new Set(), snap: true, pps: 60,
    gesture: false, exporting: false, dirtyTimeline: false, binTab: "project",
    audioHold: false, exportFrameView: false,
    disabledTracks: new Set(), soloId: null, soloRestore: null, transFocus: null,
  };
  const runtime = {
    undo: [], redo: [], clipEls: new Map(), clipGain: new Map(),
    pendingSync: false, saveTimer: null, audio: null,
  };
  const win = { listeners: {} };
  win.addEventListener = (type, fn) => { win.listeners[type] = fn; };
  win.removeEventListener = (type) => { delete win.listeners[type]; };
  let serverDoc = null;

  const api = evalBlocks({
    blocks: BLOCKS,
    exports: EXPORTS,
    stubs: {
      project, state, runtime, window: win,
      TRACKS: [], TRACK_IDS: new Set(), speedIntCache: new Map(),
      DEFAULT_PROPS, EASE, MIN_DUR,
      uid: () => "u" + (++n),
      clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
      els: { preview: {} },
      toast: (msg) => log.toasts.push(msg),
      scheduleSave: () => { log.saves++; },
      // pointer gestures carry timeline time / lane directly (no layout)
      timeAtEvent: (ev) => ev.t,
      trackAtEvent: (ev) => ev.track ?? null,
      snapTime: (t) => t,
      setSelection: (ids) => { state.selIds = new Set(ids); state.selId = ids.length ? ids[ids.length - 1] : null; },
      detectChannelCount: async (m) => m.channels ?? channels ?? 2,
      fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(serverDoc)) }),
      // UI / DOM / audio side effects the timeline logic does not depend on
      applyTrackHeights: noop, ensureFont: noop, setAudioHold: noop, stopAudioHoldNodes: noop,
      releaseClipEl: noop, syncAudioGraphTracks: noop, updateMonitorRes: noop, syncAspectSel: noop,
      syncFpsSel: noop, syncExportFrameSel: noop, updateExportFrameOverlay: noop, buildTrackDOM: noop,
      renderBin: noop, renderInspector: noop, updateWorkArea: noop, syncTrimIOButton: noop,
      syncExportRangeSelect: noop, syncExportRangeUi: noop, syncAllTrackDisabledUI: noop,
      syncBinSelectionFromTimeline: noop, routeClipGain: noop, selectClip: noop,
      fetchLibrary: () => Promise.resolve([]), renderLibrary: noop, loadLibraryFonts: noop,
      fetchEncodeProfiles: noop, probeMissingMeta: async () => {},
    },
  });

  api.applyProject(doc);
  // loading may schedule a migration save; keep that apart from the ops' saves
  const loadSaves = log.saves;
  log.saves = 0;

  const driver = {
    project, state, runtime, log, loadSaves, api,
    clip: (id) => api.getClip(id),
    clips: () => project.clips,
    tracks: () => api.tracks().map((t) => t.id),
    history: () => ({ undo: runtime.undo.length, redo: runtime.redo.length }),

    at(t) { state.time = t; return driver; },
    select(...ids) {
      state.selIds = new Set(ids);
      state.selId = ids.length ? ids[ids.length - 1] : null;
      return driver;
    },
    disable(...ids) {
      for (const id of ids) state.disabledTracks.add(id);
      project.disabledTracks = [...state.disabledTracks].sort();
      return driver;
    },

    split: () => api.splitAtPlayhead(),
    splitAtWorkArea: () => api.splitAtWorkArea(),
    trimToPlayhead: (side) => api.trimToPlayhead(side),
    trimToWorkArea: () => api.trimToWorkArea(),
    closeGap: () => api.closeGapAtPlayhead(),
    deleteSelected: () => api.deleteSelected(),
    undo: () => api.undo(),
    redo: () => api.redo(),
    pushUndo: () => api.pushUndo(),
    reconcileAudio: (id) => api.reconcileAudioChannels(api.getClip(id)),

    /* Replay a timeline pointer gesture: press at `from`, move to `to`, release.
       mode: "move" | "trim-l" | "trim-r". `track` = lane under the pointer. */
    drag(id, mode, from, to, { track } = {}) {
      const c = api.getClip(id);
      api.startClipGesture({ preventDefault: noop, t: from, clientX: 0, clientY: 0 }, c, mode, false);
      if (to !== from || track) win.listeners.pointermove?.({ t: to, clientX: 100, clientY: 0, track });
      win.listeners.pointerup?.({});
    },
    /* Press and release without moving (a click on the clip body). */
    click(id) {
      const c = api.getClip(id);
      api.startClipGesture({ preventDefault: noop, t: c.start, clientX: 0, clientY: 0 }, c, "move", false);
      win.listeners.pointerup?.({});
    },

    /* An external writer (agent, MCP) saved `next`; the SSE `change` fires. */
    async externalWrite(next) {
      serverDoc = next;
      await api.syncFromServer();
    },
    save: () => JSON.parse(JSON.stringify(api.projectJSON())),
    mediaTimeAt: (id, t) => api.mediaTimeAt(api.getClip(id), t),
    valueAt: (id, key, local, fallback) => api.kfChannel(api.getClip(id), key, local, fallback),
  };
  return driver;
}

module.exports = { createEditDriver, DEFAULT_PROPS, MIN_DUR };
