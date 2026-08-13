/**
 * Curated Cartesia voice ids for the "Generate clip (AI)" picker — the
 * *choice* of which voices to offer is still a static, deliberate list
 * (same "not fetching Cartesia's full 864-voice catalog" call as before),
 * but each voice's display name/description/preview now come from a live,
 * server-cached Cartesia call (`src/app/api/tts/cartesiaVoiceCache.ts`)
 * instead of being hand-typed here — a hardcoded name/description could
 * silently drift from Cartesia's own catalog with no warning; a hardcoded
 * id can only 404, which is loud.
 *
 * `FALLBACK_VOICE_NAMES` below is only a safety net (first paint before the
 * live fetch resolves, or if that fetch fails outright) — never the source
 * of truth for display text once live data is available.
 */
export interface CartesiaVoice {
  id: string;
  name: string;
}

// Verified live against GET https://api.cartesia.ai/voices (language=en,
// is_public, not archived) AND GET .../voices/:id?expand[]=preview_file_url
// (same discipline as the original 4 — see this file's git history: an
// earlier hardcoded guess included one id that simply didn't exist). Every
// id below is confirmed to both exist and have a real preview available —
// Quentin (the original 4th voice) was dropped here since it has no
// preview. 15 voices, generic/professional-sounding, mixed gender.
export const CURATED_CARTESIA_VOICE_IDS: string[] = [
  "a0e99841-438c-4a64-b679-ae501e7d6091",
  "156fb8d2-335b-4950-9cb3-a2d33befec77",
  "bf0a246a-8642-498a-9950-80c35e9276b5",
  "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
  "829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30",
  "2a12b36c-7f9b-4c3a-9f7a-72731b15323a",
  "ef191366-f52f-447a-a398-ed8c0f2943a1",
  "62ae83ad-4f6a-430b-af41-a9bede9286ca",
  "630ed21c-2c5c-41cf-9d82-10a7fd668370",
  "f6ff7c0c-e396-40a9-a70b-f7607edb6937",
  "f786b574-daa5-4673-aa0c-cbe3e8534c02",
  "a5136bf9-224c-4d76-b823-52bd5efcffcc",
  "87286a8d-7ea7-4235-a41a-dd9fa6630feb",
  "d46abd1d-2d02-43e8-819f-51fb652c1c61",
  "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e",
];

// Last-known-good names, only for first paint / a totally failed live fetch.
export const FALLBACK_VOICE_NAMES: Record<string, string> = {
  "a0e99841-438c-4a64-b679-ae501e7d6091": "Greg - Supporter",
  "156fb8d2-335b-4950-9cb3-a2d33befec77": "Sunny - Pep Talker",
  "bf0a246a-8642-498a-9950-80c35e9276b5": "Sophie - Teacher",
  "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4": "Skylar - Friendly Guide",
  "829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30": "Linda - Conversational Guide",
  "2a12b36c-7f9b-4c3a-9f7a-72731b15323a": "Ella - Caring Scout",
  "ef191366-f52f-447a-a398-ed8c0f2943a1": "Archie - Approachable Mate",
  "62ae83ad-4f6a-430b-af41-a9bede9286ca": "Gemma - Decisive Agent",
  "630ed21c-2c5c-41cf-9d82-10a7fd668370": "Corey - Supportive Buddy",
  "f6ff7c0c-e396-40a9-a70b-f7607edb6937": "Emma - Customer Care Line",
  "f786b574-daa5-4673-aa0c-cbe3e8534c02": "Katie - Friendly Fixer",
  "a5136bf9-224c-4d76-b823-52bd5efcffcc": "Jameson - Easygoing Support",
  "87286a8d-7ea7-4235-a41a-dd9fa6630feb": "Henry - Plainspoken Guy",
  "d46abd1d-2d02-43e8-819f-51fb652c1c61": "Grant - Friendly Support",
  "79f8b5fb-2cc8-479a-80df-29f7a7cf1a3e": "Theo - Modern Narrator",
};

export const FALLBACK_CARTESIA_VOICES: CartesiaVoice[] = CURATED_CARTESIA_VOICE_IDS.map((id) => ({
  id,
  name: FALLBACK_VOICE_NAMES[id],
}));

export const DEFAULT_CARTESIA_VOICE_ID = CURATED_CARTESIA_VOICE_IDS[0];

export function isKnownCartesiaVoiceId(voiceId: string): boolean {
  return CURATED_CARTESIA_VOICE_IDS.includes(voiceId);
}

/**
 * Max input text length for "Generate clip (AI)". Shared by client + server
 * so the two can't drift. Not a Cartesia limit (their API has none) — just a
 * self-imposed cost/latency guard.
 */
export const MAX_TTS_TEXT_LENGTH = 15_000;
