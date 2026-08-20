# Transcription refactor: OpenRouter/Whisper (chunked) → AssemblyAI (single job, submit/poll)

Design doc for swapping the transcription provider — kept corrected against
what actually ships, same discipline as `TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md`/
`SILENCE_REMOVAL_PLAN.md`/`TTS_CARTESIA_PLAN.md`. See `CLAUDE.md`'s
"Transcription pipeline + Audio search" section for the pre-refactor design
this replaces.

## Context

The current pipeline (`utils/audioCompression.ts` + `utils/transcription.ts` +
`utils/concurrency.ts` + `app/api/transcribe/route.ts`) exists in its current
"chunk into 10-minute Opus segments, fan out at most 3 concurrent requests,
merge by offset" shape because OpenRouter's Whisper endpoint has a ~25MB size
cap **and** a ~60s upstream processing timeout independent of size. Neither
constraint applies to AssemblyAI: `POST /v2/transcript` accepts up to 5GB /
10 hours per request, processed asynchronously (submit → poll), confirmed
directly against AssemblyAI's own API reference before writing this plan (not
assumed from training data — same "confirmed live" discipline this repo
already applies everywhere else).

This app's actual target (2-3 hour podcasts) fits in **one** AssemblyAI job
with room to spare. So **the chunking machinery is being removed, not
rewired** — it was solving a constraint that no longer exists, and keeping it
would mean firing multiple parallel AssemblyAI jobs per asset for no benefit
(slower, more expensive, more failure surface than one job).

**What does *not* change**: `AssetTranscript.words` stays `{ word, start, end
}` in seconds, asset-relative — the exact contract `transcriptWindow.ts`,
`transcriptRemap.ts`, `transcriptSearch.ts`, `useTranscriptIndex.ts`,
`SearchButton.tsx`, and the silence-removal remap path all depend on. None of
those files change. `transcriptStore.ts`'s isolation from `projectStore.ts`/
`TimelineStage.tsx` (see its own doc comment — the `processingClipId` bug
class) is untouched. `TranscriptStatus`'s 4-value union
(`pending`/`transcribing`/`done`/`failed`) is untouched. This is a
compression-layer + server-layer + orchestration-layer rewrite, not a
data-model or UI rewrite.

## New provider request, confirmed live against AssemblyAI's own API reference

- `POST https://api.assemblyai.com/v2/upload` — `Content-Type:
  application/octet-stream`, raw bytes body, returns `{ upload_url }`.
- `POST https://api.assemblyai.com/v2/transcript` — `{ audio_url,
  speech_models: ["universal-3-5-pro"], disfluencies: true,
  language_detection: true, prompt: "Transcribe verbatim. Include spoken
  filler words, hesitations, plus repetitions and false starts when clearly
  spoken." }` → `{ id, status: "queued" }`.
- `GET https://api.assemblyai.com/v2/transcript/{id}` → `status` one of
  `queued`/`processing`/`completed`/`error`; on `completed`, `words: [{ text,
  start, end, confidence, speaker }]` with **`start`/`end` in milliseconds**
  — unlike OpenRouter's Whisper response, which was seconds. This is a real,
  load-bearing unit difference: the new `/api/transcribe/[id]` route must
  divide by 1000 before any word ever reaches the client, so
  `TranscriptWord`'s existing seconds contract never has to change downstream.
