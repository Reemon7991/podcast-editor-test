import { test, expect } from "@playwright/test";
import { makeSineWavBuffer } from "./fixtures";

// Set before importing the routes — they read process.env.REPLICATE_API_TOKEN
// at request time (inside each handler, not module load), same precedent
// e2e/ttsRoute.spec.ts already establishes for CARTESIA_API_KEY.
process.env.REPLICATE_API_TOKEN = "test-token";

// Imports the route handlers directly, deliberately NOT through the built/
// served Next app — same reasoning e2e/ttsRoute.spec.ts's own doc comment
// gives for api/tts/route.ts: this is the only thing that actually exercises
// these routes' own logic (validation, delegating to the provider, response
// shaping); a page.route()-level mock (if this app ever gets a
// noiseReduction.spec.ts UI suite) would intercept at the browser and never
// reach this file at all.
import { POST } from "../src/app/api/noise-reduction/route";
import { GET as GET_STATUS } from "../src/app/api/noise-reduction/[jobId]/route";
import { GET as GET_RESULT } from "../src/app/api/noise-reduction/[jobId]/result/route";
import {
  __setAudioProcessingProviderForTesting,
  type AudioProcessingJob,
  type AudioProcessingJobStatusResult,
  type AudioProcessingProvider,
  type AudioProcessingResult,
  type CreateNoiseReductionJobInput,
} from "../src/server/audioProcessing";

/**
 * In-memory fake standing in for a real AudioProcessingProvider — see
 * NOISE_REDUCTION_PLAN.md's "Verification" section. These tests exercise the
 * three routes' own logic (validation, delegating to the provider, response
 * shaping), not Replicate's real wire format — not live-verified as of this
 * writing (see replicateProvider.ts's own doc comment on the resemble-ai vs.
 * lucataco listing decision still being open). Injected via
 * __setAudioProcessingProviderForTesting — the same kind of seam
 * e2e/ttsRoute.spec.ts's global.fetch mock plays for api/tts/route.ts, one
 * layer further out since these routes talk to a provider abstraction
 * instead of calling fetch directly.
 */
class FakeAudioProcessingProvider implements AudioProcessingProvider {
  createCalls: CreateNoiseReductionJobInput[] = [];
  jobStatus: AudioProcessingJobStatusResult = { status: "succeeded" };
  result: AudioProcessingResult = { audio: toArrayBuffer(makeSineWavBuffer(1)), contentType: "audio/wav" };
  createError: Error | null = null;
  statusError: Error | null = null;
  resultError: Error | null = null;

  async createNoiseReductionJob(input: CreateNoiseReductionJobInput): Promise<AudioProcessingJob> {
    if (this.createError) throw this.createError;
    this.createCalls.push(input);
    return { id: "fake-job-1" };
  }

  // Neither needs jobId — this fake only ever tracks one job at a time.
  // TypeScript allows an implementation to take fewer parameters than the
  // interface it satisfies (safe contravariantly), so there's no unused
  // parameter to name at all.
  async getJobStatus(): Promise<AudioProcessingJobStatusResult> {
    if (this.statusError) throw this.statusError;
    return this.jobStatus;
  }

  async getResult(): Promise<AudioProcessingResult> {
    if (this.resultError) throw this.resultError;
    return this.result;
  }
}

/** Buffer.buffer can be a larger, pooled ArrayBuffer than the Buffer's own
 *  view — slice to the exact byte range so byte-for-byte comparisons below
 *  are meaningful. */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function createRequest(audio: { bytes: Buffer; filename?: string } | null): Request {
  const formData = new FormData();
  if (audio) {
    formData.append(
      "audio",
      new Blob([new Uint8Array(audio.bytes)], { type: "audio/wav" }),
      audio.filename ?? "clip.wav"
    );
  }
  return new Request("http://localhost/api/noise-reduction", { method: "POST", body: formData });
}

type RouteParams = { params: Promise<{ jobId: string }> };

function statusRequest(jobId: string): [Request, RouteParams] {
  return [new Request(`http://localhost/api/noise-reduction/${jobId}`), { params: Promise.resolve({ jobId }) }];
}

function resultRequest(jobId: string): [Request, RouteParams] {
  return [
    new Request(`http://localhost/api/noise-reduction/${jobId}/result`),
    { params: Promise.resolve({ jobId }) },
  ];
}

/** A 44-byte WAV header only, with `dataSize` inflated to represent a clip
 *  longer than the max accepted duration — readWavDurationSeconds only reads
 *  header fields (see utils/wavEncode.ts), so this reaches the duration
 *  guard without needing a genuinely 31-minute buffer. */
