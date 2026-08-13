import { CURATED_CARTESIA_VOICE_IDS, FALLBACK_VOICE_NAMES } from "../../../utils/cartesiaVoices";

/**
 * In-memory, server-side cache of each curated voice's live Cartesia
 * metadata (name/description/preview_file_url) — shared by
 * `api/tts/voices/route.ts` (the client-facing voice list) and
 * `api/tts/voice-preview/route.ts` (the preview-audio proxy), so both hit
 * Cartesia at most once per voice per TTL window instead of once per
 * request. `next start` runs as one persistent Node process (see CLAUDE.md's
 * "Verification approach"), so a plain module-level Map is a valid cache
 * store here — no external cache needed for this app's deployment model.
 *
 * Needs a newer `Cartesia-Version` than `api/tts/route.ts`'s own pinned
 * `2024-06-10` — `preview_file_url` only appears on `2026-03-01` (confirmed
 * live). Scoped to this module only, not bumped app-wide, so the
 * already-working generation call isn't put at any risk by this change.
 */

const CARTESIA_VOICES_API_VERSION = "2026-03-01";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface CachedVoiceMetadata {
  id: string;
  name: string;
  description: string | null;
  previewFileUrl: string | null;
  fetchedAt: number;
}

const cache = new Map<string, CachedVoiceMetadata>();

function isFresh(entry: CachedVoiceMetadata): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

async function fetchVoiceMetadata(voiceId: string, apiKey: string): Promise<CachedVoiceMetadata | null> {
  const response = await fetch(`https://api.cartesia.ai/voices/${voiceId}?expand[]=preview_file_url`, {
    headers: { "X-API-Key": apiKey, "Cartesia-Version": CARTESIA_VOICES_API_VERSION },
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { name?: unknown; description?: unknown; preview_file_url?: unknown };
  return {
    id: voiceId,
    name: typeof json.name === "string" ? json.name : (FALLBACK_VOICE_NAMES[voiceId] ?? voiceId),
    description: typeof json.description === "string" ? json.description : null,
    previewFileUrl: typeof json.preview_file_url === "string" ? json.preview_file_url : null,
    fetchedAt: Date.now(),
  };
}

/** Cache-first lookup for one voice. Falls back to a stale cache entry (if
 *  any) rather than `null` when a refetch fails — a transient Cartesia hiccup
 *  shouldn't make an already-working preview suddenly disappear. */
export async function getVoiceMetadata(voiceId: string, apiKey: string): Promise<CachedVoiceMetadata | null> {
  const cached = cache.get(voiceId);
  if (cached && isFresh(cached)) return cached;

  try {
    const fresh = await fetchVoiceMetadata(voiceId, apiKey);
    if (fresh) {
      cache.set(voiceId, fresh);
      return fresh;
    }
  } catch (err) {
    console.error(`[podcast-editor] Failed to fetch Cartesia voice metadata for "${voiceId}"`, err);
  }
  return cached ?? null;
}

/** Every curated voice's metadata, fetched concurrently. Voices that fail to
 *  resolve (network error, 404 — see CURATED_CARTESIA_VOICE_IDS's own
 *  staleness risk) are simply omitted, not surfaced as a request failure. */
export async function getAllCuratedVoiceMetadata(apiKey: string): Promise<CachedVoiceMetadata[]> {
  const results = await Promise.all(CURATED_CARTESIA_VOICE_IDS.map((id) => getVoiceMetadata(id, apiKey)));
  return results.filter((v): v is CachedVoiceMetadata => v !== null);
}

/** Test-only — clears the module-level cache so each test starts fresh.
 *  Not called from any real route. */
export function __clearVoiceCacheForTests(): void {
  cache.clear();
}