- Recommended poll interval: 3s (AssemblyAI's own quickstart).
- Field name is `text`, not `word` (another real difference from OpenRouter's
  shape) — the route response this app hands to the client keeps using `word`
  as the key (matches the existing `TranscriptWord` shape), just reads
  AssemblyAI's `text` field to populate it.

## Decisions locked in

- **Keep single-shot Opus mono/16kHz compression, drop only chunking.**
  `audioCompression.ts`'s `downmixAndResample` + `encodeOpusBlob` stay, just
  run once over the whole asset instead of once per chunk — smaller/faster
  upload than raw PCM (no accuracy cost worth trading against: Opus at 24kbps
  mono is near-transparent for speech, and AssemblyAI resamples internally
  regardless of what's sent). `splitDurationIntoChunks`/
  `CHUNK_DURATION_SECONDS`/`sliceMonoBuffer` are deleted — nothing left to
  slice.
- **`CompressedChunk[]` → one `CompressedAsset { blob: Blob }` per assetId.**
  No `startSample`/`endSample` — nothing to offset against once there's only
  one blob per asset.
- **Server splits into two thin proxy routes**, extending (not replacing) the
  existing "server is a thin per-request proxy, client owns orchestration"
  precedent (`api/tts`, today's `api/transcribe`):
  - `POST /api/transcribe` — uploads the blob to AssemblyAI's `/v2/upload`,
    then `POST /v2/transcript` with the pinned options, returns
    `{ transcriptId }` immediately. Same retry-once-on-429/5xx-never-4xx
    discipline as today, applied to each outgoing call independently (a
    retried second attempt gets its own fresh timeout, same as
    `api/tts/route.ts`'s existing pattern).
  - **New** `GET /api/transcribe/[id]` — proxies `GET
    /v2/transcript/{id}`, converts `words[].start/end` ms→seconds, maps
    `queued`/`processing`→ this app's `"transcribing"`, `completed`→`"done"`,
    `error`→`"failed"` (message from AssemblyAI's own `error` field). No
    server-side retry loop here — a transient failure just means the client's
    next poll tick (a few seconds later) naturally retries; doubling up
    retries on an endpoint that's already being polled adds complexity for no
    benefit.
  - **Rejected alternative**: one route that submits and blocks, polling
    AssemblyAI itself before responding. Holds one HTTP connection open for
    however long AssemblyAI takes (unbounded — longer for a multi-hour
    recording), fragile against a tab close/reload/network blip (loses all
    progress, nothing persisted mid-flight), and cuts against this app's
    existing "transcription runs in the background, editable immediately"
    property. The submit/poll split avoids all of that for barely more code.
- **`runTranscriptionPipeline` is rewritten around submit-then-poll instead
  of fan-out-then-merge.** No more `sampleRate` param — nothing to offset.
  Submit → persist `{ status: "transcribing", providerJobId, words: null }`
  immediately (both `transcriptStore` and IndexedDB) → poll
  `GET /api/transcribe/[id]` every 3s until `done`/`failed` → persist the
  final result, same as today.
- **New `AssetTranscript.providerJobId?: string`** (AssemblyAI's transcript
  id). Backward compatible — optional field, a pre-refactor record simply
  lacks it. Purpose: `useProjectHydration.ts`'s existing "re-kick a still-
  pending transcript on reload" path can **resume polling the same job**
  instead of submitting a duplicate one — a real improvement the old design
  couldn't have, since each OpenRouter chunk call was one synchronous
  request/response with nothing left mid-flight across a reload. Falls back
  to a fresh submit only when there's no job id to resume (status
  `"pending"`, or a legacy pre-refactor record).
- **`utils/concurrency.ts` (`settleWithConcurrencyLimit`) is deleted.** It
  existed solely to cap concurrent chunk requests, which no longer exist, and
  nothing else in the app uses it.
- **`TranscriptStatus` stays the same 4-value union.** AssemblyAI's
  `queued`/`processing` both map to this app's `"transcribing"` — every
  downstream consumer (search's `isTranscribing` check, the still-unbuilt
  filler-word menu item's disabled-until-`"done"` design) already treats
  `"pending"`/`"transcribing"` as one "not ready yet" bucket, so a
  finer-grained status would be a UI change nothing is asking for.
- **No IndexedDB version bump.** `compressedAssets`' value *shape* changes
  (`{chunks: [...]}` → `{blob: ...}`), but the store itself isn't added or
  removed, and `idb`/IndexedDB don't validate value shape at the schema
  level. A pre-refactor record just doesn't have a `.blob` field — every call
  site already treats a missing/undefined compressed asset as "nothing to
  resume from" and falls back gracefully (recompresses on next real edit, or
  leaves an already-`"done"` transcript alone since compression is
  irrelevant once transcription has actually finished). Simpler and lower-
  risk than a destructive migration for a cache-only store.
- **`language_detection: true`, no `language_code`.** Matches the explicit
  call: no per-project language setting exists to drive an override, so
  always let AssemblyAI detect.
- **`speech_models: ["universal-3-5-pro"]` pinned, no fallback array.**
  Explicit call. Flagging the consequence: if `universal-3-5-pro` is ever
  degraded/unavailable, a request just fails rather than silently falling
  back to a lower-tier model — matches this app's "review, not silently
  accept" precedent; revisit if it becomes a real problem.
- **`disfluencies: true` *and* the explicit verbatim `prompt`** — both, not
  either/or, per the explicit ask.

## Phase 0 — Live verification spike (DONE — confirmed live, not just from docs)

Same discipline as every other feature's Phase 0 in this app (TTS voice list,
Whisper's `word`-not-`text` field, Opus round-trip) — a throwaway script
against the real AssemblyAI API, not assumed from docs alone. Cartesia's
account had essentially no credits left (~11, insufficient for a meaningful
sample) so the spike used a Windows-SAPI-synthesized English WAV (built-in,
free, deliberately scripted with "um"/"uh"/a false start/a repeated word) plus
one real short audio file the user supplied locally.

1. **`POST /v2/upload`** — confirmed: `{ upload_url }`, works with a plain
   WAV (no Opus-specific requirement).
2. **`POST /v2/transcript`** with the exact pinned options — confirmed: `id`
   + an initial `status` of `"processing"` (not `"queued"` as the docs
   suggest — likely just fast processing on a short file; irrelevant to this
   app's design since both map to `"transcribing"` here regardless).
3. **Poll `GET /v2/transcript/{id}`** to `"completed"` — confirmed
   `words[].start/end` really are **milliseconds**: the last word's `end`
   was `18764` against a 20s clip (`audio_duration * 1000 = 20000`).
   Confirmed the error shape too: a deliberately-broken `audio_url` settles
   to `status: "error"` with a plain string `error` field ("File not found
   at ... Make sure the file was uploaded recently and that you're
   transcribing from the same region.") — matches the plan's mapping exactly.
4. **Disfluencies + the verbatim prompt confirmed working together**: the
   synthesized sample's literal "Um, so, I think, you know, this is, uh, ..."
   came back with every filler word intact, including the scripted
   self-correction ("I was going, I was going to say something else.") — the
   concrete accuracy goal this refactor is for.
5. **Not fully closed**: no real non-English audio sample was available
   (Cartesia out of credits, no non-English TTS voice installed locally) —
   `language_detection: true` is confirmed *accepted by the API and inert on
   English content* (`language_code: "en"` came back correctly both times),
   but not confirmed to correctly detect a genuinely different language.
   Low risk (a straightforward boolean pass-through, not a code path this
   app does anything conditional with), but disclosed rather than claimed
   proven — worth a real non-English sample once one is available, same
   "don't silently resolve" precedent this file's other sections follow.

Not committed — throwaway script, deleted after use, same as every other
Phase 0 spike in this codebase.

## Phase 1 — Data model

`utils/types.ts`: `CompressedChunk` → `CompressedAsset { blob: Blob }`.
`AssetTranscript` gains `providerJobId?: string`.

## Phase 2 — Compression (single blob, no chunking)

`utils/audioCompression.ts`: delete `splitDurationIntoChunks`,
`CHUNK_DURATION_SECONDS`, `sliceMonoBuffer`, the per-chunk loop.
`compressAssetToChunks` → `compressAsset(audioContext, buffer):
Promise<Blob>` — `downmixAndResample` (unchanged) → `encodeOpusBlob`
(unchanged) over the whole buffer once.

## Phase 3 — Server routes

- `app/api/transcribe/route.ts` rewritten: same request contract (one
  multipart `file`, 400 on missing/empty), but now uploads to AssemblyAI's
  `/v2/upload` then submits `/v2/transcript` with the pinned options (retry
  once each on 429/5xx). Returns `{ transcriptId }`. 500 with a clear message
  if `ASSEMBLYAI_API_KEY` is unset (mirrors `OPENROUTER_API_KEY`/
  `CARTESIA_API_KEY`'s existing precedent).
- **New** `app/api/transcribe/[id]/route.ts` — `GET`, proxies AssemblyAI's
  status endpoint, does the ms→s conversion and status mapping described
  above. Next's route-handler `params` is a `Promise` in this project's
  installed Next version (confirmed against `node_modules/next/dist/docs`,
  per `AGENTS.md`'s "not the Next.js you know" warning) — must `await
  ctx.params`, not destructure it directly.

## Phase 4 — Orchestration rewrite

`utils/transcription.ts`:
- `runTranscriptionPipeline(assetId, compressedBlob): Promise<void>` — submit
  → persist `transcribing` + `providerJobId` → poll → persist final result.
- `resumeTranscriptionPipeline(assetId, providerJobId): Promise<void>` — same
  poll loop, skips the submit step; used by the hydration reload path.
- Both share one internal poll-loop helper (setTimeout-based, 3s interval, no
  fixed max-attempts cap other than the network/parse errors that already
  propagate as a `"failed"` status the same way a real AssemblyAI `error`
  does).

`utils/concurrency.ts` deleted.

## Phase 5 — Call site updates (mechanical, no behavior change beyond the above)

`useTimelineTracks.ts` (`addFilesToTrack`), `useGenerateSpeech.ts`
(`generateSpeech`), `useRemoveSilence.ts` (the "no transcript to remap from"
fallback) each currently do `compressAssetToChunks` →
`saveCompressedAsset(assetId, chunks)` → `runTranscriptionPipeline(assetId,
chunks, sampleRate)`; each becomes `compressAsset` → `saveCompressedAsset
(assetId, blob)` → `runTranscriptionPipeline(assetId, blob)`.
`persistence.ts`'s `saveCompressedAsset`/`loadCompressedAsset` signatures
follow the type change (no `DB_VERSION` bump needed, see above).

`useProjectHydration.ts`'s re-kick block: a `"pending"`/`"transcribing"`
transcript with a `providerJobId` calls `resumeTranscriptionPipeline`
directly (no need to even reload the compressed blob); one without a job id
(legacy record, or a submit that never got far enough to receive an id)
falls back to loading the compressed asset and calling
`runTranscriptionPipeline` fresh, same shape as today.

## Phase 6 — Tests

- `e2e/transcribeRoute.spec.ts` — full rewrite: mocks AssemblyAI's
  upload/submit/status endpoints instead of OpenRouter's; covers both new
  routes' validation, retry-once-on-429/5xx-never-4xx, the ms→s conversion,
  and the status mapping.
- `e2e/transcriptionLogic.spec.ts` — delete the `splitDurationIntoChunks` and
  `settleWithConcurrencyLimit` `describe` blocks (functions no longer exist).
  `wordsInWindow`/`remapWordsThroughKeptRanges`/search blocks are untouched.
- `e2e/transcriptionPipeline.spec.ts` — rewritten around submit-then-poll:
  offset/merge-across-chunks tests are replaced with submit→poll-until-done,
  a resume-after-reload-with-a-known-job-id test, and a
  poll-until-error-maps-to-failed test. The old "partial failure" case (some
  chunks succeed, some fail) has no equivalent anymore — one job either
  succeeds or fails.
- `e2e/helpers.ts`'s `mockTranscribeRoute` — updated to mock both routes
  (`POST` returns a fake id; `GET .../[id]` returns `completed` immediately
  with the given words) so every existing caller (`transcription.spec.ts`,
  `search.spec.ts`) keeps working with no change to its own assertions —
  they test observable outcomes (compressedAssets record count, transcript
  status/words), not pipeline internals.
- Full suite must stay green after every phase, not just at the end.

## Phase 7 — Docs

`CLAUDE.md`'s "Transcription pipeline + Audio search" section and
`TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md` updated to describe AssemblyAI +
submit/poll instead of OpenRouter/Whisper + chunking — same "kept corrected
against what shipped" discipline every other section already gets. This file
becomes the detailed record of *why*, same role the other `*_PLAN.md` files
play. `CLAUDE.md`'s "Critical setup gotchas" gains an `ASSEMBLYAI_API_KEY`
entry (server-only, clean 500 if unset — same pattern as the two keys it
replaces alongside).

## Explicitly out of scope

- No new UI — `language_detection` needs none, per the original ask.
- Filler-word removal (Phase 6 of the original plan doc) — still not
  started, unaffected either way by this swap.
- The silence-removal local remap path (`transcriptRemap.ts`,
  `useRemoveSilence.ts`'s `"done"`-transcript branch) — untouched, still zero
  network calls when a source transcript is already `"done"`.

## Verification

- Phase 0's spike, live, throwaway, before any real route lands.
- Full Playwright suite green after each phase.
- A manual pass against a real recording with genuine filler words/
  hesitations, confirming disfluencies actually appear in the returned
  words — the concrete, stated goal — plus a non-English sample confirming
  `language_detection` actually kicks in instead of mistranslating. Same
  "confirmed live, not just asserted from docs" discipline as the rest of
  this codebase.
