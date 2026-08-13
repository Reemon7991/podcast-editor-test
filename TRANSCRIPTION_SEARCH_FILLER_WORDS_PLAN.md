# Transcription pipeline → Audio search → Filler-word removal

Original design doc for these three features (transcription is the shared
prerequisite for both search and filler-word removal) — kept corrected
against what actually ships, same discipline as `SILENCE_REMOVAL_PLAN.md`/
`TTS_CARTESIA_PLAN.md`/`PERSISTENCE_UNDO_ORIGINAL_PLAN.md`. See
`CLAUDE.md`'s feature-state summary for the current top-level status; this
file is the detailed design/rationale those summaries point back to.

## Context

The editor (`editor-pro/`) has two features queued up next: **search across the
whole podcast** and **filler-word removal**. Both need a word-level transcript
to work from. Neither Whisper transcription nor any compression step exists
in this codebase today — this plan builds the whole chain: compress on
upload/TTS → transcribe in the background via Whisper (OpenRouter) → make the
resulting word-level timestamps survive every existing clip operation (move,
trim, split, undo) → build search and filler-word removal on top.

The critical design constraint, confirmed against this app's actual data
model before anything else: **`ClipMeta`/`AudioClip`** (`utils/types.ts`)
already carries `assetId` (which source asset), `offsetSamples` (where this
clip starts inside that asset), `durationSamples` (how much of the asset this
clip uses), `startSample` (where the clip sits on the timeline), and
`sourceDurationSamples`. A move only ever changes `startSample`; a trim only
ever changes `offsetSamples`/`durationSamples`; a split (confirmed via
`utils/assetRegistry.ts`'s `getAssetId` — the library passes the same buffer
by reference to both halves) keeps the same `assetId`. So: **store one
transcript per `assetId`, in seconds relative to that asset's own start —
never per-clip, never on the timeline** — and every existing clip operation
except a splice (silence removal, filler-word removal itself) already
preserves it for free, with zero new invalidation logic needed for move/
trim/split/undo.

## Decisions locked in for this plan

