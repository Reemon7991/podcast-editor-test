import { isKnownCartesiaVoiceId } from "../../../../utils/cartesiaVoices";
import { getVoiceMetadata } from "../cartesiaVoiceCache";

/**
 * Proxies one voice's preview audio — the client can never fetch
 * `preview_file_url` directly (confirmed live: it 401s without Cartesia
 * auth, despite being called a "preview" URL), so this route holds
 * `CARTESIA_API_KEY` server-side and streams the bytes through, same
 * "server holds the key" shape `api/tts/route.ts` already uses.
 */

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    return errorResponse(
      "Server is missing CARTESIA_API_KEY — set it in the environment and restart the server.",
      500
    );
  }

  const voiceId = new URL(request.url).searchParams.get("voiceId");
  if (!voiceId || !isKnownCartesiaVoiceId(voiceId)) {
    return errorResponse("Unknown voice selected.", 400);
  }

  const metadata = await getVoiceMetadata(voiceId, apiKey);
  if (!metadata?.previewFileUrl) {
    return errorResponse("No preview available for this voice.", 404);
  }

  try {
    const previewResponse = await fetch(metadata.previewFileUrl, {
      headers: { "X-API-Key": apiKey },
    });
    if (!previewResponse.ok) {
      console.error("[podcast-editor] Cartesia voice preview fetch failed", previewResponse.status);
      return errorResponse("Failed to load voice preview.", 502);
    }

    const audioBytes = await previewResponse.arrayBuffer();
    return new Response(audioBytes, {
      status: 200,
      headers: {
        "Content-Type": previewResponse.headers.get("content-type") ?? "audio/wav",
        // Preview audio is static per voice — safe for the browser to cache
        // for a while instead of re-fetching on every play.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[podcast-editor] Cartesia voice preview request threw", err);
    return errorResponse("Failed to load voice preview.", 500);
  }
}
