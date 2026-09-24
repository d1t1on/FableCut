/* ═══════════════════════════════════════════════════════════════════════════
   FableCut core — undo / redo history.

   Dual-mode classic script with no dependencies: a <script> tag exposes
   FableCore.history, Node require()s it. It stores opaque snapshot STRINGS
   and never looks inside them; the app decides what a snapshot holds and
   how to restore one. Every writer goes through one history object: app.js
   pushUndo (called by core/edit.js as ctx.beforeChange), the clip-drag
   gesture (which pushes the snapshot it took on pointerdown), undo / redo,
   and syncFromServer's reset after an external write.

   createHistory({ limit = 100 }) → a frozen history object:
     push(snapshot)  record the pre-edit state; drops the oldest entry past
                     `limit` and clears the redo stack
     undo(current)   `current` is the present state's snapshot. Returns the
                     snapshot to restore (current moves to redo), or null when
                     there is nothing to undo (nothing changes)
     redo(current)   mirror of undo
     clear()         empty both stacks
     size()          → { undo, redo } stack depths

   Known gap kept as-is until Phase 3 (edit-ops.test.js has a todo test):
     BUG-04  app.js snapshots only project.clips (media, folders, lanes,
             markers and IN/OUT are not restored by undo)
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module && module.exports) module.exports = factory();
  else (root.FableCore = root.FableCore || {}).history = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createHistory({ limit = 100 } = {}) {
    const undoStack = [];
    const redoStack = [];
    return Object.freeze({
      push(snapshot) {
        undoStack.push(snapshot);
        if (undoStack.length > limit) undoStack.shift();
        redoStack.length = 0;
      },
      undo(current) {
        if (!undoStack.length) return null;
        redoStack.push(current);
        return undoStack.pop();
      },
      // no trim: redo only refills what undo took, so the stack stays ≤ limit
      redo(current) {
        if (!redoStack.length) return null;
        undoStack.push(current);
        return redoStack.pop();
      },
      clear() {
        undoStack.length = 0;
        redoStack.length = 0;
      },
      size: () => ({ undo: undoStack.length, redo: redoStack.length }),
    });
  }

  return Object.freeze({ createHistory });
});
