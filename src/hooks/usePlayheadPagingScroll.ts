"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { usePlaybackAnimation } from "@waveform-playlist/browser";

// Small buffer so a paged playhead lands just inside the left edge, not
// literally touching the container's own border — a visual nicety only,
// easy to change/remove without affecting when a page triggers.
const LEFT_MARGIN_PX = 12;

interface UsePlayheadPagingScrollOptions {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Called synchronously, right after this hook pages the view, with the
   *  new scrollLeft. EditorShell.tsx uses this to keep its own
   *  savedScrollLeftRef in sync immediately — not left to the scroll
   *  container's native "scroll" event, which only updates asynchronously
   *  and could otherwise race EditorShell's rebuild-scroll-restore effect. */
  onPaged?: (newScrollLeft: number) => void;
}

interface UsePlayheadPagingScrollResult {
  /** Call this right after any *other* deliberate scroll jump — today, only
   *  EditorShell.tsx's own handleScrollToTime (a search-result click).
   *  Resyncs this hook's internal page-trigger baseline to wherever the
   *  view was just intentionally moved to, so the next natural page is
   *  computed from there instead of a stale pre-jump position. Without
   *  this, a search click during active playback could get immediately
   *  overridden by a page-jump computed against the old baseline. */
  resyncBaseline: () => void;
}

/**
 * Pages the timeline forward exactly when the playhead reaches the right
 * edge of the view — not continuous centering, and (the part that took a
 * second pass to get right) not reactive to manual scrolling *at all*
 * during that wait.
 *
 * First version of this hook read the scroll container's own *live*
 * scrollLeft every frame as the paging threshold's left edge. That
 * correctly avoided fighting a *forward* manual scroll (nothing to trigger
 * — the playhead was already inside the new, further-right view), but a
 * *backward* scroll during playback — looking at earlier content while
 * playback keeps advancing — almost always immediately re-triggered a page:
 * the instant the view scrolls back, the still-advancing playhead is
 * already past that (now-earlier) view's right edge, so the very next
 * animation frame (~16ms later) snapped it forward again. Reported directly
 * by the user as "I can't scroll away from the playhead while playing" —
 * confirmed by inspection, not a timing fluke.
 *
 * Fixed by never reading live scrollLeft for the threshold at all.
 * `pageBaselineRef` is set once when playback starts (or resumes) and
 * updated only by this hook's own page-jumps (or an explicit
 * `resyncBaseline()` call for another deliberate jump elsewhere) —
 * completely decoupled from whatever the user does with manual scrolling in
 * between. A manual scroll, in either direction, at any point during
 * playback, is left alone until the *next* page-jump the original,
 * uninterrupted schedule would have made anyway (up to one full
 * viewport-width of real playback time after the last page or the start of
 * this play session) — at which point the view does snap back to reveal the
 * live playhead. That eventual reclaim is inherent to "auto-follow" existing
 * at all, not something this hook tries to avoid; the fix is specifically
 * that a manual scroll no longer gets fought within a frame or two of making
 * it.
 *
 * Uses `registerFrameCallback` — the library's real per-frame clock, not
 * React state (see CLAUDE.md's "usePlaybackAnimation().currentTime is not a
 * live value" note; PlaybackTime.tsx uses the same mechanism) — so this
 * check runs every frame without ever forcing a re-render of its own, and
 * `visualTime` (not `time`) matches FrameData's own guidance for anything
 * used for visual/DOM positioning.
 */
export function usePlayheadPagingScroll({
  scrollContainerRef,
  onPaged,
}: UsePlayheadPagingScrollOptions): UsePlayheadPagingScrollResult {
  const { isPlaying, registerFrameCallback, unregisterFrameCallback } = usePlaybackAnimation();

  const pageBaselineRef = useRef(0);
  const latestRef = useRef({ scrollContainerRef, isPlaying, onPaged });
  useEffect(() => {
    latestRef.current = { scrollContainerRef, isPlaying, onPaged };
  });

  // Re-anchors the baseline to wherever the view currently is every time
  // playback starts, including resuming after a pause — not just once on
  // mount. A manual scroll made *while paused* is already fully free (the
  // user confirmed that half works); this is what makes pressing Play
  // respect wherever they left the view, rather than yanking it back to an
  // older auto-followed position.
  useEffect(() => {
    if (!isPlaying) return;
    const container = scrollContainerRef.current;
    if (container) pageBaselineRef.current = container.scrollLeft;
  }, [isPlaying, scrollContainerRef]);

  useEffect(() => {
    const id = "playhead-paging-scroll";
    registerFrameCallback(id, ({ visualTime, sampleRate, samplesPerPixel }) => {
      const { scrollContainerRef: ref, isPlaying: playing, onPaged: cb } = latestRef.current;
      if (!playing) return;
      const container = ref.current;
      if (!container || !sampleRate || !samplesPerPixel) return;

      const pixelPosition = (visualTime * sampleRate) / samplesPerPixel;
      const rightEdge = pageBaselineRef.current + container.clientWidth;
      if (pixelPosition < rightEdge) return;

      const newScrollLeft = Math.max(0, Math.round(pixelPosition - LEFT_MARGIN_PX));
      container.scrollLeft = newScrollLeft;
      pageBaselineRef.current = newScrollLeft;
      cb?.(newScrollLeft);
    });
    return () => unregisterFrameCallback(id);
  }, [registerFrameCallback, unregisterFrameCallback]);

  const resyncBaseline = useCallback(() => {
    const container = latestRef.current.scrollContainerRef.current;
    if (container) pageBaselineRef.current = container.scrollLeft;
  }, []);

  return { resyncBaseline };
}
