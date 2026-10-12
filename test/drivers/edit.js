/* Edit driver — the stable surface timeline tests talk to.

   Tests never touch app.js slices directly: they load a project through the
   driver and call operations by name (split, trimToPlayhead, drag, undo, …).
   The driver is backed by the real code: what already lives in core/ is
   require()d and handed to the sandbox, the rest is sliced from app.js with
   the UI/DOM stubbed out. As more of the timeline moves to core/ (plan
   Phase 2), only this file changes — the tests stay byte-identical, which is
   what makes them a refactor safety net.

   Everything is deterministic: uid() is a counter, toasts and saves are
   recorded, and pointer gestures are replayed from explicit timeline times. */
"use strict";
const { evalBlocks } = require("../support/slice");
// app.js destructures these from FableCore.schema / .keyframes / .links /
// .project / .history and calls editCore / projectCore (and FableCore.validate
// in reportProjectIssues); Node requires the same files
const { DEFAULT_PROPS, EASE, MIN_DUR } = require("../../core/schema");
const kfCore = require("../../core/keyframes");
const { clipEnd, clipSpeed, kfChannel, shiftKF, hasSpeedRamp, mediaTimeAt, keysOnClip, KF_EPS, clearSpeedCache } = kfCore;
const { defaultPanForChannel, syncLinkedSpeed } = require("../../core/links");
const editCore = require("../../core/edit");
const projectCore = require("../../core/project");
const { createHistory } = require("../../core/history");
const validateCore = require("../../core/validate");

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
  ["const VIDEO_TRACK_COLORS", "/** Live track list"],           // track colors, MAX_TRACKS_PER_KIND, makeTrack
  ["/* ── Title styles: cohesive", "const AUDIO_EXT"],             // TITLE_STYLES, STYLE_RESET, STYLE_CYCLE
  ["function syncTrackIds(", "function addTimelineTrack("],      // serialize / sort / apply lanes, audioTrackIds, nextTrackId
  ["function trackHasClips(", "/* Lightweight right-click menu"], // canRemoveTrack, removeTimelineTrack
  ["function projectFps(", "const state = {"],
  ["function isTrackEnabled(", "function syncTrackDisabledUI("],
  ["function refreshAudioHoldFor(", "let toastTimer"],             // applyKfEffects + the keyframe mutators (setAnimProp, …)
  ["const getMedia = ", "/* ── Keyframes at the playhead"],       // getMedia getClip trackOf projDur
  ["function getExportFrame(", "/** Largest axis-aligned rect"],
  ["function reportProjectIssues(", "function scheduleSave("],   // + applyProject
  ["function projectJSON(", "function listenSSE("],
  ["async function syncFromServer(", "/** Populate a media entry"],
  ["const undoHistory = ", "function defaultTrackFor("],        // pushUndo, undo, redo, editCtx
  ["function defaultTrackFor(", "/* Discrete-channel labels"],   // lane for a media drop without one
  ["/** Attach one audio clip per source channel", "/** Tap one source channel"], // attachLinkedAudioChannels
  ["function addClipFromMedia(", "/* Resolve (and cache) a media's real channel count"],
  ["async function reconcileAudioChannels(", "/* Apply a named title style"],
  ["/* Apply a named title style", "/* Custom title-style dropdown"], // applyTitleStyle
  ["/* Swap a clip's source media in place", "/* A dedicated, lazily-created file input"], // replaceClipMedia
  ["/* New titles and adjustment layers", "function deleteSelected("],  // overlayLane, addTitle, addAdjust
  ["function deleteSelected(", "function clearFocusedTransition("], // enabledTracks closeGapAtPlayhead
  ["function splitAtPlayhead(", "/* Split at IN/OUT and discard"], // + splitAtWorkArea trimToPlayhead
  ["function trimToWorkArea(", "function hasWorkArea("],
  ["function startClipGesture(", "/* ── Marquee"],                  // pointer plumbing; the math is editCore's
  ["function pruneSelection(", "function renderInspector("],      // + selectedClips, applyInspectorField
  ENSURE_AUDIO_TRACK_COUNT,
];

const EXPORTS = `
  applyProject, projectJSON, syncFromServer,
  pushUndo, undo, redo, pruneSelection, selectedClips,
  splitAtPlayhead, splitAtWorkArea, trimToPlayhead, trimToWorkArea,
  closeGapAtPlayhead, deleteSelected, startClipGesture, reconcileAudioChannels,
  applyInspectorField, removeMediaFromBin, addTitle, addAdjust, removeTimelineTrack, replaceClipMedia,
  addClipFromMedia,
  shiftKF, kfChannel, mediaTimeAt,
  getClip, getMedia, clipEnd, clipSpeed, isTrackEnabled,
  tracks: () => TRACKS,
  undoSize: () => undoHistory.size(),
`;

const noop = () => {};

