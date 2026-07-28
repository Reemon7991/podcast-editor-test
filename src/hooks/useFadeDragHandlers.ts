"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { ClipTrack, Fade } from "@waveform-playlist/browser";

/**
 * Fade-handle dragging (fade-in/fade-out duration via a corner circle) —
 * modeled on useScissorsSplit.ts's shape (raw window mousemove/mouseup/
 * keydown listeners, no @dnd-kit) rather than joining ClipDragLayer.tsx's
 * dual-DragDropProvider machinery: fade-dragging is single-clip/single-axis
 * with no cross-track or collision logic, so there's nothing to gain from
 * that complexity.
 *
 * Unlike a boundary (trim) drag, there is no engine-native fade primitive
 * (@waveform-playlist/engine's public API only has splitClip/trimClip/
 * moveClip — confirmed by reading its .d.ts) — so a committed fade edit is
 * structurally the same case as a hand-applied clip *move*: it always forces
 * one full engine rebuild on commit (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md-
 * adjacent reasoning in the fade feature plan). Routing live-preview frames
 * through the store the way trim's updateEngineOutputLive does would put a
 * fresh, non-rebuild-avoidable tracks array in front of the provider on
 * *every* mousemove — far worse than one rebuild per completed gesture. So
 * the live preview here is **entirely local state, never touching
 * store/projectStore.ts** — the real tracks-changing commit only happens
 * once, at mouseup.
 */

// Explicitly set on every Fade object this hook creates (never left
// undefined) — @waveform-playlist/playout's scheduleFades defaults an
// omitted `type` to "linear", while ui-components' FadeOverlay defaults to
// "logarithmic"; leaving it unset would make the drawn curve and the
// audible envelope mismatch. Being explicit here means the choice of curve
// shape is just this one constant, regardless of which vendor default it
// happens to agree or disagree with.
const FADE_CURVE_TYPE: NonNullable<Fade["type"]> = "linear";

/** Below this, treat the fade as removed rather than persisting a
 *  near-zero-duration Fade object nothing would meaningfully hear — matches
 *  FadeOverlay's own `duration > 0` render gate in spirit, just with a
 *  little headroom instead of an exact zero cutoff. */
const MIN_FADE_DURATION_SECONDS = 0.01;

export type FadeEdge = "in" | "out";

export interface FadeDragPreview {
  trackIndex: number;
  clipIndex: number;
  edge: FadeEdge;
  previewDurationSamples: number;
}

interface DragMeta {
  startClientX: number;
  originalDurationSamples: number;
  clipDurationSamples: number;
  /** Mirrors `dragging.previewDurationSamples`, updated alongside every
   *  setDragging call in handleMouseMove — read directly by endDrag instead
   *  of via setDragging's own updater `current` argument. Reading it that
   *  way (the first version of this hook did) meant the commit's side
   *  effects (calling onTracksChange, which flows into a Zustand `set()` and
   *  ends up updating PodcastEditor/TimelineStage) ran *inside* React's
   *  setDragging updater callback — updater functions must be pure, and
   *  triggering another component's update from inside one produces exactly
   *  React's "Cannot update a component while rendering a different
   *  component" warning (confirmed reproduced once, after a fresh page load,
   *  by an actual user of this app). This ref sidesteps the whole class of
   *  problem: endDrag reads a plain value, then calls setDragging(null)
   *  as a separate, ordinary state update — no side effects inside it. */
  previewDurationSamples: number;
}

interface UseFadeDragHandlersOptions {
  tracks: ClipTrack[];
  samplesPerPixel: number;
  onTracksChange: ((tracks: ClipTrack[]) => void) | undefined;
  isDraggingRef: MutableRefObject<boolean>;
  playPendingRef: RefObject<boolean>;
  isPlaying: boolean;
  stop: () => void;
  /** Notifies the parent a clip is drag-locked, so ClipActionsOverlay.tsx's
   *  hover state can stay pinned to it for the gesture's duration — see that
   *  file's own doc comment on fadeDragLockedFor for why this is load-
   *  bearing (a fast drag whose pointer leaves the hover hit-test would
   *  otherwise unmount this hook's consumer mid-drag, abandoning the window
   *  listeners with the mouse button still held). */
  onDragLockChange: (locked: { trackIndex: number; clipIndex: number } | null) => void;
}

