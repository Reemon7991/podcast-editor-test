// Centers the timeline's horizontal scroll on a given timeline position.
// Pure pixel math + a thin DOM-touching wrapper (same split as
// silenceDetection.ts's detectKeepRanges/spliceOutSilence) — the math is
// Node-testable on its own, the wrapper is what components actually call.
//
// Exists for exactly one gap: @waveform-playlist/browser's own auto-scroll
// (WaveformPlaylistProvider's `automaticScroll` prop, wired on in
// TimelineStage.tsx) only runs inside the per-frame animation loop `play()`
// starts — confirmed by reading its dist source (the scroll-centering block
// lives in `startAnimationLoop`'s `updateTime`, only ever invoked from
// `play()`/the post-rebuild resume path). A plain `seekTo()` while paused —
// exactly what selecting a search result does — never touches scroll at
// all. `centerScrollOnTimeSeconds` below is this app's own fill-in for that
// one case, using the same centering formula the library's own auto-scroll
// block uses (`pixelPosition - containerWidth / 2`, clamped to >= 0 and left
// to the browser to clamp the upper bound) so a deliberate "jump here" reads
// the same as the continuous "follow playback" case.

/** `containerWidth` in px, `timeSeconds`/`sampleRate`/`samplesPerPixel` as
 *  usual. Returns the scrollLeft that puts `timeSeconds` at the horizontal
 *  center of the viewport, clamped to >= 0 (the browser clamps the upper
 *  bound itself on assignment — same as the library's own block does). */
export function computeCenteredScrollLeft(
  timeSeconds: number,
  sampleRate: number,
  samplesPerPixel: number,
  containerWidth: number
): number {
  const pixelPosition = (timeSeconds * sampleRate) / samplesPerPixel;
  return Math.max(0, Math.round(pixelPosition - containerWidth / 2));
}

/**
 * Direct assignment, not `scrollTo({behavior:"smooth"})` — deliberately.
 * EditorShell.tsx's own scroll-position-preserving effect (restores
 * `scrollLeft` after an engine rebuild remounts the scroll container as a
 * fresh DOM node) runs on every render and reads a ref that's only kept in
 * sync via the container's native `scroll` event, which fires
 * *asynchronously* — a smooth, multi-frame animation would race that effect
 * and could get snapped back mid-flight to wherever the timeline was
 * scrolled before this jump. Callers that need the ref kept in sync with a
 * deliberate jump (see EditorShell.tsx's own handleScrollToTime) must update
 * it themselves, synchronously, right after calling this.
 */
export function centerScrollOnTimeSeconds(
  container: HTMLDivElement,
  timeSeconds: number,
  sampleRate: number,
  samplesPerPixel: number
): void {
  if (!sampleRate || !samplesPerPixel) return;
  container.scrollLeft = computeCenteredScrollLeft(
    timeSeconds,
    sampleRate,
    samplesPerPixel,
    container.clientWidth
  );
}