function oversizedWavHeader(durationSeconds: number, sampleRate = 44100): Buffer {
  const dataSize = Math.round(durationSeconds * sampleRate) * 2; // 16-bit mono
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

test.describe("POST /api/noise-reduction", () => {
  let fake: FakeAudioProcessingProvider;

  test.beforeEach(() => {
    fake = new FakeAudioProcessingProvider();
    __setAudioProcessingProviderForTesting(fake);
  });

  test.afterEach(() => {
    __setAudioProcessingProviderForTesting(null);
  });

  test("creates a job and returns its id for a valid WAV", async () => {
    const bytes = makeSineWavBuffer(1);
    const response = await POST(createRequest({ bytes }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobId).toBe("fake-job-1");
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0].audio.size).toBe(bytes.length);
  });

  test('rejects a request with no "audio" file before ever calling the provider', async () => {
    const response = await POST(createRequest(null));

    expect(response.status).toBe(400);
    expect(fake.createCalls).toHaveLength(0);
  });

  test("rejects a clip over the max duration before ever calling the provider", async () => {
    const response = await POST(createRequest({ bytes: oversizedWavHeader(31 * 60) }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("30 minutes");
    expect(fake.createCalls).toHaveLength(0);
  });

  test("returns 502 when the provider throws", async () => {
    fake.createError = new Error("upstream failure");
    const response = await POST(createRequest({ bytes: makeSineWavBuffer(1) }));

    expect(response.status).toBe(502);
  });

  test("returns 500 with a clear message when REPLICATE_API_TOKEN is unset", async () => {
    const original = process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_TOKEN;
    try {
      const response = await POST(createRequest({ bytes: makeSineWavBuffer(1) }));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain("REPLICATE_API_TOKEN");
      // The token check runs before anything provider-related.
      expect(fake.createCalls).toHaveLength(0);
    } finally {
      process.env.REPLICATE_API_TOKEN = original;
    }
  });
});

test.describe("GET /api/noise-reduction/[jobId]", () => {
  let fake: FakeAudioProcessingProvider;

  test.beforeEach(() => {
    fake = new FakeAudioProcessingProvider();
    __setAudioProcessingProviderForTesting(fake);
  });

  test.afterEach(() => {
    __setAudioProcessingProviderForTesting(null);
  });

  test("forwards the provider's in-progress status", async () => {
    fake.jobStatus = { status: "processing" };
    const [request, context] = statusRequest("job-1");

    const response = await GET_STATUS(request, context);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("processing");
  });

  test("forwards a failed status along with its error message", async () => {
    fake.jobStatus = { status: "failed", error: "model exploded" };
    const [request, context] = statusRequest("job-1");

    const response = await GET_STATUS(request, context);

    const body = await response.json();
    expect(body.status).toBe("failed");
    expect(body.error).toBe("model exploded");
  });

  test("returns 502 when the provider throws", async () => {
    fake.statusError = new Error("network blip");
    const [request, context] = statusRequest("job-1");

    const response = await GET_STATUS(request, context);

    expect(response.status).toBe(502);
  });

  test("returns 500 with a clear message when REPLICATE_API_TOKEN is unset", async () => {
    const original = process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_TOKEN;
    try {
      const [request, context] = statusRequest("job-1");
      const response = await GET_STATUS(request, context);
      expect(response.status).toBe(500);
    } finally {
      process.env.REPLICATE_API_TOKEN = original;
    }
  });
});

test.describe("GET /api/noise-reduction/[jobId]/result", () => {
  let fake: FakeAudioProcessingProvider;

  test.beforeEach(() => {
    fake = new FakeAudioProcessingProvider();
    __setAudioProcessingProviderForTesting(fake);
  });

  test.afterEach(() => {
    __setAudioProcessingProviderForTesting(null);
  });

  test("streams the resulting audio back with the provider's content type", async () => {
    const bytes = makeSineWavBuffer(1);
    fake.result = { audio: toArrayBuffer(bytes), contentType: "audio/wav" };
    const [request, context] = resultRequest("job-1");

    const response = await GET_RESULT(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    const returned = Buffer.from(await response.arrayBuffer());
    expect(returned.equals(bytes)).toBe(true);
  });

  test("returns 502 when the provider throws (e.g. the job hasn't succeeded yet)", async () => {
    fake.resultError = new Error("Prediction job-1 has not succeeded (status: processing)");
    const [request, context] = resultRequest("job-1");

    const response = await GET_RESULT(request, context);

    expect(response.status).toBe(502);
  });
});
