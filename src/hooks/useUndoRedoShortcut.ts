"use client";

import { useEffect } from "react";
import { useProjectStore } from "../store/projectStore";

/**
 * Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z, mounted from EditorShell.tsx and gated on
 * `enabled` (same isReady signal already gating TopBar/BottomBar).
 *
 * Deliberately not the library's own `undo?: boolean` shortcut prop /
 * usePlaylistControls().undo/redo — confirmed via
 * @waveform-playlist/browser/dist/index.d.ts that's a separate, default-off
 * mechanism covering only engine-internal transactions; wiring both would
 * mean two competing Ctrl+Z listeners.
 *
 * No local stop()-if-playing guard needed here — `undo`/`redo` themselves
 * stop playback first if needed (see projectStore.ts's `stopIfPlaying`/
 * `registerStopIfPlaying` doc comment), same as `commit`.
 */
export function useUndoRedoShortcut(enabled: boolean) {
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, undo, redo]);
}
