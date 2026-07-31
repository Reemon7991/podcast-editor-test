import type { WaveformPlaylistTheme } from "@waveform-playlist/ui-components";
import {
  PURPLE_50,
  PURPLE_100,
  PURPLE_500,
  PURPLE_600,
  PURPLE_700,
  PLAYHEAD_ORANGE,
  NEUTRAL_BACKGROUND,
  NEUTRAL_SURFACE,
  NEUTRAL_BORDER,
  NEUTRAL_TEXT,
  NEUTRAL_TEXT_MUTED,
  RADIUS_MD,
  FONT_FAMILY,
} from "./tokens";

// Pill-capped bars (the async.com look) — barWidth >= 3 with a non-zero
// barGap is what makes roundedBars visually read as separate pills rather
// than a solid block (per @waveform-playlist/ui-components' own doc comment
// on ChannelProps.roundedBars).
export const WAVEFORM_BAR_WIDTH = 2;
export const WAVEFORM_BAR_GAP = 1;
export const WAVEFORM_ROUNDED_BARS = true;

/**
 * `waveformDrawMode: "inverted"` (kept from the library's own default/dark
 * themes) flips the naming: `waveOutlineColor` is the solid background fill
 * behind the bars, `waveFillColor` is the bar color itself — confirmed by
 * reading both @waveform-playlist/ui-components' defaultTheme AND darkTheme
 * source side by side (their own inline comments agree on this reading only
 * when cross-checked against darkTheme's actual values, since defaultTheme's
 * comment placement is ambiguous on its own).
 *
 * `waveOutlineColor` drives two different-looking things with one value,
 * confirmed by reading the vendor source: (1) an unselected track row's own
 * background in the empty space around/between clips (Track.tsx's
 * ChannelContainer, via a `backgroundColor` prop the browser package derives
 * straight from this theme field, with `theme.selectedTrackBackground`
 * taking over — natively, no CSS involved — whenever that row's own
 * `$isSelected` is true), and (2) the *complement* fill a clip's own canvas
 * paints in gaps between rounded bars and wherever peak height is short
 * (Channel.tsx's inverted-mode draw path).
 *
 * Kept at the neutral off-white tone (not purple) specifically so
 * `ChannelContainer`'s native selected/unselected switch keeps working
 * un-fought: `$isSelected` is a styled-components transient prop, never
 * rendered to the DOM, so there is no stable attribute a CSS override could
 * key off of to reproduce that same conditional — a previous attempt at
 * forcing this row's background off-white via a
 * `[data-track-id]:not([data-clip-container])` CSS rule got this wrong,
 * applying unconditionally and silently overriding
 * `selectedTrackBackground` even when a track *was* selected. Reverted; that
 * rule now only contributes the row-separator border (see globals.css).
 *
 * The clip's own light-purple tint (independent of this field, so it can't
 * regress this same way again) comes from `[data-clip-container]::after` in
 * globals.css instead — a translucent overlay painted on top of the canvas
 * rather than a background trying to compete with it (the canvas paints
 * every pixel opaquely in this draw mode, via `ctx.fill("evenodd")`, so a
 * plain background underneath it is invisible regardless of what it's set
 * to).
 */
export const waveformTheme: Partial<WaveformPlaylistTheme> = {
  waveformDrawMode: "inverted",
  waveOutlineColor: NEUTRAL_SURFACE,
  waveFillColor: PURPLE_500,
  waveProgressColor: "rgba(73, 43, 151, 0.12)",
  // Deliberately identical to the unselected values above, not a distinct
  // "selected" look: whole-track selection (clicking anywhere in a track,
  // via EditorShell.tsx's handleWaveformPointerDown) is a different concept
  // from selecting one specific clip (EditorShell.tsx's own click-to-select
  // → ClipActionsOverlay.tsx's selectionRingEl/overlay), and the two should
  // not visually conflate — selecting a track must not darken every clip on
  // it. Only the specific selected clip should ever look "active", via that
  // separate ring/overlay mechanism, not via this theme field.
  selectedWaveOutlineColor: NEUTRAL_SURFACE,
  selectedWaveFillColor: PURPLE_500,

  selectedTrackControlsBackground: PURPLE_50,
  selectedTrackBackground: PURPLE_50,

  timeColor: NEUTRAL_TEXT_MUTED,
  timescaleBackgroundColor: NEUTRAL_BACKGROUND,
  // One-off exception to the single-purple-accent rule — see
  // tokens.ts's PLAYHEAD_ORANGE for why.
  playheadColor: PLAYHEAD_ORANGE,
  selectionColor: "rgba(73, 43, 151, 0.15)",
  loopRegionColor: "rgba(73, 43, 151, 0.12)",
  loopMarkerColor: PURPLE_600,

  // Kept as the same light tint requested earlier (matching the clip body's
  // *visible* tone, not its now-off-white theme base) — see
  // [data-clip-container]::after in globals.css for how the body gets there
  // via an overlay instead of this same theme field now that waveOutlineColor
  // had to move back to off-white (see this const's own doc comment above).
  clipHeaderBackgroundColor: PURPLE_100,
  clipHeaderBorderColor: "rgba(73, 43, 151, 0.12)",
  clipHeaderTextColor: PURPLE_700,
  clipHeaderFontFamily: FONT_FAMILY,
  // Same reasoning as selectedWaveOutlineColor/selectedWaveFillColor above —
  // identical to the unselected value on purpose, so a clip's header doesn't
  // darken just because its track is selected.
  selectedClipHeaderBackgroundColor: PURPLE_100,

  fadeOverlayColor: "rgba(73, 43, 151, 0.35)",

  backgroundColor: NEUTRAL_BACKGROUND,
  surfaceColor: NEUTRAL_SURFACE,
  borderColor: NEUTRAL_BORDER,
  textColor: NEUTRAL_TEXT,
  textColorMuted: NEUTRAL_TEXT_MUTED,

  inputBackground: NEUTRAL_BACKGROUND,
  inputBorder: NEUTRAL_BORDER,
  inputText: NEUTRAL_TEXT,
  inputPlaceholder: NEUTRAL_TEXT_MUTED,
  inputFocusBorder: PURPLE_500,

  buttonBackground: PURPLE_500,
  buttonText: NEUTRAL_BACKGROUND,
  buttonBorder: PURPLE_600,
  buttonHoverBackground: PURPLE_600,

  sliderTrackColor: NEUTRAL_BORDER,
  sliderThumbColor: PURPLE_500,

  borderRadius: RADIUS_MD,
  fontFamily: FONT_FAMILY,
  fontSize: "13px",
  fontSizeSmall: "11px",
};