export function useFadeDragHandlers({
  tracks,
  samplesPerPixel,
  onTracksChange,
  isDraggingRef,
  playPendingRef,
  isPlaying,
  stop,
  onDragLockChange,
}: UseFadeDragHandlersOptions) {
  const [dragging, setDragging] = useState<FadeDragPreview | null>(null);
  // Drag-start-captured constants, read (not reactive) from inside the
  // mousemove handler — kept out of `dragging` state so updating the preview
  // duration every frame doesn't change the *identity* of anything the
  // listener-attach effect depends on (see effect below).
  const dragMetaRef = useRef<DragMeta | null>(null);

  const startDrag = useCallback(
    (trackIndex: number, clipIndex: number, edge: FadeEdge, clientX: number) => {
      const clip = tracks[trackIndex]?.clips[clipIndex];
      if (!clip) return;
      const original = (edge === "in" ? clip.fadeIn?.duration : clip.fadeOut?.duration) ?? 0;
      const originalDurationSamples = Math.round(original * clip.sampleRate);
      dragMetaRef.current = {
        startClientX: clientX,
        originalDurationSamples,
        clipDurationSamples: clip.durationSamples,
        previewDurationSamples: originalDurationSamples,
      };
      isDraggingRef.current = true;
      onDragLockChange({ trackIndex, clipIndex });
      setDragging({ trackIndex, clipIndex, edge, previewDurationSamples: originalDurationSamples });
    },
    [tracks, isDraggingRef, onDragLockChange]
  );

  // Primitive (not object-identity) triggers for the effect below — `edge`/
  // `trackIndex`/`clipIndex` are fixed for a gesture's whole lifetime, only
  // `previewDurationSamples` changes per frame, and it's deliberately not a
  // dependency here so a mousemove never tears down and reattaches the
  // window listeners (the exact per-frame-listener-churn class of bug
  // flagged elsewhere in this app's own review notes).
  const dragTrackIndex = dragging?.trackIndex ?? null;
  const dragClipIndex = dragging?.clipIndex ?? null;
  const dragEdge = dragging?.edge ?? null;

  useEffect(() => {
    if (dragTrackIndex === null || dragClipIndex === null || dragEdge === null) return;
    const trackIndex = dragTrackIndex;
    const clipIndex = dragClipIndex;
    const edge = dragEdge;

    const endDrag = (commit: boolean) => {
      const meta = dragMetaRef.current;
      dragMetaRef.current = null;
      isDraggingRef.current = false;
      onDragLockChange(null);
      // Plain state reset — no side effects inside this updater. The commit
      // logic below runs as an ordinary side effect of calling endDrag, not
      // from inside setDragging's callback (see DragMeta.previewDurationSamples's
      // own doc comment for why that distinction is load-bearing, not style).
      setDragging(null);

      if (commit && meta) {
        const clip = tracks[trackIndex]?.clips[clipIndex];
        if (clip) {
          const fade: Fade | undefined =
            meta.previewDurationSamples / clip.sampleRate < MIN_FADE_DURATION_SECONDS
              ? undefined
              : { duration: meta.previewDurationSamples / clip.sampleRate, type: FADE_CURVE_TYPE };
          const newTracks: ClipTrack[] = tracks.map((track, tIdx) => {
            if (tIdx !== trackIndex) return track;
            return {
              ...track,
              clips: track.clips.map((c, cIdx) =>
                cIdx !== clipIndex ? c : { ...c, [edge === "in" ? "fadeIn" : "fadeOut"]: fade }
              ),
            };
          });
          // Mirrors ClipDragLayer.tsx's onDragEnd move-commit ordering
          // exactly: this commit reaches commitEngineOutput via the same
          // onTracksChange path a hand-applied move does (no engine
          // transaction, so commit()'s centralized stopIfPlaying guard
          // never runs for it) — it needs the same local guard.
          if (isPlaying) flushSync(() => stop());
          if (!playPendingRef.current) onTracksChange?.(newTracks);
        }
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      const meta = dragMetaRef.current;
      if (!meta) return;
      const deltaPx = e.clientX - meta.startClientX;
      // Fade-in: dragging right (positive deltaPx) grows the fade.
      // Fade-out: dragging left (negative deltaPx) grows the fade — flip sign.
      const deltaSamples = (edge === "in" ? deltaPx : -deltaPx) * samplesPerPixel;
      const next = Math.round(
        Math.max(0, Math.min(meta.clipDurationSamples, meta.originalDurationSamples + deltaSamples))
      );
      meta.previewDurationSamples = next;
      setDragging((current) => (current ? { ...current, previewDurationSamples: next } : current));
    };

    const handleMouseUp = () => endDrag(true);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") endDrag(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    dragTrackIndex,
    dragClipIndex,
    dragEdge,
    tracks,
    samplesPerPixel,
    onTracksChange,
    isDraggingRef,
    playPendingRef,
    isPlaying,
    stop,
    onDragLockChange,
  ]);

  return { dragging, startDrag };
}
