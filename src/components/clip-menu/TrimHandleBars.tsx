"use client";

const BAR_WIDTH = 5;
// ~42% of TRACK_WAVE_HEIGHT (96px) — taller than a small tick mark, but well
// short of the full waveform row.
const BAR_HEIGHT = 60;
// Matches ClipBoundary.tsx's own 8px hit-zone width (left boundary spans
// clip-x 0-8, right spans width-8 to width) — centering the bar within that
// same 8px strip, not just "near" the edge.
const BOUNDARY_STRIP_CENTER_OFFSET = 4;

interface TrimHandleBarsProps {
  /** Clip's own left/width in content-space px (same math clipGeometry.ts's
   *  clipPixelWidth uses). */
  left: number;
  width: number;
  /** Vertical center for both bars — the middle of the clip's waveform row
   *  (not the header), same domain FadeHandles' circles live in, so trim and
   *  fade read as one consistent "hover the clip, see what you can drag"
   *  visual band. */
  centerY: number;
}

/**
 * Purely decorative left/right trim-handle bars, portaled alongside
 * ClipActionsOverlay's "…" button and FadeHandles into the library's own
 * scroll container, gated on the exact same `active` hover state as
 * FadeHandles (see ClipActionsOverlay.tsx — that's what makes "hover
 * anywhere on the clip" reveal these, not just hovering the bar itself).
 *
 * The library's own `data-boundary-edge` strip (ClipBoundary.tsx) already
 * handles the real 8px hit-testing and drag mechanics for trim — this only
 * draws a visible "grab here" affordance on top of it, never touching
 * pointer events itself. A CSS-only `[data-boundary-edge]::after` version
 * was tried first and reverted (see globals.css's doc comment): it could
 * only ever reveal on hovering the clip's header, never the waveform body,
 * since `ClipContainer` has `pointer-events: none` on itself and only the
 * header re-enables it — a structural mismatch with FadeHandles' JS-driven,
 * pointer-events-indifferent hover hit-test.
 */
export function TrimHandleBars({ left, width, centerY }: TrimHandleBarsProps) {
  return (
    <>
      <TrimBar left={left + BOUNDARY_STRIP_CENTER_OFFSET} centerY={centerY} />
      <TrimBar left={left + width - BOUNDARY_STRIP_CENTER_OFFSET} centerY={centerY} />
    </>
  );
}

function TrimBar({ left, centerY }: { left: number; centerY: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top: centerY,
        width: BAR_WIDTH,
        height: BAR_HEIGHT,
        transform: "translate(-50%, -50%)",
        borderRadius: 3,
        background: "white",
        border: "1px solid var(--accent-purple-500)",
        pointerEvents: "none",
        zIndex: 190,
      }}
    />
  );
}