- Model: Whisper via OpenRouter — `POST https://openrouter.ai/api/v1/audio/transcriptions`,
  `model: "openai/whisper-large-v3"`, `response_format: "verbose_json"`,
  `timestamp_granularities: ["word"]`, multipart/form-data upload (`file`).
  Response: `{ text, usage: {seconds, cost}, language, duration, words: [{ word, start, end }] }`
  — start/end in seconds, field is `word` not `text` (confirmed live in
  Phase 0, corrected from the docs' initial description — same discipline
  this repo already applies to Cartesia, CLAUDE.md's TTS section finding 2).
- **Compression = chunk-first, then Opus-encode each chunk.** OpenRouter's
  25MB cap AND a ~60s upstream processing timeout (independent of file size —
  a tiny-but-long Opus file can still time out) both apply. Chunking by
  duration (~10 min/chunk) solves both at once: a 10-minute chunk is trivially
  under 25MB at any speech-appropriate bitrate, and each transcription request
  is short enough to finish well inside the timeout. **The "compressed
  version" stored in IndexedDB is therefore an array of small chunk blobs per
  asset, not one whole-asset file** — chosen explicitly over keeping one
  whole compressed file and re-slicing it later, to avoid a second re-encode
  pass and because the chunks are reused as-is for the transcription request
  bodies.
- Both the original asset and its compressed chunks persist in IndexedDB;
  transcripts persist in IndexedDB too (not localStorage — matches every
  other non-trivial store this app already uses, avoids localStorage's small
  synchronous quota on a multi-hour podcast's word list).
- Filler-word removal: **per-clip**, triggered from the same "..." clip menu
  as "Remove silence" — consistent with the existing pattern, one clip's cuts
  = one batch commit = one undo step. **Superseded by Phase 6's actual
  design**: scope narrowed to unambiguous words only, so a per-occurrence
  review modal isn't needed — a lightweight confirm-with-counts step replaces
  it. Kept here for the ordering rationale only.
- Search scope: only words whose timestamp falls inside some clip's
  currently-used `[offsetSamples, offsetSamples+durationSamples)` window —
  i.e. audio actually on the timeline, not trimmed-away source material.
- Spliced clips (silence removal, filler-word removal) mint a new
  content-hash `assetId` with no transcript. **Remap the old transcript
  through the known kept/removed ranges, locally, no network call** — keeps
  splice-based features fast/free/client-side, matches silence removal's
  existing property exactly. A word straddling a cut boundary is dropped, not
  truncated (simplest, safe default). Falls back to a real transcription call
  only if the source clip had no finished transcript to remap from.
- **Transcription is invisible to search; filler-word removal is disabled
  until ready.** Per the user's explicit call: opening/running search must
  never surface "transcription in progress" as a concept — if a relevant
  clip's transcript isn't done yet, search silently waits for it (a plain
  "Searching…" state, not a transcription-specific one) before returning
  results. The filler-word-removal menu item, by contrast, is simply
  **disabled** on any clip whose asset transcript isn't `"done"` yet — no
  modal to open until there's something to detect.

## Phase 0 — Verification spike (DONE — confirmed live, not just from docs)

1. **Live OpenRouter call** — confirmed via a real request (real Cartesia-
   synthesized speech -> OpenRouter): `words` comes back populated,
   accurately, as `[{ word, start, end }]` (field is `word`, not `text` as
   initially assumed from docs — corrected everywhere below). Top-level
   response: `{ text, usage: {seconds, cost}, language, duration, words }`.
2. **Opus-encode-from-an-already-decoded-buffer** — confirmed working via
   **`mediabunny`** (npm, actively maintained, zero runtime dependencies,
   MIT). `opus-recorder` was tried first and rejected: confirmed via its own
   README that it's built exclusively around live `MediaStream` capture, with
   no supported way to feed it an already-decoded buffer without literally
   replaying it in real time (a dealbreaker — a 2-hour asset would take 2
   hours to "encode"); its own maintainer now points users to WebCodecs
   instead. `mediabunny`'s `AudioBufferSource` (`new
   AudioBufferSource({codec: 'opus', bitrate})`, `.add(audioBuffer)` — takes
   a real `AudioBuffer` directly) + `OggOutputFormat` + `BufferTarget`
   confirmed end-to-end in a real Chromium page: encode -> round-trip through
   `decodeAudioData` (valid, playable) -> send the compressed file to
   OpenRouter -> word timestamps still come back correctly. Real numbers: a
   ~5s real-speech clip compressed from 418KB (WAV) to 13KB (mono/16kHz Opus,
   24kbps) — ~97% smaller.
   - **Requires a secure context** (`AudioEncoder` is `undefined` otherwise —
     confirmed by reproducing the failure on `about:blank` and fixing it by
     serving from `http://127.0.0.1`). Not a real constraint: this app is
     always served from `localhost` (dev/`next start`) or real HTTPS in any
     deployment, both qualify.
   - Playwright's default headless launch (`chromium_headless_shell`) does
     NOT expose `AudioEncoder` at all — irrelevant to the shipped app (real
     Chrome/Chromium always has it), but **e2e tests for this feature must
     launch the full Chromium binary**, not rely on `@playwright/test`'s
     default headless shell config, or they'll spuriously fail. Flagged for
     `playwright.config.ts` when Phase 6's e2e coverage is written.
3. Chunk duration: keep the ~10 min/chunk starting point (comfortably safe on
   both the size and timeout fronts given the ~97% compression ratio
   measured). Mono downmix confirmed cheap and correct via
   `OfflineAudioContext` (equal-gain sum of all channels into one).

**New dependency**: `mediabunny` — added to `editor-pro/package.json`.

## Phase 1 — Data model + IndexedDB schema (DONE, verified live)

New types in `src/utils/types.ts`:

```ts
export interface TranscriptWord { word: string; start: number; end: number; } // seconds, asset-relative
export type TranscriptStatus = "pending" | "transcribing" | "done" | "failed";
export interface AssetTranscript {
  assetId: string;
  status: TranscriptStatus;
  words: TranscriptWord[] | null;
  partialFailure?: boolean; // some chunks failed, others succeeded
  error?: string;
  updatedAt: number;
}
export interface CompressedChunk { startSample: number; endSample: number; blob: Blob; }
```

`src/utils/persistence.ts` — bump `DB_VERSION` to 2, guard `upgrade()` on
`oldVersion` so the existing `project`/`assets` stores aren't recreated:

```ts
upgrade(db, oldVersion) {
  if (oldVersion < 1) { db.createObjectStore(PROJECT_STORE); db.createObjectStore(ASSETS_STORE); }
  if (oldVersion < 2) {
    db.createObjectStore(COMPRESSED_ASSETS_STORE); // key: assetId, value: { chunks: {startSample, endSample, blob, mimeType}[], addedAt }
    db.createObjectStore(TRANSCRIPTS_STORE);        // key: assetId, value: AssetTranscript
  }
}
```

New functions mirroring the existing `saveAsset`/`loadAsset`/`loadAssets`
shape: `saveCompressedAsset`, `loadCompressedAsset`, `saveTranscript`,
`loadTranscript`, `loadTranscripts` (batched, same pattern `loadAssets`
already uses for hydration).

New `src/store/transcriptStore.ts` (Zustand, `assetId -> AssetTranscript`).
**Deliberately never wired into `projectStore.ts` or threaded above/inside
`TimelineStage.tsx`** — this sidesteps a repeat of the documented
`processingClipId` bug (CLAUDE.md's silence-removal section, bug 4): any
state that changes independently of a real `commit()`, if visible above
`TimelineStage`, defeats its passthrough-cache and forces spurious full
engine rebuilds. Transcription status changes constantly and asynchronously,
completely independent of `commit()` — it must stay below/beside
`TimelineStage`, same relocation fix already applied there for exactly this
reason.

## Phase 2 — Compression pipeline (upload + TTS paths) (DONE, verified live)

New pure module `src/utils/audioCompression.ts`:
- `splitBufferIntoChunks(buffer, chunkDurationSeconds)` — pure sample math.
- `downmixToMono(buffer)`.
- `encodeOpusChunk(buffer, startSample, endSample): Promise<Blob>` — mediabunny
  `AudioBufferSource` + `OggOutputFormat` + `BufferTarget`, confirmed in
  Phase 0.
- `compressAssetToChunks(buffer): Promise<CompressedChunk[]>`.

Wiring, extending (not replacing) the existing decode→hash→register→persist→
commit flow:
- `useTimelineTracks.ts`'s `addFilesToTrack`: after `decodeAudioData`/
  `registerAsset`, compress + `saveCompressedAsset` inside the same
  `Promise.all` that currently covers decode + `saveAsset`, before
  `setLoadingCount` decrements — this is what makes the existing upload
  loading overlay wait for compression too, per the UX requirement. A
  compression failure is logged/counted and swallowed the same non-fatal way
  an asset-save failure already is.
- `useGenerateSpeech.ts`: identical addition after its own `decodeAudioData`/
  `registerAsset`, before the hook resolves.
- After each, kick off transcription (Phase 3) **without awaiting it** — this
  is the "background" half of the requirement; the user can start editing
  immediately.

## Phase 3 — Server route + background transcription (DONE, verified live)

New `src/app/api/transcribe/route.ts`, mirroring `api/tts/route.ts`'s shape:
holds `OPENROUTER_API_KEY` server-side, accepts one chunk's compressed blob
(multipart, forwarded from the client — no base64 bloat), calls OpenRouter,
returns `words`. **One request = one chunk** — client owns fan-out and
merging, same "server is a thin per-request proxy" precedent `/api/tts`
already sets. Same retry discipline as `requestCartesiaTtsWithRetry`
(`api/tts/route.ts`): retry once on 429/5xx only, never on 4xx, fresh timeout
per attempt.

New `src/utils/transcription.ts`'s `runTranscriptionPipeline(assetId,
chunks): Promise<void>` — a plain function, not a hook (must be callable from
both `addFilesToTrack`'s async IIFE and `generateSpeech`'s async function).
Reads/writes `transcriptStore` via `getState()`/`setState()` outside React,
same pattern `projectStore.ts` already uses for its own module-level
`stopIfPlaying`:
1. Write `{status: "transcribing", words: null}` immediately.
2. Fire chunk requests to `/api/transcribe`, at most 3 in flight at once
   (`utils/concurrency.ts`'s `settleWithConcurrencyLimit` — added after a
   post-Phase-5 review found a long asset, e.g. 18 chunks for a 3-hour
   podcast at the default 10-min chunk size, fired every chunk at OpenRouter
   simultaneously, a real way to trigger rate limiting; generic, Node-unit
   tested, same `Promise.allSettled`-shaped contract).
3. Offset each fulfilled chunk's words by `chunk.startSample/sampleRate`,
   merge + sort.
4. All succeeded → `"done"`. Some succeeded → `"done"` + `partialFailure` +
   `error`. None succeeded → `"failed"`.
5. Persist via `saveTranscript` and write to `transcriptStore`.

**Reload/hydration**: `useProjectHydration.ts` needs a matching batch-load of
transcripts for every referenced `assetId` (mirrors `loadAssets`'s existing
pattern). Any transcript still `"pending"`/`"transcribing"` at reload time
(tab closed mid-flight) is re-kicked via `runTranscriptionPipeline` against
the already-persisted compressed chunks — cheap, no re-decode/re-compress.

**Multi-chunk merge, verified live**: the original Phase 0-3 verification
pass never actually exercised >1 chunk (every test clip was short enough to
produce exactly one). Closed in a post-Phase-5 review: temporarily lowered
`CHUNK_DURATION_SECONDS` to 8s, uploaded a real ~12.6s speech clip with 3
chapter-marker checkpoints spanning the chunk boundary. Confirmed exactly 2
`/api/transcribe` requests, 36 words merged in correct chronological order,
and — the key proof — the marker spoken *after* the 8s boundary landed at
9.5s, not reset near 0, confirming the second chunk's offset was applied
correctly. Reverted the constant afterward; a full rebuild confirmed
unchanged default (600s) behavior.

## Phase 4 — Re-transcription for spliced assets (DONE, verified live)

`useRemoveSilence.ts` and the new filler-word hook both splice a new buffer →
new `assetId` with no transcript. New `src/utils/transcriptRemap.ts`:
`remapWordsThroughKeptRanges(words, keepRanges, sampleRate): TranscriptWord[]`
— walks the same concatenation math `concatenateAudioData` performs, in time
units: a word fully inside a kept range gets
`newStart = (sum of prior kept-ranges' durations) + (word.start - range.startSeconds)`;
a word straddling a cut boundary is dropped entirely, not truncated.

Requires a small additive change to `spliceOutSilence`'s return shape (also
return `keepRanges`, not just the two boolean edge-flags it returns today) —
low-risk, backward compatible; the same shape gets reused by the filler-word
splice path in Phase 6. If the source clip's transcript wasn't `"done"` at
splice time (still transcribing, failed, predates this feature), fall back to
a real `runTranscriptionPipeline` call on the new asset instead — nothing to
remap from.

**Verified live** against a real production build: a synthetic clip built
from two real Cartesia-synthesized phrases separated by a genuine 3s digital-
silence gap, uploaded, transcribed (16 words), then run through "Remove
silence" via the actual clip menu. Confirmed: all 16 words survived (none
straddling the removed gap), the new asset's transcript appeared **~7ms**
after the splice committed (versus 500ms-2s+ for every observed real
OpenRouter call — unambiguous proof the local remap path ran, not the
network fallback), and the first word after the gap shifted from 4.99s to
2.21s post-splice — a ~2.78s shift, matching the ~3s gap minus the padding
silence-removal keeps on each side of a cut. Zero console/page errors.

## Phase 5 — Audio search (DONE, verified live)

**As actually built** (refined from the sketch below per direct user UX
spec): `src/utils/transcriptSearch.ts` (pure — `ClipWordIndex`,
`SearchResult`, `searchClipWordIndex`; case-insensitive substring-per-word
phrase matching, chronological result order, `seekTimelineStart` = match
start minus a fixed 0.5s lead-in clamped to 0) + `src/hooks/
useTranscriptIndex.ts` (the reactive wrapper — also returns `isTranscribing`,
computed in the same pass) + `src/components/search/SearchButton.tsx`
(self-contained trigger + portaled popover, modeled on `ui/MenuButton.tsx`'s
positioning/dismiss mechanics).

`useTranscriptIndex.ts` builds the index from `usePlaylistData().tracks`
(hydrated `AudioClip[]`, not `ClipMeta`) plus `transcriptStore`: for every
clip, resolve its `assetId` via `getAssetId(clip.audioBuffer)` (same
buffer-reference binding `useRemoveSilence.ts` already uses — `AudioClip` has
no `assetId` field directly), look up its transcript, and if `"done"`, run
`wordsInWindow` (shared with the Phase 4 remap) over
`[offsetSamples/sampleRate, (offsetSamples+durationSamples)/sampleRate)`,
mapping each surviving word to a timeline position
(`clip.startSample/sampleRate + word.start`). **Per-clip memoized** via a
module-level `clipCache` (not `useMemo`'s dependency array alone, and not
`useRef` — this repo's `eslint-plugin-react-hooks` "refs" rule rejects
reading `ref.current` during render even inside `useMemo`, caught immediately
by `eslint`; same fix shape as `assetRegistry.ts`'s own module-level cache)
— added after a post-Phase-5 review found the original flat-rescan version
recomputed `wordsInWindow` for *every* clip whenever *any* single asset's
transcript changed, since `transcriptStore`'s `transcripts` record is a new
object reference on each update. Same class of fix `dehydrate()`'s own
per-track cache already made once (`CLAUDE.md`'s "Post-Phase-3 perf
regression").

**Transcription must stay invisible to the searching user.** If any
currently-relevant clip's transcript is still `"pending"`/`"transcribing"`
when the user submits a search, the popover shows a plain "Searching…" state
(never mentions transcription) and waits for it to settle before computing
results — a `"failed"` transcript is simply excluded from results, not
surfaced as an error.

**Search runs on Enter, not on every keystroke** — changed after user
feedback that live-as-you-type felt noisy; `query` (live input) and
`submittedQuery` (last one actually searched) are separate state, so editing
the box after submitting doesn't blank the current results, only pressing
Enter again does. `SearchButton.tsx` owns this state directly rather than
lifting it to `TopBar.tsx` — it never unmounts (lives in `TopBar.tsx`, which
survives every engine rebuild), so closing the popover only toggles
visibility, satisfying "results persist until cleared" with no extra store.

UI: a TopBar-anchored popover (not a modal — search is a quick, repeated
action), portaled/positioned the way `ui/MenuButton.tsx` already does. Each
result: clip name, timestamp (standalone `formatTime` from
`@waveform-playlist/ui-components`, `"hh:mm:ss"` — deliberately not
`usePlaylistControls().formatTime`, which drives current-time/total-duration
elsewhere at their own precision and would have been an app-wide format
change), and the match in context (2 words each side where available,
ellipses only when context was actually truncated at the cap — not shown for
a match merely near a clip's edge, which would misleadingly imply cut-off
content that doesn't exist). Matched text renders in a real `<mark>`, styled
with the same `--accent-purple-100`/`-700` pair `ClipActionsOverlay.tsx`'s
own clip-name labels already use. Clicking a result sets `EditorShell.tsx`'s
existing `selectedClip` state (threaded down through `TopBar` as a new
`onSelectClip` prop) and calls `usePlaylistControls().seekTo()`.

**Verified live** against a real production build: uploaded real speech
("Welcome to the Elephant Sanctuary Podcast…"), searched "elephant" — 2
correctly-matched results, the top one showing clip name, `00:00:00.703`
timestamp, and `"…to the Elephant Sanctuary Podcast,…"` with `Elephant`
marked. Clicking it flipped the toolbar's `Duplicate` button from disabled to
enabled (selection confirmed) and moved `current-time` to `00:00:00.203` —
exactly `0.703 - 0.5`, confirming the lead-in math. Closing (Escape) and
reopening the popover preserved the same query and results. Separately
confirmed after the Enter-to-search change: typing "dolphin" and waiting
600ms produced zero results and left the pre-search placeholder showing;
pressing Enter then correctly returned 1 result with a clean `00:00:00`
timestamp (no decimals). Zero console errors throughout every pass.

## Phase 6 — Filler-word removal (IMPLEMENTED, blocked on transcription quality — see CLAUDE.md)

Scope narrowed before any code was written, per direct user spec: no
multi-word fillers ("you know", "i mean") and no ambiguous single words
("like", "so", "actually") at all for v1 — only short, unambiguous
interjections ("um", "uh", "erm", "ah" and close relatives). Every dictionary
entry is unambiguous, so there's no per-occurrence false-positive risk —
that's what makes the shipped UX a lightweight confirm-with-counts step
instead of the checkbox review list this section originally sketched (see
"UX" below).

**Bilingual, per-word script detection instead of a language setting**:
`src/utils/fillerWords.ts`'s `isFillerWord(word)` checks Arabic-range
characters against an Arabic dictionary and everything else against an
English one — no language field, no project setting. Normalization strips
punctuation, lowercases, collapses elongated repeats ("ummmm" → "umm"), and
(Arabic only) strips diacritics and unifies alef variants — confirmed
necessary live: a script's plain "اه" round-tripped through a real
Cartesia → Whisper pass as "آه" instead. The Arabic dictionary is
deliberately tighter than the English one (bare alef-mim, undiacritized, is
also "mother" — same ambiguity class as "like", left out rather than
guessed at).

**Two real, unfixed upstream gaps found and confirmed live while building
this — both raised with the user, both deliberately deferred, not fixed as
part of this feature:**

1. OpenRouter's `openai/whisper-large-v3` transcription endpoint does not
   reliably auto-detect language — Arabic audio with no `language` param
   comes back as an English *translation*, not an Arabic transcript
   (`response.language` even reports `"en"`). Adding `language: "ar"` fixes
   it completely. No way to know which language to request without asking
   the user; out of scope for this feature, tracked for a future pass
   (needs a persisted per-project language setting).
2. Whisper frequently **omits filler words from its own transcript
   entirely** — trained toward a clean, readable transcript, it often just
   drops "um"/"uh" rather than transcribing them. Confirmed on both
   languages with real Cartesia-synthesized audio that clearly spoke them.
   Tried extensively to work around this (every OpenRouter-exposed model
   variant — `whisper-large-v3`, `whisper-1`, `whisper-large-v3-turbo` — and
   every parameter that could plausibly help: `prompt`/`initial_prompt` with
   verbatim-style instructions, `temperature`, `condition_on_previous_text`,
   `suppress_tokens`, provider routing hints); **none changed the output at
   all** — OpenRouter's endpoint appears to only honor `file`/`model`/
   `response_format`/`timestamp_granularities`/`language`, silently
   dropping everything else. Not fixable without switching to a different
   transcription provider (a direct OpenAI key, Groq, Deepgram, …) — out of
   scope here. This feature can only ever catch whichever filler-word
   instances Whisper happens to keep.

**Mechanics, reused from silence removal, not duplicated**: extracted the
splice-application tail of `silenceDetection.ts`'s `spliceOutSilence` into a
new shared `src/utils/clipSplice.ts`'s `spliceKeepRanges(...)` (plus the
`KeepRange` type) — both features are "detect ranges to remove → invert to
keepRanges → splice", only the detector differs. Detection itself is **not**
shared — RMS-threshold-run detection and transcript-word-match detection
operate on different inputs with different merge semantics; forcing one
generic detector would have added more branching than it saved. New
`src/utils/fillerWordDetection.ts`'s `detectFillerWords(...)` scans a clip's
transcript window (`wordsInWindow`, shared with search/remap), pads each
match (0.05s), merges cuts within 0.15s of each other, and inverts into
`keepRanges`. Only words *fully contained* in the clip's window are ever
touched — one straddling the edge is left alone.

Considered and *rejected*: a silence-removal-style "drop tiny kept slivers"
fold pass. Silence removal's version is safe because a short kept segment
between two silences is presumptively near-silent junk; here, a short kept
segment between two filler-word cuts is real audio (could be a genuine short
word like "no") — dropping it on length alone risks deleting real content,
not junk. Left out. The one edge case this doesn't cover (a filler word
starting/ending very close to the clip's own boundary, where there's no
neighboring cut to merge with) is a real but low-severity, disclosed gap —
could leave a very brief residual sliver at a clip's edge.

New `src/hooks/useFillerWordRemoval.ts` mirrors `useRemoveSilence.ts` but
splits into two steps: `detectForClip(trackId, clip)` — synchronous, cheap,
reads only the already-finished transcript — populates a `pending` summary
or shows a "nothing to do" toast; `confirmPending()` — only reachable after
the UI's confirm step — does the actual splice/commit/toast, otherwise
identical to silence removal's discipline (single-flight guard,
yield-before-CPU-bound-work, pre-commit re-check of live clip boundaries,
remap-not-retranscribe for the result's transcript, one `commit()` labeled
"Remove filler words").

**UX**: clicking "Remove filler words" (per-clip "..." menu, next to
"Remove silence" — **disabled whenever that clip's asset transcript status
isn't `"done"`**, the one place transcription state is allowed to surface,
only as a disabled control) runs detection immediately; if matches exist, a
small `FillerWordConfirmModal.tsx` shows a "um × 2, uh × 1" style summary and
a "Remove 3 words"/Cancel choice. Confirming applies the splice (blocking
overlay + outcome toast, same treatment as silence removal); canceling
discards with zero changes. No matches skips the modal, shows "No filler
words detected in this clip." directly. Also exposed as a top-bar icon
button in `ClipActionsToolbar.tsx`/`TopBar.tsx`, mirroring "Remove silence"'s
own toolbar button one-for-one.

**Cross-feature coordination, real gap found while building this**:
`useRemoveSilence.ts` and `useFillerWordRemoval.ts` are each independently
single-flight but didn't coordinate with each other — running both at once
would have stacked two blocking overlays. Fixed: `EditorShell.tsx` computes
`isBusyProcessingClip = isRemovingSilence || isRemovingFillerWords`, gating
both menu items and both toolbar buttons.

**A second gap, found in a self-review pass after the feature first shipped
(worth a dedicated pass — every other feature in this file got one too)**:
`useUndoRedoShortcut`/`useDeleteClipShortcut` listen on `window` directly, so
the confirm modal's backdrop (which only blocks pointer events) didn't stop
Ctrl+Z/Delete from firing while it was open — undoing or deleting the clip a
still-open confirmation was about to act on. Not a data-corruption risk
(`confirmPending`'s pre-commit re-check already catches the mismatch and
discards with an error toast) but a needlessly confusing way to find that
out. Fixed by folding `pending !== null` into `EditorShell.tsx`'s
`editorBusy`. Regression-tested — the test caught a stale dev server serving
pre-fix code on its first run, which is itself a small confirmation the test
was actually exercising the real code path.

**Files**: `src/utils/fillerWords.ts`, `src/utils/fillerWordDetection.ts`,
`src/utils/clipSplice.ts` (shared with silence removal), `src/hooks/
useFillerWordRemoval.ts`, `src/components/filler-words/
FillerWordConfirmModal.tsx`, a new `RemoveFillerWordsIcon` in
`ClipActionIcons.tsx` (speech bubble, three dots, struck through — visually
checked at both 16px and 96px before settling on this shape; an earlier
wavy-line version was too cluttered at actual menu-item size).

**Verification**: `fillerWords.ts`/`fillerWordDetection.ts` got a Node-side
unit pass first (same order-of-operations discipline `silenceDetection.ts`
already established), promoted into `e2e/fillerWordLogic.spec.ts` (21
tests). Full browser-flow coverage in `e2e/fillerWordRemoval.spec.ts` (11
tests): the transcript-readiness gate, the confirm summary's exact counts,
cancel, the no-match toast, undo, the overlay/aria-disabled re-enable, the
toast auto-dismiss, the reload round trip, remap-not-retranscribe, and the
Ctrl+Z regression above. All mock `/api/transcribe` at the browser level
(same layer `transcription.spec.ts` uses), so these run deterministically
without needing live OpenRouter/Cartesia access. Full suite (157 tests)
passed against a fresh prod build. **Not verified**: a real, live
TTS → upload → transcribe → remove-filler-words pass end-to-end in a
browser — attempted, blocked by the session's Cartesia account running out
of TTS credits partway through setup (unrelated to any app code); the user
verified manually instead. The two upstream-gap findings above (mistranslation,
filler-word omission) were each confirmed with real Cartesia → OpenRouter
round trips before that account ran out, so the *transcription* side of this
feature has been exercised against the real API even though the full UI flow
with real (not mocked) speech hasn't.

## Explicitly disclosed risks / not silently resolved

1. ~~Whether OpenRouter actually honors `timestamp_granularities` end-to-end~~
   — **resolved in Phase 0**: confirmed live, twice (once against a raw WAV,
   once against the actual compressed Opus file this pipeline produces).
2. Cost: unlike TTS (opt-in), transcription runs on every upload/TTS
   generation per the spec — real, ongoing OpenRouter spend, not a design
   decision point here but worth the user seeing it stated plainly. Measured:
   ~$0.00013/5s of speech in Phase 0's spike (~$0.0016/min).
3. Exact filler-word dictionary is a v1 recommendation, trivially tunable
   later.
4. A `"failed"` transcript (all chunks failed) leaves that clip permanently
   excluded from search and filler-word removal until... nothing currently
   retries it automatically beyond the reload-time re-kick in Phase 3 — a
   manual retry affordance isn't in this plan's v1 scope; flagged, not built.

## Verification

- Phase 0's spikes are throwaway scripts, verified manually, not committed.
- New pure logic (`splitBufferIntoChunks`, `remapWordsThroughKeptRanges`,
  filler-word n-gram matching) gets a Node-side unit pass before touching a
  browser — same order-of-operations discipline `silenceDetection.ts` already
  established (cheapest place to catch algorithm bugs first).
- Full Playwright suite (currently 69 tests) must stay green throughout;
  new e2e coverage follows the existing per-feature-file convention
  (`e2e/transcription.spec.ts`, `e2e/search.spec.ts`,
  `e2e/fillerWordRemoval.spec.ts`), mocking `/api/transcribe` at the browser
  level for UI coverage plus a `ttsRoute.spec.ts`-style direct-import test for
  the route handler's own logic (retry behavior, validation) — same reasoning
  CLAUDE.md's TTS section finding 5 already documents for why browser-level
  mocking alone doesn't cover a route handler.
- Manual pass against a real multi-chunk (>10 min) recording once Phase 0-3
  land, to confirm chunk-merge produces correctly-offset, correctly-ordered
  word timestamps against real Whisper output — not just synthetic fixtures.
