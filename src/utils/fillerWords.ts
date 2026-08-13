// Curated, hardcoded v1 filler-word dictionaries — same "not fetched/derived
// at runtime" precedent as cartesiaVoices.ts. Deliberately narrow: only
// short, non-lexical hesitation interjections ("um", "uh", "erm", "ah") —
// NOT semantically-ambiguous words ("like", "so", "actually") or multi-word
// fillers ("you know", "i mean", "sort of", "kind of"). Those have a real
// false-positive risk (e.g. "like" as a verb, or an Arabic word that's only
// a filler without its diacritics) that a plain interjection never does —
// deliberately out of scope for v1, per the product call, which is also
// what makes auto-removal safe with no per-word review step (see
// useFillerWordRemoval.ts).
//
// English and Arabic podcasts both need covering. Rather than tracking a
// separate "which language is this transcript" setting (a real gap — see
// TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 6 note on Whisper/
// OpenRouter mistranslating non-English audio to English when no `language`
// param is sent, confirmed live and deliberately NOT fixed as part of this
// feature), detection here works directly off each transcript word's own
// script: Arabic-range characters match the Arabic dictionary, everything
// else matches the English one. No language field, no extra state — correct
// for whatever a transcript actually contains, and free of the "is this
// project English or Arabic" question entirely.
//
// IMPORTANT, confirmed live against real Whisper output (TTS-synthesized
// speech that clearly spoke "um"/"uh" and their Arabic equivalents, round-
// tripped through the actual OpenRouter transcription endpoint this app
// uses): Whisper frequently omits filler words from its own word-level
// transcript entirely — it's trained to produce a clean, readable transcript
// and often just drops a hesitation sound rather than transcribing it as a
// word. This feature can only catch whichever filler-word instances Whisper
// happens to keep; it is not an audio-level disfluency detector. Disclosed,
// not silently accepted — see CLAUDE.md's filler-word-removal section.

// Canonical/normalized forms only — see normalizeFillerCandidate below,
// applied to every candidate word before comparing against these.
const EN_FILLER_WORDS = new Set([
  "um",
  "umm",
  "uhm",
  "uh",
  "uhh",
  "erm",
  "err",
  "ah",
  "ahh",
  "hmm",
  "hm",
  "mm",
  "mhm",
]);

// Bare (no diacritics), alef-unified forms — see normalizeArabic. Kept
// tighter than the English list: some superficially similar Arabic
// interjections double as real words once diacritics are stripped (e.g.
// bare alef-mim, U+0627 U+0645, is also "mother") — the same ambiguity risk
// that ruled out "like" above, so those are left out rather than guessed
// at. Spelled out in \uXXXX escapes (not literal characters) so the exact
// codepoints are unambiguous on review, same discipline as the ranges below.
const AR_UMM = "امم"; // ا م م — "umm"
const AR_AH = "اه"; // ا ه — "ah"/"uh"
const AR_AH_ELONGATED = "اهه"; // ا ه ه — elongated "ah"
const AR_FILLER_WORDS = new Set([AR_UMM, AR_AH, AR_AH_ELONGATED]);

// Arabic script: main block (U+0600-U+06FF), Supplement (U+0750-U+077F),
// Extended-A (U+08A0-U+08FF), Presentation Forms A/B (U+FB50-U+FDFF,
// U+FE70-U+FEFF) — enough to reliably tell an Arabic word from a Latin one
// without a dedicated language-detection library; this app only needs a
// two-way split.
const ARABIC_SCRIPT_PATTERN = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

// Arabic diacritics (tashkeel, U+064B-U+065F) plus superscript alef
// (U+0670) — stripped before matching so a diacritized and undiacritized
// spelling of the same word normalize to the same key.
const ARABIC_DIACRITICS_PATTERN = /[ً-ٰٟ]/g;

// Alef variants (hamza-above U+0623, hamza-below U+0625, madda U+0622) all
// unify to bare alef (U+0627) — Whisper and Cartesia both round-trip the
// same spoken sound through different written alef forms (confirmed live: a
// script's plain bare-alef "اه" came back from a real TTS -> Whisper pass
// spelled with the madda form instead), so matching bare-alef is required,
// not just a nicety.
const ARABIC_ALEF_VARIANTS_PATTERN = /[أإآ]/g;
const BARE_ALEF = "ا";

// Strips leading/trailing punctuation (Latin AND Arabic — e.g. "um,",
// Arabic-comma-suffixed text, "uh?") via the Unicode letter/number
// boundary, without touching internal characters.
function stripPunctuation(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

// Collapses 3+ repeated characters down to 2 ("ummmm" -> "umm", an
// elongated Arabic "ه" run collapses the same way) — a held interjection is
// sometimes elongated in both TTS and real speech; the dictionaries above
// only list up-to-2-repeat canonical forms.
function collapseRepeatedChars(word: string): string {
  return word.replace(/(.)\1{2,}/gu, "$1$1");
}

function normalizeArabic(word: string): string {
  return word.replace(ARABIC_DIACRITICS_PATTERN, "").replace(ARABIC_ALEF_VARIANTS_PATTERN, BARE_ALEF);
}

/** Normalizes a raw transcript word into the canonical form the dictionaries
 *  above are keyed on. Exported so the confirmation summary's own grouping
 *  (utils/fillerWordDetection.ts) stays in lockstep with matching. */
export function normalizeFillerCandidate(word: string): string {
  const stripped = collapseRepeatedChars(stripPunctuation(word).toLowerCase());
  return ARABIC_SCRIPT_PATTERN.test(stripped) ? normalizeArabic(stripped) : stripped;
}

/** True if `word` (raw, as it appears in a transcript — punctuation/casing
 *  untouched) is a recognized filler word in either language's dictionary,
 *  selected automatically by the word's own script. */
export function isFillerWord(word: string): boolean {
  const normalized = normalizeFillerCandidate(word);
  if (normalized.length === 0) return false;
  const dictionary = ARABIC_SCRIPT_PATTERN.test(normalized) ? AR_FILLER_WORDS : EN_FILLER_WORDS;
  return dictionary.has(normalized);
}

/** Display label for a matched word in the confirmation summary — original
 *  transcript spelling with surrounding punctuation stripped (not the
 *  normalized dictionary key), so it still reads naturally. */
export function fillerWordDisplayLabel(word: string): string {
  return stripPunctuation(word);
}
