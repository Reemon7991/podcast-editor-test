/**
 * Small curated list of Cartesia voice ids for the "Generate clip (AI)"
 * picker — v1 deliberately ships a hardcoded list instead of fetching
 * Cartesia's full voice library at runtime (see TTS_CARTESIA_PLAN.md).
 *
 * Shared between the client (voice `<select>` in GenerateSpeechModal.tsx)
 * and the server (`src/app/api/tts/route.ts`'s allow-list check) so there's
 * one source of truth instead of two lists that could drift.
 *
 * Verified live against `GET https://api.cartesia.ai/voices` for this app's
 * own `CARTESIA_API_KEY` (not just recalled from training data — that
 * distinction mattered here: three of an earlier hardcoded guess's four ids
 * turned out to genuinely exist, but the fourth didn't exist at all, which
 * would have 404'd on every single use, not occasionally). Names below are
 * each voice's current name in that response — Cartesia's own catalog
 * naming, not invented here. Re-verify against the same endpoint if this
 * ever starts 404ing consistently (rather than the odd transient 404 seen
 * once during testing, believed to be a Cartesia-side blip since the id
 * involved is confirmed to exist).
 */
export interface CartesiaVoice {
  id: string;
  name: string;
}

export const CARTESIA_VOICES: CartesiaVoice[] = [
  { id: "a0e99841-438c-4a64-b679-ae501e7d6091", name: "Greg - Supporter" },
  { id: "156fb8d2-335b-4950-9cb3-a2d33befec77", name: "Sunny - Pep Talker" },
  { id: "bf0a246a-8642-498a-9950-80c35e9276b5", name: "Sophie - Teacher" },
  { id: "5568a7df-e5ab-4442-9fae-2e9ba1b15ad8", name: "Quentin - Refined Narrator" },
];

export const DEFAULT_CARTESIA_VOICE_ID = CARTESIA_VOICES[0].id;

export function isKnownCartesiaVoiceId(voiceId: string): boolean {
  return CARTESIA_VOICES.some((v) => v.id === voiceId);
}

/**
 * Max input text length for "Generate clip (AI)" — kept here rather than in
 * `src/app/api/tts/route.ts` (server validation) or
 * `GenerateSpeechModal.tsx` (the textarea's `maxLength`) alone, for the same
 * reason `CARTESIA_VOICES` lives in one shared file: two independently
 * declared copies of this number can only drift, and this file is already
 * the one place both the client and the server import shared TTS config
 * from.
 */
export const MAX_TTS_TEXT_LENGTH = 5000;
