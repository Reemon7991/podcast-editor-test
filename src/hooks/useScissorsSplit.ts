"use client";

import { useEffect, useState, type RefObject } from "react";
import type { ClipTrack } from "@waveform-playlist/browser";
import { resolveClipAt, contentXFromClientX } from "../utils/clipGeometry";

interface UseScissorsSplitOptions {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Same DOM node as scrollContainerRef.current, but as reactive state —
   *  see ClipActionsOverlay's own doc comment on why the ref alone can't be
   *  read during render. Used here only to know *when* to (re)attach. */
  scrollEl: HTMLDivElement | null;
  tracks: ClipTrack[];
  samplesPerPixel: number;
  timeScaleHeight: number;
  sampleRate: number;
  splitClipAt: (trackIndex: number, clipIndex: number, splitTime: number) => boolean;
}

export interface UseScissorsSplitResult {
  active: boolean;
  /** Content-space X of the preview line; null before the first pointer move
   *  after activation. */
  lineX: number | null;
  activate: () => void;
}

/**
 * "Split" doesn't split immediately: activating this arms a mode where a
 * dashed preview line follows the pointer and the next click on a clip
 * performs the split there (a click that misses every clip just cancels,
 * as does Escape) — never disabled, unlike an earlier "split at the current
 * playhead" design that had to grey out the menu item whenever the playhead
 * wasn't over the clip. Still reuses the same engine-native `splitClipAt`
 * (from the library's `useClipSplitting`) — see that hook's own doc comment
 * for why: pixel-snapping and minimum-duration guards come for free, a
 * hand-rolled split would have to reimplement both to be correct.
 *
 * Kept separate from ClipActionsOverlay's hover/button logic: that's a
 * per-clip hover menu, this is a modal "pick a point" tool — structurally
 * different concerns that happen to share the same clip-geometry hit-test
 * (`resolveClipAt`).
 *
 * Known gap: the preview line only repositions on "mousemove", not on
 * scroll — scrolling a long clip via the scrollbar/wheel without also
 * moving the mouse leaves the line at its last mouse-driven position until
 * the next move. Not fixed here; a prior attempt at this specific fix
 * introduced its own bug (see git history) and was reverted.
 */
export function useScissorsSplit({
  scrollContainerRef,
  scrollEl,
  tracks,
  samplesPerPixel,
  timeScaleHeight,
  sampleRate,
  splitClipAt,
}: UseScissorsSplitOptions): UseScissorsSplitResult {
  const [active, setActive] = useState(false);
  const [lineX, setLineX] = useState<number | null>(null);

  // Both "mousedown" and "pointerdown" are intercepted, in the capture
  // phase: the library's own playhead-seek is wired via a React onMouseDown
  // (so a capture-phase native "mousedown" listener on an ancestor stops it
  // before it ever reaches that handler), while @dnd-kit's drag sensors
  // listen for "pointerdown" instead — stopping only one leaves the other
  // free to fire. Per spec, calling preventDefault() on "pointerdown"
  // already suppresses the browser's compatibility "mousedown" for that
  // same click (confirmed empirically here too — A/B'd with `committed`
  // disabled, in a real Chromium build, and the "mousedown" listener never
  // fired a second time), so this likely never actually double-invokes in
  // practice. `committed` is kept anyway so correctness doesn't ride on that
  // suppression behavior holding on every engine this ever runs in — it's
  // one extra boolean check, not a meaningful cost.
  useEffect(() => {
    if (!scrollEl || !active) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let committed = false;
    const end = () => {
      setActive(false);
      setLineX(null);
    };
    const handleMove = (e: MouseEvent) => {
      setLineX(contentXFromClientX(e.clientX, container));
    };
    const commitOrCancel = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      if (committed) return;
      committed = true;
      if (e instanceof MouseEvent) {
        const hit = resolveClipAt(e.clientX, e.clientY, container, tracks, samplesPerPixel, timeScaleHeight);
        if (hit) {
          splitClipAt(hit.trackIndex, hit.clipIndex, hit.sample / sampleRate);
        }
      }
      end();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") end();
    };

    container.style.cursor = "crosshair";
    container.addEventListener("mousemove", handleMove);
    container.addEventListener("mousedown", commitOrCancel, true);
    container.addEventListener("pointerdown", commitOrCancel, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      container.style.cursor = "";
      container.removeEventListener("mousemove", handleMove);
      container.removeEventListener("mousedown", commitOrCancel, true);
      container.removeEventListener("pointerdown", commitOrCancel, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    scrollEl,
    active,
    scrollContainerRef,
    tracks,
    samplesPerPixel,
    timeScaleHeight,
    sampleRate,
    splitClipAt,
  ]);

  return { active, lineX, activate: () => setActive(true) };
}
