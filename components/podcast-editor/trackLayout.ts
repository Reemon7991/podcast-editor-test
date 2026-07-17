/**
 * Pixel height of one track row as actually rendered by <Waveform>: the
 * configured waveform height plus the clip-header row reserved whenever
 * showClipHeaders is enabled. The header height (22px) isn't exposed as a
 * prop, so this is empirically measured from the rendered DOM (confirmed via
 * two independent anchors — the per-track control label and the Mute button
 * — both showing a uniform 118px stride across tracks, empty or populated).
 * Revisit this if TRACK_WAVE_HEIGHT or showClipHeaders changes.
 */
export const TRACK_WAVE_HEIGHT = 96;
const CLIP_HEADER_HEIGHT = 22;
export const TRACK_ROW_HEIGHT_PX = TRACK_WAVE_HEIGHT + CLIP_HEADER_HEIGHT;
