interface MixerState {
  muted: boolean;
  soloed: boolean;
}

/**
 * Indices of tracks that actually play, matching TonePlayout's live solo/mute
 * rules: if any track is soloed, only soloed-and-not-muted tracks play.
 * Otherwise, just not-muted tracks play.
 */
export function audibleIndices(states: MixerState[]): number[] {
  const hasSoloed = states.some((s) => s.soloed);
  return states
    .map((_, i) => i)
    .filter((i) => (hasSoloed ? states[i].soloed && !states[i].muted : !states[i].muted));
}
