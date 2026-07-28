"use client";

import type { AudioClip } from "@waveform-playlist/browser";
import type { FadeDragPreview, FadeEdge } from "../../hooks/useFadeDragHandlers";

const HANDLE_SIZE = 10;

interface FadeHandlesProps {
  trackIndex: number;
  clipIndex: number;
  clip: AudioClip;
  /** Clip's own left/width in content-space px (same math clipGeometry.ts's
   *  clipPixelWidth uses). */
  left: number;
  width: number;
  /** Y position where the waveform area (not the header row) begins for
   *  this clip's row — the same y-origin the vendor's own FadeOverlay curve
   *  starts drawing at. */
  top: number;
  samplesPerPixel: number;
  dragging: FadeDragPreview | null;
  onStartDrag: (trackIndex: number, clipIndex: number, edge: FadeEdge, clientX: number) => void;
}

/**
 * Draggable fade-in/fade-out circles, portaled alongside ClipActionsOverlay's
 * "…" button into the library's own scroll container. Purely presentational
 * — all drag mechanics live in useFadeDragHandlers.ts (raw window pointer
 * events, no @dnd-kit — see that file's own doc comment for why).
 *
 * Position comes from `dragging`'s local preview state while this clip is
 * being dragged (immediate 1:1 handle feedback), and from the clip's real
 * fadeIn/fadeOut otherwise. The vendor's own FadeOverlay curve is driven by
 * `tracks`, which only updates once the drag commits and the resulting
 * engine rebuild completes — so during the drag itself, the curve doesn't
 * visually track the handle.
 */
export function FadeHandles({
  trackIndex,
  clipIndex,
  clip,
  left,
  width,
  top,
  samplesPerPixel,
  dragging,
  onStartDrag,
}: FadeHandlesProps) {
  const isDraggingThis =
    dragging !== null && dragging.trackIndex === trackIndex && dragging.clipIndex === clipIndex;

  const fadeInSamples =
    isDraggingThis && dragging.edge === "in"
      ? dragging.previewDurationSamples
      : Math.round((clip.fadeIn?.duration ?? 0) * clip.sampleRate);
  const fadeOutSamples =
    isDraggingThis && dragging.edge === "out"
      ? dragging.previewDurationSamples
      : Math.round((clip.fadeOut?.duration ?? 0) * clip.sampleRate);

  const fadeInWidthPx = Math.floor(fadeInSamples / samplesPerPixel);
  const fadeOutWidthPx = Math.floor(fadeOutSamples / samplesPerPixel);

  const fadeInHandleLeft = left + fadeInWidthPx;
  const fadeOutHandleLeft = left + width - fadeOutWidthPx;

  return (
    <>
      <FadeHandleCircle
        edge="in"
        left={fadeInHandleLeft}
        top={top}
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartDrag(trackIndex, clipIndex, "in", e.clientX);
        }}
      />
      <FadeHandleCircle
        edge="out"
        left={fadeOutHandleLeft}
        top={top}
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartDrag(trackIndex, clipIndex, "out", e.clientX);
        }}
      />
    </>
  );
}

function FadeHandleCircle({
  edge,
  left,
  top,
  onMouseDown,
}: {
  edge: FadeEdge;
  left: number;
  top: number;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      data-fade-handle={edge}
      title={edge === "in" ? "Drag to set fade in" : "Drag to set fade out"}
      onMouseDown={onMouseDown}
      style={{
        position: "absolute",
        left,
        top,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        transform: "translate(-50%, -50%)",
        borderRadius: "50%",
        background: "rgba(255, 255, 255, 0.9)",
        border: "1px solid rgba(0, 0, 0, 0.4)",
        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.3)",
        cursor: "ew-resize",
        zIndex: 190,
        pointerEvents: "auto",
      }}
    />
  );
}
