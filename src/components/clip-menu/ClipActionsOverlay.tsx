"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  usePlaylistControls,
  usePlaylistData,
  usePlaybackAnimation,
} from "@waveform-playlist/browser";
import { ClipActionsMenu, type ClipMenuAction } from "./ClipActionsMenu";
import { FadeHandles } from "./FadeHandles";
import type { SelectedClip } from "./ClipActionsToolbar";
import type { UseScissorsSplitResult } from "../../hooks/useScissorsSplit";
import { useFadeDragHandlers } from "../../hooks/useFadeDragHandlers";
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
  /** Threaded through to useFadeDragHandlers — see its own doc comment and
   *  transport/PlayButton.tsx / timeline/ClipDragLayer.tsx for the play()/
   *  rebuild race this guards against. A fade-drag commit reaches
   *  commitEngineOutput via the same unconditional-rebuild path a hand-
   *  applied move does, so it needs the same guard. */
  playPendingRef: RefObject<boolean>;
  /** Single shared instance, owned by EditorShell.tsx (the nearest common
   *  parent of this component and the top-bar ClipActionsToolbar), so both
   *  the hover "…" menu's Split action and the toolbar's Split button arm
   *  the *same* scissors-mode state rather than two independent ones that
   *  could desync. Everything else in this component — hover tracking, fade
   *  drag, menu rendering — is unchanged; only where these two values come
   *  from moved up one level. */
  scrollEl: HTMLDivElement | null;
  scissors: UseScissorsSplitResult;
  /** Clip explicitly selected via EditorShell.tsx's click-to-select
   *  listener — distinct from `hovered` below (a transient hover reveal).
   *  Rendered here as a persistent highlight ring using the same
   *  left/width/top geometry this component already computes for the hover
   *  button, rather than recomputing it in a separate component. */
  selectedClip: SelectedClip | null;
}

