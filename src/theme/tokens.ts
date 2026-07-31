/**
 * Single source of truth for the app's color palette. One brand accent
 * (#492b97, purple) used everywhere — buttons, selection states, and the
 * waveform/clip visuals — not a second, separate accent color. Tints lighten
 * toward white, shades darken toward black, both computed from the same
 * base hue so everything reads as one family.
 *
 * Consumed by both plain Tailwind classNames (components) and
 * `theme/waveformTheme.ts` (the vendored `@waveform-playlist` theme object)
 * so the two never drift out of sync by hand-copying hex values twice.
 */
export const PURPLE_50 = "#f6f4fa";
export const PURPLE_100 = "#e9e6f3";
export const PURPLE_200 = "#d2cae5";
export const PURPLE_300 = "#ada0d0";
export const PURPLE_500 = "#492b97";
export const PURPLE_600 = "#3e2580";
export const PURPLE_700 = "#331e6a";

// Deliberate one-off exception to "one purple accent everywhere": the
// playhead specifically needs to stay legible crossing both light-purple
// clip fills and white/off-white empty track space, and a contrasting hue
// (not just a darker/lighter purple) is what makes a moving playhead easy
// to track against a busy waveform — the same reason most DAWs don't use
// their own brand color for it either.
export const PLAYHEAD_ORANGE = "#f97316";

export const NEUTRAL_BACKGROUND = "#ffffff";
export const NEUTRAL_SURFACE = "#fafafa";
export const NEUTRAL_BORDER = "#e4e4e7";
export const NEUTRAL_TEXT = "#18181b";
export const NEUTRAL_TEXT_MUTED = "#71717a";

export const RADIUS_SM = "6px";
export const RADIUS_MD = "10px";
export const RADIUS_PILL = "999px";

export const FONT_FAMILY =
  "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
