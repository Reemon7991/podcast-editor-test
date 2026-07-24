"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePlaylistControls, usePlaylistData, useClipSplitting } from "@waveform-playlist/browser";
import { ClipActionsMenu, type ClipMenuAction } from "./ClipActionsMenu";
import { useScissorsSplit } from "../../hooks/useScissorsSplit";
import { resolveClipAt, clipPixelWidth } from "../../utils/clipGeometry";
import { TRACK_ROW_HEIGHT_PX, TRACK_WAVE_HEIGHT } from "../../utils/trackLayout";

// The header row reserved by <Waveform showClipHeaders> — derived rather
// than a third hardcoded "22" (trackLayout.ts's own copy is intentionally
// not exported, see its doc comment).
const CLIP_HEADER_HEIGHT_PX = TRACK_ROW_HEIGHT_PX - TRACK_WAVE_HEIGHT;
const BUTTON_SIZE = 18;
const BUTTON_INSET = 2;
// Extra breathing room from the visible edge of the scroll viewport (not the
// clip's own edge) so the button never sits flush against it.
const VIEWPORT_EDGE_INSET_PX = 12;

interface ClipRef {
  trackIndex: number;
  clipIndex: number;
}

interface ClipActionsOverlayProps {
  onDuplicateClip: (trackId: string, clipId: string) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
}

/**
 * Per-clip "..." actions menu (split/duplicate/delete), positioned over
 * whichever clip the pointer is currently on. The library's <Waveform> has
 * no slot for custom per-clip UI — its Clip/ClipHeader components render a
 * fixed layout with no children/render-prop escape hatch (confirmed by
 * reading @waveform-playlist/ui-components' Clip.tsx) — so this reimplements
 * just enough of its own clip-geometry math (see clipGeometry.ts) to place a
 * trigger button correctly. This same math is already established elsewhere
 * in this app (ClipDragLayer's cross-track detection, EditorShell's
 * track-click detection), not a new approach.
 *
 * Both this button and useScissorsSplit's preview line are portaled into
 * the library's own scroll container (`scrollContainerRef.current`,
 * confirmed via its source to be `position: relative` with
 * `overflow-x: auto` and clip content positioned directly inside it) rather
 * than kept as a sibling of <Waveform> — that makes them scroll natively
 * with the timeline instead of needing manual scroll-offset syncing.
 *
 * Two separate concerns, both about long clips:
 *  1. The button itself sits at the right edge of whatever portion of the
 *     clip is currently scrolled into view — not the clip's actual end —
 *     so a clip much longer than the viewport doesn't require scrolling all
 *     the way to its real end just to *reach* this menu. `viewport`
 *     (scrollLeft/clientWidth) is tracked in its own effect, updated on
 *     scroll/resize, deliberately independent from hover-detection below
 *     (which stays mousemove/mouseleave-only, unchanged) — entangling a
 *     scroll-derived value into a mousemove-driven effect was the source of
 *     a real bug in an earlier version of this feature (see git history).
 *  2. "Split" still doesn't split immediately at wherever the button
 *     happens to be — it hands off to useScissorsSplit, which arms a
 *     "click anywhere on a clip to choose the split point" mode, exactly as
 *     before. The button's improved reachability and the scissors mode's
 *     precise point-picking are complementary, not alternatives: the button
 *     gets you to the menu without a long scroll, scissors mode is still
 *     how you pick exactly where to cut.
 */
