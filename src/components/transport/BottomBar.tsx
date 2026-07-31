"use client";

import type { RefObject } from "react";
import { PlaybackTime } from "./PlaybackTime";
import { DurationLabel } from "./DurationLabel";
import { PlayPauseButton } from "./PlayPauseButton";
import { ZoomControls } from "./ZoomControls";

interface BottomBarProps {
  playPendingRef: RefObject<boolean>;
}

/**
 * Bottom transport strip: time/duration (left) — merged Play/Pause (center)
 * — Zoom out/in (right). Replaces the old single TransportControls bar's
 * playback/zoom responsibility; project/undo-redo/clip-actions/upload/export
 * now live in TopBar.tsx instead.
 */
export function BottomBar({ playPendingRef }: BottomBarProps) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-white px-4 py-2 shadow-sm">
      <div className="flex flex-1 items-center gap-1 text-sm text-[var(--foreground)]">
        <PlaybackTime />
        <span className="text-[var(--text-muted)]">/</span>
        <DurationLabel />
      </div>
      <div className="flex flex-1 items-center justify-center">
        <PlayPauseButton playPendingRef={playPendingRef} />
      </div>
      <div className="flex flex-1 items-center justify-end">
        <ZoomControls />
      </div>
    </div>
  );
}
