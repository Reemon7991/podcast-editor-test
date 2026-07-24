"use client";

import { useEffect } from "react";
import { usePlaybackAnimation, usePlaylistControls } from "@waveform-playlist/browser";
import { useProjectStore } from "../store/projectStore";

/**
 * Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z, mounted from EditorShell.tsx (inside the
 * provider tree — needed for the stop()/isPlaying guard below) and gated on
 * `enabled` (same isReady signal already gating TransportControls).
 *
 * Deliberately not the library's own `undo?: boolean` shortcut prop /
 * usePlaylistControls().undo/redo — confirmed via
 * @waveform-playlist/browser/dist/index.d.ts that's a separate, default-off
 * mechanism covering only engine-internal transactions; wiring both would
 * mean two competing Ctrl+Z listeners.
 *
 * stop()-if-isPlaying mirrors ClipDragLayer.tsx's existing guard: extends it
 * to undo/redo, since either can trigger the same full-rebuild-during-
 * playback race documented in CLAUDE.md. stop() is synchronous, so it
 * batches into the same commit as the undo()/redo() call that follows (React
 * batches all state updates — including external stores like this one —
 * within a single synchronous callback, regardless of whether that callback
 * came from a native event listener or a React synthetic one).
 */
export function useUndoRedoShortcut(enabled: boolean) {
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const { isPlaying } = usePlaybackAnimation();
  const { stop } = usePlaylistControls();

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (isPlaying) stop();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, undo, redo, isPlaying, stop]);
}