export function ClipActionsOverlay({ onDuplicateClip, onDeleteClip }: ClipActionsOverlayProps) {
  const { tracks, samplesPerPixel, timeScaleHeight, sampleRate, isReady, isDraggingRef, playoutRef } =
    usePlaylistData();
  const { scrollContainerRef } = usePlaylistControls();
  const { splitClipAt } = useClipSplitting({ tracks, samplesPerPixel, engineRef: playoutRef });

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<ClipRef | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<ClipRef | null>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, clientWidth: 0 });

  const scissors = useScissorsSplit({
    scrollContainerRef,
    scrollEl,
    tracks,
    samplesPerPixel,
    timeScaleHeight,
    sampleRate,
    splitClipAt,
  });

  // scrollContainerRef.current is only assigned by <Waveform>'s own ref
  // callback during commit. Reading it directly during render (e.g. as a
  // portal target computed inline in JSX) would race a same-commit (re)mount
  // and see the pre-rebuild value — mirrors EditorShell's own scroll-restore
  // effect, which hits the same timing issue for the same reason.
  useEffect(() => {
    setScrollEl(scrollContainerRef.current);
  }, [isReady, scrollContainerRef]);

  // Keeps `viewport` current for the button's visible-edge clamp below. Its
  // only dependency is `scrollEl`, so it never tears itself down on a
  // mousemove-triggered render.
  useEffect(() => {
    const container = scrollEl;
    if (!container) return;
    const update = () =>
      setViewport({ scrollLeft: container.scrollLeft, clientWidth: container.clientWidth });
    update();
    container.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      container.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [scrollEl]);

  // Single delegated listener on the scroll container (not per-clip
  // listeners on library DOM nodes, which get torn down on every engine
  // rebuild) computes which clip the pointer is over. Suppressed while
  // scissors mode is active — the three-dot button has no reason to appear
  // over whatever clip the scissors line happens to be crossing.
  useEffect(() => {
    const container = scrollEl;
    if (!container || scissors.active) return;

    const handleMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        setHovered(null);
        return;
      }
      const hit = resolveClipAt(e.clientX, e.clientY, container, tracks, samplesPerPixel, timeScaleHeight);
      setHovered(hit ? { trackIndex: hit.trackIndex, clipIndex: hit.clipIndex } : null);
    };
    const handleLeave = () => setHovered(null);

    container.addEventListener("mousemove", handleMove);
    container.addEventListener("mouseleave", handleLeave);
    return () => {
      container.removeEventListener("mousemove", handleMove);
      container.removeEventListener("mouseleave", handleLeave);
    };
  }, [scrollEl, scissors.active, tracks, samplesPerPixel, timeScaleHeight, isDraggingRef]);

  if (!scrollEl) return null;

  if (scissors.active) {
    if (scissors.lineX === null) return null;
    const lineHeight = timeScaleHeight + tracks.length * TRACK_ROW_HEIGHT_PX;
    return createPortal(
      <div
        style={{
          position: "absolute",
          left: scissors.lineX,
          top: 0,
          height: lineHeight,
          borderLeft: "2px dashed #f59e0b",
          pointerEvents: "none",
          zIndex: 150,
        }}
      >
        {/* Anchored just below the line's own top (not above it): the
         *  scroll container clips vertical overflow, so a negative offset
         *  here is invisible instead of floating above the ruler. */}
        <span
          style={{
            position: "absolute",
            top: 2,
            left: 0,
            transform: "translateX(-50%)",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ✂️
        </span>
      </div>,
      scrollEl
    );
  }

  const active = menuOpenFor ?? hovered;
  const activeTrack = active ? tracks[active.trackIndex] : undefined;
  const activeClip = active ? activeTrack?.clips[active.clipIndex] : undefined;

  if (!active || !activeTrack || !activeClip) return null;

  const left = Math.floor(activeClip.startSample / samplesPerPixel);
  const width = clipPixelWidth(activeClip.startSample, activeClip.durationSamples, samplesPerPixel);
  const clipRightPx = left + width;
  const viewportRightPx = viewport.scrollLeft + viewport.clientWidth - VIEWPORT_EDGE_INSET_PX;
  // Clamped to the clip's own bounds on both sides: capped at the clip's
  // real end (short clips, fully visible, behave exactly as before) and
  // floored at its start (defensive — shouldn't happen if we're hovering it
  // at all, but keeps the button from ever reporting a point outside the
  // clip it belongs to).
  const visibleRightPx = Math.max(left, Math.min(clipRightPx, viewportRightPx));

  const top = timeScaleHeight + active.trackIndex * TRACK_ROW_HEIGHT_PX;
  const buttonLeft = Math.max(left, visibleRightPx - BUTTON_SIZE - BUTTON_INSET);
  const buttonTop = top + (CLIP_HEADER_HEIGHT_PX - BUTTON_SIZE) / 2;

  const closeAndReset = () => {
    setMenuOpenFor(null);
    setHovered(null);
  };

  const actions: ClipMenuAction[] = [
    {
      id: "split",
      label: "Split",
      onSelect: () => {
        scissors.activate();
        closeAndReset();
      },
    },
    {
      id: "duplicate",
      label: "Duplicate",
      onSelect: () => {
        onDuplicateClip(activeTrack.id, activeClip.id);
        closeAndReset();
      },
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      onSelect: () => {
        onDeleteClip(activeTrack.id, activeClip.id);
        closeAndReset();
      },
    },
  ];

  return createPortal(
    <ClipActionsMenu
      key={activeClip.id}
      actions={actions}
      style={{
        position: "absolute",
        left: buttonLeft,
        top: buttonTop,
        width: BUTTON_SIZE,
        height: BUTTON_SIZE,
        zIndex: 200,
      }}
      onOpenChange={(open) => setMenuOpenFor(open ? active : null)}
    />,
    scrollEl
  );
}