/* Load `doc` (a project.json object) and return a driver bound to it. */
function createEditDriver(doc, { channels } = {}) {
  let n = 0;
  const log = { toasts: [], saves: 0, console: [] };
  clearSpeedCache(); // the ramp integral cache is module-wide: no state shared between drivers
  const project = {
    name: "Untitled Project", width: 1280, height: 720, fps: 30, background: "#000000",
    revision: 0, folders: [], media: [], clips: [], markers: [], inPoint: null, outPoint: null,
    disabledTracks: [], exportFrame: null, encodeProfile: null, tracks: null, panSchema: 1,
  };
  const state = {
    time: 0, selId: null, selIds: new Set(), snap: true, pps: 60,
    gesture: false, exporting: false, dirtyTimeline: false, binTab: "project",
    audioHold: false, exportFrameView: false, source: { mediaId: null },
    disabledTracks: new Set(), soloId: null, soloRestore: null, transFocus: null,
  };
  const runtime = {
    clipEls: new Map(), clipGain: new Map(),
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
      TRACKS: [], TRACK_IDS: new Set(),
      DEFAULT_PROPS, EASE, MIN_DUR,
      clipEnd, clipSpeed, kfChannel, shiftKF, hasSpeedRamp, mediaTimeAt, keysOnClip, KF_EPS, kfCore, // core/keyframes.js
      defaultPanForChannel, syncLinkedSpeed, editCore, projectCore, createHistory, // core/links.js, edit.js, project.js, history.js
      normalizeExportFrame: projectCore.normalizeExportFrame,
      FableCore: { validate: validateCore, links: require("../../core/links") },
      // reportProjectIssues' console group, kept out of the test output
      console: {
        groupCollapsed: (m) => log.console.push(m), groupEnd: noop,
        warn: (...a) => log.console.push(a.join(" ")), log: (...a) => log.console.push(a.join(" ")),
      },
      uid: () => "u" + (++n),
      inspPropGen: 0, // the inspector's prop generation (a module-level let in app.js)
      clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
      els: { preview: {} },
      toast: (msg) => log.toasts.push(msg),
      scheduleSave: () => { log.saves++; },
      // pointer gestures carry timeline time / lane directly (no layout)
      timeAtEvent: (ev) => ev.t,
      trackAtEvent: (ev) => ev.track ?? null,
      snapTime: (t) => t, snapInfo: (t) => ({ t, hit: false }),
      setSelection: (ids) => { state.selIds = new Set(ids); state.selId = ids.length ? ids[ids.length - 1] : null; },
      detectChannelCount: async (m) => m.channels ?? channels ?? 2,
      fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(serverDoc)) }),
      // UI / DOM / audio side effects the timeline logic does not depend on
      applyTrackHeights: noop, ensureFont: noop, setAudioHold: noop, stopAudioHoldNodes: noop, scheduleAudioHoldRefresh: noop,
      releaseClipEl: noop, syncAudioGraphTracks: noop, updateMonitorRes: noop, syncAspectSel: noop,
      syncFpsSel: noop, syncExportFrameSel: noop, updateExportFrameOverlay: noop, buildTrackDOM: noop,
      renderBin: noop, renderInspector: noop, updateWorkArea: noop, syncTrimIOButton: noop,
      syncExportRangeSelect: noop, syncExportRangeUi: noop, syncAllTrackDisabledUI: noop,
      syncBinSelectionFromTimeline: noop, routeClipGain: noop, selectClip: noop,
      fetchLibrary: () => Promise.resolve([]), renderLibrary: noop, loadLibraryFonts: noop,
      fetchEncodeProfiles: noop, probeMissingMeta: async () => {},
      clearSource: noop, setEditTool: noop, syncEditTools: noop, getSetting: () => "select", rebuildClips: noop, clearTrackSolo: noop, ensureWave: noop,
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
    history: () => api.undoSize(), // { undo, redo } depths of app.js's core/history.js stack

    at(t) { state.time = t; return driver; },
    select(...ids) {
      state.selIds = new Set(ids);
      state.selId = ids.length ? ids[ids.length - 1] : null;
      return driver;
    },
    untarget(...ids) {
      for (const id of ids) state.untargetedTracks.add(id);
      project.untargetedTracks = [...state.untargetedTracks].sort();
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
    /* An inspector field edit: focus records the undo step, then the input
       writes (start, duration, or an animatable prop at the playhead). */
    inspect(id, key, value) {
      api.pushUndo();
      return api.applyInspectorField(api.getClip(id), key, value);
    },
    /* The bin's ✕ on a media entry. */
    removeMedia: (mediaId) => api.removeMediaFromBin(mediaId),
    /* The toolbar's + Title / + Adjust at the playhead; returns the new clip. */
    addTitle() { api.addTitle(); return project.clips.at(-1); },
    addAdjust() { api.addAdjust(); return project.clips.at(-1); },
    /* A bin double-click / library + / timeline drop: place media `mediaId` at
       `at` (default: the playhead) on `track` (default: none, so the editor picks). */
    addFromMedia: (mediaId, { track = null, at } = {}) => api.addClipFromMedia(api.getMedia(mediaId), track, at),
    /* A track header's right-click → Remove track (refused while it has clips). */
    removeTrack: (id) => api.removeTimelineTrack(id),
    /* The inspector's Source picker: swap the clip's media for `mediaId`. */
    replaceMedia: (id, mediaId) => api.replaceClipMedia(api.getClip(id), api.getMedia(mediaId)),

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
