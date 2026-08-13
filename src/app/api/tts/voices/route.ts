import { FALLBACK_CARTESIA_VOICES } from "../../../../utils/cartesiaVoices";
import { getAllCuratedVoiceMetadata } from "../cartesiaVoiceCache";

/**
 * Live (server-cached) voice list for "Generate clip (AI)"'s picker — see
 * cartesiaVoiceCache.ts. Always returns 200 with *something* usable: falls
 * back to the static id/name list (hasPreview: false) if the API key is
 * missing, the live fetch fails, or Cartesia is unreachable. This is
 * decorative metadata for a dropdown, not a critical path — degrading
 * gracefully beats surfacing an error banner just because a voice name
 * couldn't be refreshed.
 */

interface VoiceOption {
  id: string;
  name: string;
  description: string | null;
  hasPreview: boolean;
}

function fallbackResponse(): Response {
  const voices: VoiceOption[] = FALLBACK_CARTESIA_VOICES.map((v) => ({
    id: v.id,
    name: v.name,
    description: null,
    hasPreview: false,
  }));
  return Response.json({ voices });
}

export async function GET(): Promise<Response> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) return fallbackResponse();

  try {
    const metadata = await getAllCuratedVoiceMetadata(apiKey);
    if (metadata.length === 0) return fallbackResponse();

    const voices: VoiceOption[] = metadata.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description,
      hasPreview: v.previewFileUrl !== null,
    }));
    return Response.json({ voices });
  } catch (err) {
    console.error("[podcast-editor] Failed to build live Cartesia voice list", err);
    return fallbackResponse();
  }
}