/**
 * Per-clip "..." actions menu (split/duplicate/delete) AND the fade-in/
 * fade-out drag handles (FadeHandles.tsx), both positioned over whichever
 * clip the pointer is currently on. Fade handles reuse this file's existing
 * hover-tracking (`active`/`activeTrack`/`activeClip`/`left`/`width`) rather
 * than running a second mousemove listener — see `fadeDragLockedFor`'s own
 * comment below for why the sticky-lock addition is load-bearing, not
 * cosmetic. The library's <Waveform> has
 * no slot for custom per-clip UI — its Clip/ClipHeader components render a
 * fixed layout with no children/render-prop escape hatch (confirmed by
 * reading @waveform-playlist/ui-components' Clip.tsx) — so this reimplements
 * just enough of its own clip-geometry math (see clipGeometry.ts) to place a
 * trigger button correctly. This same math is already established elsewhere
 * in this app (ClipDragLayer's cross-track detection, EditorShell's
 * track-click detection), not a new approach.
 *
 * Both this button and the scissors preview line (state owned by
 * EditorShell.tsx, passed down as the `scissors` prop — see that prop's own
 * doc comment) are portaled into the library's own scroll container
 * (`scrollEl` prop, confirmed via its source to be `position: relative` with
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
export function ClipActionsOverlay({
  onDuplicateClip,
  onDeleteClip,
  playPendingRef,
  scrollEl,
  scissors,
  selectedClip,
}: ClipActionsOverlayProps) {
  const { tracks, samplesPerPixel, timeScaleHeight, isDraggingRef, onTracksChange } = usePlaylistData();
  const { stop } = usePlaylistControls();
  const { isPlaying } = usePlaybackAnimation();

  const [hovered, setHovered] = useState<ClipRef | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<ClipRef | null>(null);
  const [fadeDragLockedFor, setFadeDragLockedFor] = useState<ClipRef | null>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, clientWidth: 0 });

  // The mousemove hover-tracking effect below already nulls `hovered` out
  // for the whole gesture whenever isDraggingRef.current is true — a signal
  // shared with trim/move drags, and now also set by useFadeDragHandlers.ts
  // for the fade-drag's own duration. That's fine *during* the drag
  // (fadeDragLockedFor keeps `active` pinned instead), but nothing
  // naturally repopulates `hovered` once the drag ends unless a real
  // mousemove happens afterward — invisible for a *committed* fade (the
  // resulting rebuild remounts this whole subtree anyway, resetting local
  // state), but real for an Escape-cancelled one (no rebuild, so no
  // remount): without restoring `hovered` here, the "…" button and fade
  // handles would silently vanish the instant Escape is pressed, staying
  // gone until the user moves the mouse again.
  const handleFadeDragLockChange = useCallback((locked: ClipRef | null) => {
    setFadeDragLockedFor((prevLocked) => {
      if (locked === null && prevLocked !== null) {
        setHovered(prevLocked);
      }
      return locked;
    });
  }, []);

  const fadeDrag = useFadeDragHandlers({
    tracks,
    samplesPerPixel,
    onTracksChange,
    isDraggingRef,
    playPendingRef,
    isPlaying,
    stop,
    onDragLockChange: handleFadeDragLockChange,
  });

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

  // Independent of hover — drawn for whichever clip is `selectedClip`
  // (EditorShell.tsx's click-to-select state), re-resolved from the live
  // `tracks` array by id every render rather than trusting cached indices,
  // so it stays correct across reorders/undo with no separate staleness
  // guard needed here. Reuses the same left/width/top math the hover button
  // below already computes, just for a different clip reference.
  //
  // A darker border (vs. the always-on light one from globals.css's
  // [data-clip-container] rule) plus a translucent purple wash for "slightly
  // darker background" — drawn as an overlay on top of the clip's own canvas
  // rather than an actual background-color, since that canvas paints every
  // pixel opaquely (see waveformTheme.ts's doc comment) and would hide a
  // plain background underneath it entirely.
  const selectedTrack = selectedClip ? tracks.find((t) => t.id === selectedClip.trackId) : undefined;
  const selectedClipObj = selectedTrack?.clips.find((c) => c.id === selectedClip?.clipId);
  const selectedTrackIndex = selectedTrack ? tracks.indexOf(selectedTrack) : -1;
  const selectionRingEl =
    selectedTrack && selectedClipObj && selectedTrackIndex !== -1
      ? createPortal(
          <div
            style={{
              position: "absolute",
              left: Math.floor(selectedClipObj.startSample / samplesPerPixel) - 2,
              top: timeScaleHeight + selectedTrackIndex * TRACK_ROW_HEIGHT_PX - 2,
              width:
                clipPixelWidth(selectedClipObj.startSample, selectedClipObj.durationSamples, samplesPerPixel) +
                4,
              height: TRACK_ROW_HEIGHT_PX + 4,
              background: "rgba(73, 43, 151, 0.14)",
              border: "2px solid var(--accent-purple-600)",
              borderRadius: 12,
              pointerEvents: "none",
              zIndex: 120,
            }}
          />,
          scrollEl
        )
      : null;

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

  // fadeDragLockedFor keeps `active` pinned to the clip being fade-dragged
  // for the whole gesture — load-bearing, not cosmetic: without it, a fast
  // drag whose pointer momentarily leaves this clip's hover hit-test would
  // fall through to `hovered` (possibly null), unmounting <FadeHandles>
  // mid-gesture and tearing down useFadeDragHandlers.ts's window listeners
  // while the mouse button is still held.
  const active = menuOpenFor ?? fadeDragLockedFor ?? hovered;
  const activeTrack = active ? tracks[active.trackIndex] : undefined;
  const activeClip = active ? activeTrack?.clips[active.clipIndex] : undefined;

  if (!active || !activeTrack || !activeClip) return selectionRingEl;

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
        // Duplicate/delete both go through `commit`, which stops playback
        // first if needed on its own now — see projectStore.ts's
        // `stopIfPlaying`/`registerStopIfPlaying` doc comment. No local guard
        // needed here anymore.
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

  return (
    <>
      {selectionRingEl}
      {createPortal(
        <>
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
          />
          <FadeHandles
            trackIndex={active.trackIndex}
            clipIndex={active.clipIndex}
            clip={activeClip}
            left={left}
            width={width}
            top={top + CLIP_HEADER_HEIGHT_PX}
            samplesPerPixel={samplesPerPixel}
            dragging={fadeDrag.dragging}
            onStartDrag={fadeDrag.startDrag}
          />
        </>,
        scrollEl
      )}
    </>
  );
}
