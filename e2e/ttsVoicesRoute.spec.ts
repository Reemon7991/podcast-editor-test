import { test, expect } from "@playwright/test";
import { CURATED_CARTESIA_VOICE_IDS, FALLBACK_CARTESIA_VOICES } from "../src/utils/cartesiaVoices";

// Same reasoning as ttsRoute.spec.ts: set before importing the routes below,
// which read process.env.CARTESIA_API_KEY at request time, not module load.
process.env.CARTESIA_API_KEY = "test-key";

import { GET as getVoices } from "../src/app/api/tts/voices/route";
import { GET as getVoicePreview } from "../src/app/api/tts/voice-preview/route";
import { __clearVoiceCacheForTests } from "../src/app/api/tts/cartesiaVoiceCache";

const VALID_VOICE_ID = CURATED_CARTESIA_VOICE_IDS[0];
const OTHER_VOICE_ID = CURATED_CARTESIA_VOICE_IDS[1];
const PREVIEW_FILE_URL = "https://files.cartesia.ai/files/abc/download?format=playback";

interface VoiceListBody {
  voices: { id: string; name: string; description: string | null; hasPreview: boolean }[];
}

function voicePreviewRequest(voiceId: string | null): Request {
  const url = new URL("http://localhost/api/tts/voice-preview");
  if (voiceId !== null) url.searchParams.set("voiceId", voiceId);
  return new Request(url);
}

/** Mocked Cartesia `GET /voices/:id` response body. */
function cartesiaVoiceResponse(overrides: { name?: string; description?: string | null; previewFileUrl?: string | null }) {
  return new Response(
    JSON.stringify({
      name: overrides.name ?? "Live Name",
      description: overrides.description ?? null,
      preview_file_url: overrides.previewFileUrl ?? null,
    }),
    { status: 200 }
  );
}

test.describe("GET /api/tts/voices", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
    __clearVoiceCacheForTests();
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns live name/description/hasPreview for each curated voice", async () => {
    global.fetch = (async (url: string | URL | Request) => {
      const id = String(url).match(/voices\/([^/?]+)/)?.[1];
      return cartesiaVoiceResponse({
        name: `Live name for ${id}`,
        previewFileUrl: id === VALID_VOICE_ID ? PREVIEW_FILE_URL : null,
      });
    }) as typeof fetch;

    const response = await getVoices();
    expect(response.status).toBe(200);
    const body = (await response.json()) as VoiceListBody;

    expect(body.voices).toHaveLength(CURATED_CARTESIA_VOICE_IDS.length);
    const first = body.voices.find((v) => v.id === VALID_VOICE_ID);
    expect(first?.name).toBe(`Live name for ${VALID_VOICE_ID}`);
    expect(first?.hasPreview).toBe(true);
    const second = body.voices.find((v) => v.id === OTHER_VOICE_ID);
    expect(second?.hasPreview).toBe(false);
  });

  test("falls back to the static list when CARTESIA_API_KEY is unset", async () => {
    const original = process.env.CARTESIA_API_KEY;
    delete process.env.CARTESIA_API_KEY;
    try {
      const response = await getVoices();
      expect(response.status).toBe(200);
      const body = (await response.json()) as VoiceListBody;
      expect(body.voices.map((v) => v.id)).toEqual(FALLBACK_CARTESIA_VOICES.map((v) => v.id));
      expect(body.voices.every((v) => v.hasPreview === false)).toBe(true);
    } finally {
      process.env.CARTESIA_API_KEY = original;
    }
  });

  test("falls back to the static list when every live fetch fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const response = await getVoices();
    expect(response.status).toBe(200);
    const body = (await response.json()) as VoiceListBody;
    expect(body.voices.map((v) => v.id)).toEqual(FALLBACK_CARTESIA_VOICES.map((v) => v.id));
  });

  test("caches a voice's metadata — a second call doesn't refetch it", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return cartesiaVoiceResponse({ name: "Cached name" });
    }) as typeof fetch;

    await getVoices();
    const callsAfterFirst = callCount;
    await getVoices();
    expect(callCount).toBe(callsAfterFirst);
  });
});

test.describe("GET /api/tts/voice-preview", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
    __clearVoiceCacheForTests();
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("rejects a missing voiceId before calling Cartesia", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const response = await getVoicePreview(voicePreviewRequest(null));
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejects an unknown voiceId before calling Cartesia", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const response = await getVoicePreview(voicePreviewRequest("not-a-real-voice"));
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("returns 500 when CARTESIA_API_KEY is unset", async () => {
    const original = process.env.CARTESIA_API_KEY;
    delete process.env.CARTESIA_API_KEY;
    try {
      const response = await getVoicePreview(voicePreviewRequest(VALID_VOICE_ID));
      expect(response.status).toBe(500);
    } finally {
      process.env.CARTESIA_API_KEY = original;
    }
  });

  test("returns 404 when the voice has no preview available", async () => {
    global.fetch = (async () => cartesiaVoiceResponse({ previewFileUrl: null })) as typeof fetch;

    const response = await getVoicePreview(voicePreviewRequest(VALID_VOICE_ID));
    expect(response.status).toBe(404);
  });

  test("proxies the preview audio bytes with the right content-type", async () => {
    global.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/voices/")) {
        return cartesiaVoiceResponse({ previewFileUrl: PREVIEW_FILE_URL });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "Content-Type": "audio/wav" } });
    }) as typeof fetch;

    const response = await getVoicePreview(voicePreviewRequest(VALID_VOICE_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  test("returns 502 when the preview file itself fails to fetch", async () => {
    global.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/voices/")) {
        return cartesiaVoiceResponse({ previewFileUrl: PREVIEW_FILE_URL });
      }
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

    const response = await getVoicePreview(voicePreviewRequest(VALID_VOICE_ID));
    expect(response.status).toBe(502);
  });
});
