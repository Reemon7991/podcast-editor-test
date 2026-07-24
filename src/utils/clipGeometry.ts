import type { ClipTrack } from "@waveform-playlist/browser";
import { TRACK_ROW_HEIGHT_PX } from "./trackLayout";

export interface ClipHit {
  trackIndex: number;
  clipIndex: number;
  /** Content-space sample position of the pointer (not clamped to the hit
   *  clip's own bounds). */
  sample: number;
}

/**
 * Resolves a pointer position (viewport coordinates) to whichever clip it
 * lands on, in content-space (i.e. accounting for horizontal scroll) — the
 * library's <Waveform> exposes no per-clip DOM hook to hit-test against
 * directly, so this reimplements its own layout math (left/width from
 * startSample/durationSamples/samplesPerPixel, row from trackIndex *
 * TRACK_ROW_HEIGHT_PX), same as ClipDragLayer's cross-track detection and
 * EditorShell's track-click detection already do elsewhere in this app.
 * Shared between hover-detection (ClipActionsOverlay) and scissors-mode
 * click detection (useScissorsSplit) rather than duplicated between them.
 */
export function resolveClipAt(
  clientX: number,
  clientY: number,
  container: HTMLElement,
  tracks: ClipTrack[],
  samplesPerPixel: number,
  timeScaleHeight: number
): ClipHit | null {
  const rect = container.getBoundingClientRect();
  const contentX = clientX - rect.left + container.scrollLeft;
  const trackAreaY = clientY - rect.top - timeScaleHeight;
  if (trackAreaY < 0) return null;
  const trackIndex = Math.floor(trackAreaY / TRACK_ROW_HEIGHT_PX);
  const track = tracks[trackIndex];
  if (!track) return null;
  const sample = contentX * samplesPerPixel;
  const clipIndex = track.clips.findIndex(
    (c) => sample >= c.startSample && sample < c.startSample + c.durationSamples
  );
  if (clipIndex === -1) return null;
  return { trackIndex, clipIndex, sample };
}

/** Content-space (unscrolled) X for a clientX within `container`. */
export function contentXFromClientX(clientX: number, container: HTMLElement): number {
  return clientX - container.getBoundingClientRect().left + container.scrollLeft;
}

// @waveform-playlist/browser doesn't re-export core's clipPixelWidth (only
// @waveform-playlist/core does, which isn't a direct dependency here) —
// this mirrors that function's implementation exactly (confirmed by reading
// @waveform-playlist/core's source, the same formula <Waveform>'s own Clip
// rendering uses for pixel width).
export function clipPixelWidth(startSample: number, durationSamples: number, samplesPerPixel: number) {
  return (
    Math.floor((startSample + durationSamples) / samplesPerPixel) -
    Math.floor(startSample / samplesPerPixel)
  );
}
