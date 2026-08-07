# Per-clip noise reduction via Replicate — provider-abstracted, non-blocking — design plan

**Status: implemented, not yet manually verified against real Replicate.**
See `CLAUDE.md`'s `## Noise reduction (Replicate)` section for what actually
shipped — files, real findings from building it (some corrected an
assumption made below), and exactly what's still unverified (no
`REPLICATE_API_TOKEN` was available in the session that implemented this,
so the "Suggested build order"'s Step 1 spike and the "Verification"
section's required real-token manual pass never ran). This document is kept
below largely as originally written — corrections are called out inline
where implementation reality diverged, same discipline
`TTS_CARTESIA_PLAN.md`/`SILENCE_REMOVAL_PLAN.md` already received after
their own features landed, rather than silently rewritten to look like it
was right the first time. Read `CLAUDE.md`'s section first; this file is the
detailed design record behind it.

## Context

Next AI feature after TTS (Cartesia, done) and silence removal (client-side,
done): per-clip background-noise removal, triggered from the same clip "..."
menu, **replacing the clip in place** (same convention silence removal
already established: same `startSample`, one clip in, one clip out, no
ripple to the rest of the timeline).

Two decisions made explicitly during planning, both binding on this plan:

1. **Vendor-agnostic from day one.** Noise reduction will run through
   Replicate first, but the app must not be hard-wired to it — swapping to
   Cleanvoice, a self-hosted DeepFilterNet, etc. later should mean writing
   one new provider class, not touching routes/hooks/UI. An
   `AudioProcessingProvider` interface (`createNoiseReductionJob` /
   `getJobStatus` / `getResult`) was proposed and evaluated below, adopted
   with minor refinements.
2. **The editor stays usable while a job runs — it must not lock up the way
   Export/Silence-removal's full-screen overlay does** (Replicate's own
   `resemble-enhance` model averages ~70-80s per run on its own, before
   upload/download — long enough that a full lockout felt wrong).
   Concretely: the *only* thing this disables is the "Reduce noise" menu
   item itself (app-wide, while one job is already running) — everything
   else (drag, trim, delete, play, undo/redo, export) keeps working
   normally. See "Why this doesn't need new architecture" below for why
   that turned out to be a small, targeted change rather than a structural
   one.

## Evaluation of the proposed `AudioProcessingProvider` interface

The three-method shape (create/status/result) is right and kept as-is — it
maps directly onto Replicate's own `predictions` API (`POST /v1/predictions`
→ `GET /v1/predictions/{id}` for status → read `.output` for the result),
and stays meaningful for a provider that's actually synchronous under the
hood (status would just come back `"succeeded"` on the first poll).
Refinements made during planning:

- Kept `createNoiseReductionJob` (not a generic `createJob(operation, ...)`)
  — `CLAUDE.md`'s own roadmap only ever names one sibling operation (humming
  removal) as speculative and undefined in scope; a generic operation-string
  dispatch would be solving a problem that doesn't exist yet. If humming
  removal is built later, it's an additive `createHumRemovalJob` method —
  providers that don't support it simply don't implement it.
- `AudioProcessingJobStatus` reuses Replicate's own status vocabulary
  (`starting` / `processing` / `succeeded` / `failed` / `canceled`) verbatim
  — they're already generic job-status words, not Replicate-specific, so no
  translation layer is needed and every provider can report into the same
  enum honestly.
- Added a factory (`getAudioProcessingProvider()`), necessary to make "swap
  providers" actually a one-line change: reads `AUDIO_PROCESSING_PROVIDER`
  (default `"replicate"`) and returns the concrete instance. Nothing outside
  this module ever imports a concrete provider class directly.
- Everything lives under a new `src/server/` layer, not `src/utils/`. This
  is the first feature whose server-side code is more than one file
  (interface, types, factory, the Replicate implementation), and it must
  never run client-side (it reads `REPLICATE_API_TOKEN`) — a dedicated
  top-level folder makes that boundary visible the way `app/api/` already
  does, rather than blending into `utils/`'s existing "shared, safe
  anywhere" convention (`cartesiaVoices.ts`'s actual justification for being
  in `utils/` was that it holds no secret and is deliberately imported by
  the client for validation — the opposite of this case). This is a
  deliberate one-off exception to this project's normal structural
  conservatism (see `CLAUDE.md`'s "Project-wide layer-based restructuring"
  note), justified specifically because it's a secret-holding boundary, not
  organizational preference.

```
src/server/audioProcessing/
  types.ts              AudioProcessingInput/Job/JobStatus/Result, AudioProcessingProvider
  index.ts               getAudioProcessingProvider() factory (env-var switch)
  replicateProvider.ts   the only implementation for v1
```

## Model: `resemble-enhance`

Confirmed to exist on Replicate under the official `resemble-ai` org
account: [replicate.com/resemble-ai/resemble-enhance](https://replicate.com/resemble-ai/resemble-enhance) — open-source
([github.com/resemble-ai/resemble-enhance](https://github.com/resemble-ai/resemble-enhance)), purpose-built for speech
denoising + restoration (a denoiser module separates speech from background
noise; an enhancer module restores distortion/bandwidth), trained on
44.1kHz speech — a good match for podcast dialogue specifically, not a
generic audio model. Runs on a T4 GPU, ~$0.015–0.02/run, ~70-80s typical.
This was the only Replicate model found with a confirmed real page, official
ownership, and a documented input schema during planning — no direct
DeepFilterNet listing on Replicate itself was found (it exists on fal.ai, a
different platform).

**Input/output schema — confirmed from the actual Cog source, not a
secondary summary**: [github.com/lucataco/cog-resemble-enhance/predict.py](https://github.com/lucataco/cog-resemble-enhance/blob/main/predict.py)
(the community Cog wrapper backing `replicate.com/lucataco/resemble-enhance`)
defines `predict(input_audio: Path, solver: str = "Midpoint" [Midpoint|RK4|Euler],
number_function_evaluations: int = 64 [1-128], prior_temperature: float = 0.5
[0-1.0], denoise_flag: bool = False) -> List[Path]`, always returning **two**
files: `output-denoised.wav` and `output-enhanced.wav` — both stages always
run regardless of `denoise_flag`, they just gate whether denoising happens
*before* the enhancement stage. **Use `output-denoised.wav`, not
`-enhanced`** — the enhanced file additionally does generative
bandwidth-extension/restoration on top of denoising, which is more than this
feature asked for and risks subtly changing the speaker's voice
characteristics; denoised-only is the conservative, correct match for "reduce
background noise."

One open item this doesn't fully close: the *official* `resemble-ai/
resemble-enhance` GitHub repo has no `predict.py`/`cog.yaml` in it — its
Replicate deployment code isn't publicly visible, so this schema is confirmed
for the `lucataco/resemble-enhance` listing specifically, not proven
byte-identical for the official org's own listing (both wrap the same
underlying `resemble_enhance` package, so they're very likely the same
shape, but "very likely" isn't "confirmed"). Decide between the two listings
at implementation time by fetching both models' live `openapi_schema`
(`replicate.models.get()`) and using whichever actually matches this
document — prefer the official `resemble-ai` listing if its schema matches,
falling back to `lucataco`'s (which is already confirmed) if it doesn't.

> **Still open as shipped**: this spike never ran (no `REPLICATE_API_TOKEN`
> was available when this was implemented). `replicateProvider.ts` defaults
> to `lucataco/resemble-enhance`, overridable via
> `REPLICATE_NOISE_REDUCTION_MODEL` — see `CLAUDE.md`'s "Noise reduction
> (Replicate)" section.

**File delivery**: Replicate requires files >256KB to be passed as HTTP
URLs, not data URIs (confirmed via Replicate's HTTP API docs) — a real
podcast clip's WAV will almost always exceed that. `replicateProvider.ts`
must upload via Replicate's Files API first (`POST /v1/files`) and pass the
returned URL as `input_audio`, not attempt a data URI.

> **Corrected as shipped**: reading the installed `replicate` npm package's
> own source (`lib/util.js`'s `transformFileInputs`) shows it already does
> this automatically — any `Blob`/`Buffer` value found in `predictions.create`'s
> `input` is uploaded via the Files API and replaced with a URL before the
> request is sent. No hand-rolled `POST /v1/files` call was needed;
> `replicateProvider.ts` just passes a `Blob` as `input_audio` and pins
> `fileEncodingStrategy: "upload"` so a failed upload fails loudly instead of
> the SDK's default silent fallback to a (likely-too-large) data URI.

**Recommendation: use the official `replicate` npm package** inside
`replicateProvider.ts` only (never imported anywhere else, so switching
providers later can't drag it along). Unlike Cartesia's TTS route — one
synchronous POST, hand-rolled fetch was the right amount of control — this
flow is upload + create + poll, and the SDK's `Buffer`/`Blob` input
auto-upload plus `predictions.create`/`.get()` meaningfully cuts hand-rolled
surface area for a first version of a multi-step integration.

## Why this doesn't need new architecture

**Scope, precisely**: staying unlocked only means *other editing* (drag,
trim, delete, play, undo/redo, export) keeps working while a noise-reduction
job runs — it does **not** mean two noise-reduction jobs can run at once.
Same as silence removal, this stays app-wide single-flight: once one clip's
"Reduce noise" is running, that action is disabled on every clip's menu
(not just the one running) until it finishes. So `useNoiseReduction.ts` is
almost a straight copy of `useRemoveSilence.ts`'s shape — a single
`processingClipId` + a single `isProcessingRef` guard, not a map. The only
structural difference from silence removal is **what gets disabled while it
runs**: silence removal disables the whole editor (top bar, transport bar,
every clip menu) via a full-screen overlay; noise reduction disables only
the "Reduce noise" menu item itself (on every clip, via the same shared
`processingClipId !== null` check `ClipActionsOverlay.tsx` already applies
to silence removal's own menu item) — nothing else in the app gates on it.

The one thing worth being precise about, since it's easy to over-solve: an
engine rebuild **does** unmount `ClipDragLayer`/`ClipActionsOverlay`
entirely (confirmed in `CLAUDE.md`'s "Clip swap confirmation" section) — but
it does **not** unmount their parent, `EditorShell.tsx`. Rereading
`EditorShell.tsx` directly confirms this: a rebuild only flips `isReady`
false→true, which conditionally swaps `ClipDragLayer` for a "Building
waveform…" placeholder and back — `EditorShell` itself is the same
component instance throughout, never torn down. That's exactly why
`useRemoveSilence()` already lives there today (see its own doc comment)
and its state already survives rebuilds — the exact property this feature
now needs too, since a job can easily outlive several unrelated rebuilds
triggered by the user's other edits while it's running. So
`useNoiseReduction.ts` lives in `EditorShell.tsx` right alongside
`useRemoveSilence()` — same file, same technique, no new store, no
module-level singleton. Its poll loop keeps running because `EditorShell`
keeps running, regardless of how many times `ClipActionsOverlay` underneath
it unmounts and remounts; `processingClipId` is passed down as a prop into
`ClipActionsOverlay` exactly the way silence removal's already is, so a
remount mid-job just receives the current value fresh on the next render.

**Live-clip recheck, adapted for a multi-minute window**: silence removal's
existing "recheck offset/duration/startSample against live state before
committing, discard if changed" guard is reused, but refined — a plain
*move* (drag to a new position, same trimmed content) is a realistic thing
to do to some other clip during the 1-2 minutes a job is processing, and
shouldn't discard an already-paid-for result. The recheck now only compares
`offsetSamples`/`durationSamples` (does the clip still refer to the same
source content extent) and, if they still match, applies the new audio at
the clip's **current** `startSample` — not the one captured when the job
started. Only a changed trim or a deleted clip discards the result.

**Outcome messaging — reuse silence removal's exact pattern, not a new
design.** `useRemoveSilence.ts` already establishes the vocabulary this
feature should copy verbatim (see `ui/Toast.tsx`'s doc comment for the
success/warning/error split, and `SILENCE_REMOVAL_PLAN.md`/`CLAUDE.md`'s own
"UX: overlay + toast" section for the full reasoning): a transient outcome
→ `Toast` (auto-dismisses after 5s, still manually dismissible); a failure
with a *lasting* consequence (survives past this session) → the persistent,
manually-dismissed `WarningBanner`, never a toast. Concretely for
`useNoiseReduction.ts`:

- **Success** (`Toast`, `variant: "success"`): `"Noise reduced."` — fired
  right after `commit()`, same place `processingClipId` clears.
- **Job itself failed** (`Toast`, `variant: "error"`): `"Noise reduction
  failed. Please try again."` — covers a Replicate error, a timed-out poll
  (past the 5-minute bound), or any thrown network error; mirrors
  `useRemoveSilence.ts`'s own catch-block message word-for-word in spirit.
- **Live-clip recheck discarded the result** (`Toast`, `variant: "error"`) —
  two messages, matching silence removal's own two discard cases exactly:
  `"This clip changed while noise reduction was running — the result was
  discarded. Try again."` (trim/offset changed) and `"This clip no longer
  exists — noise reduction was discarded."` (deleted). A plain *move* is
  **not** an error case here — see the live-clip recheck above — so this
  only fires for an actual content or existence change.
- **Result generated but the IndexedDB persist failed** (`WarningBanner`,
  not a toast — same non-auto-dismissing treatment `useTimelineTracks.ts`'s
  `saveWarning` and `useRemoveSilence.ts`'s `saveWarning` both already use,
  since losing offline durability is a lasting consequence a 5-second toast
  would undersell): `"This clip's noise was reduced, but couldn't be saved
  for offline use — it will be lost if you reload before exporting."`

**One deliberate difference from silence removal's message set**: no
"no-op" amber-warning tier (silence removal's `"No silence detected in this
clip."`). Silence removal can *detect* a no-op client-side before ever
calling out; noise reduction has no equivalent signal — the model always
returns a processed file whether or not there was audible noise to remove,
so there's no "nothing to do" case to report. Every run either succeeds
(green) or fails one of the ways above (red/amber) — don't invent a no-op
message that has nothing real to key off of.

`EditorShell.tsx` already owns a single `Toast` slot fed by
`useRemoveSilence()`'s outcome. A small queue (advance to the next message
on dismiss/auto-dismiss, capacity ~3) replaces the single-slot version so
both silence-removal's toast and `useNoiseReduction`'s own job completion
can share one `Toast` instance without one clobbering the other mid-display
— the two features can each have a job finish independently, even though
neither can have two of its own jobs running at once.

**No new playback-race guard needed** — worth stating plainly so a future
session doesn't go looking for one. The `commit()` call is the same plain
store action every other hand-applied mutation in this app already goes
through, and `store/projectStore.ts`'s `stopIfPlaying` (registered once
from `EditorShell.tsx`) already runs before *every* `commit()`,
unconditionally — noise reduction gets the "stop playback before a
rebuild-forcing edit" protection for free, zero new code, the same way
duplicate/delete/undo/redo already do (see `CLAUDE.md`'s "editing while
playing" section for why that guard exists at all).

**Guards worth including** (small, cheap, matching existing precedent like
`MAX_TTS_TEXT_LENGTH`):
- App-wide single-flight, exactly like silence removal's own
  `isProcessingRef`/`processingClipId` pair — "Reduce noise" disables on
  every clip's menu the moment one starts, not just the one running.
- A max clip duration accepted server-side (suggest 30 min — generous for a
  podcast clip, bounds cost/time), returned as a clean 4xx like
  `MAX_TTS_TEXT_LENGTH` does.
- **Disable the Export button specifically while a noise-reduction job is
  in flight** (only Export — not drag/trim/delete/undo/play, which stay
  fully available per the whole point of this feature). Reasoning, not just
  caution: `CLAUDE.md`'s own "Export" section documents that
  `useExportWav`/`useProjectExport.ts` "temporarily swaps Tone's global
  context (`setContext`/restored in `finally`)," and that this app's
  existing convention for a Tone-context race is to close the *window*
  structurally "rather than relying on it being provably safe" (same
  section, same sentence, applied to the existing `isExporting` gate).
  Before this feature, silence removal's full-editor overlay made
  Export-during-another-async-clip-op structurally impossible — this is the
  **first time** in this app that a background clip mutation (noise
  reduction's own `commit()`, which forces a full Tone.js engine rebuild
  exactly like a move/duplicate/fade already does) can land *while* an
  offline export render is using a swapped global context. Whether that
  interaction is actually harmful hasn't been verified against the vendored
  `dist/tone.js` source in this planning pass — treat it as unverified but
  plausible, and close the window the same low-cost way the rest of this
  app already treats an unproven Tone-context race, rather than shipping on
  the assumption it's fine. A small, targeted gate (`EditorShell.tsx`'s
  Export button `disabled={isExporting || processingClipId !== null}`,
  nothing else) is cheap enough that "unverified but plausible" is reason
  enough to include it.

**Disclosed, not built for v1** (matches this repo's existing "Not built"
convention rather than silently scoping it out): a page reload or tab close
while a job is in flight loses client-side tracking of it — the Replicate
prediction still finishes server-side, but nothing polls it again, so the
clip is left unchanged. Persisting in-flight job records to IndexedDB and
resuming polling from `useProjectHydration.ts` would close this; not
attempted in v1. Optional Replicate `POST /v1/predictions/{id}/cancel`
support (a "Cancel" affordance on the per-clip badge) is a reasonable
stretch add-on, not core — include only if time allows once the core path
works.

## Server routes

Three, mirroring the provider's three methods 1:1 (so each has one job):

- `POST /api/noise-reduction` — accepts `multipart/form-data` (the clip's
  WAV, encoded client-side via the existing `utils/wavEncode.ts`), validates
  size/duration, calls `provider.createNoiseReductionJob(...)`, returns
  `{ jobId }`.
- `GET /api/noise-reduction/[jobId]` — calls `provider.getJobStatus(...)`,
  returns `{ status, error? }` JSON. Polled by the client every ~3s.
- `GET /api/noise-reduction/[jobId]/result` — calls
  `provider.getResult(...)`, streams back raw WAV bytes
  (`Content-Type: audio/wav`) — mirrors `route.ts`'s existing
  binary-response pattern for TTS, so the browser only ever talks to this
  app's own origin, never a `replicate.delivery` URL directly.

`REPLICATE_API_TOKEN` (server-only, never `NEXT_PUBLIC_*`) follows the exact
setup-gotcha precedent `CARTESIA_API_KEY` already established: missing →
clean validated 500 from the route, not a mysterious failure; document in
`CLAUDE.md`'s "Critical setup gotchas" alongside it once implemented.

## Client pipeline (inside `useNoiseReduction.ts`'s `reduceNoise`)

Mirrors `useRemoveSilence.ts`/`useGenerateSpeech.ts`'s decode-or-compute-
then-commit shape almost exactly, adapted for a multi-step async job
instead of one local computation or one fetch — same
`isProcessingRef`/`processingClipId` pair, same overall structure:

1. Guard: `!clip.midiNotes`, has `audioBuffer`, `isProcessingRef.current`
   false (same single-flight check `useRemoveSilence.ts` already does).
2. Extract the clip's *played* sample range (`offsetSamples` ..
   `offsetSamples + durationSamples`) out of `clip.audioBuffer` into a
   standalone buffer. No existing export does exactly this, but
   `silenceDetection.ts`'s own `spliceOutSilence` shows the pattern
   directly: per channel, `sourceBuffer.getChannelData(ch).subarray(offset,
   offset + duration)` (a view, not a copy), then
   `createAudioBuffer(audioContext, channels, sampleRate, channelCount)`
   from `@waveform-playlist/core` (already a dependency, same import
   already used there) — `channelCount` passed explicitly, same reason
   `spliceOutSilence` already documents (it defaults to 1/mono if omitted,
   silently dropping every channel past the first). A ~10-line helper, not
   a new algorithm. Encode via `wavEncode.ts`.
3. `POST /api/noise-reduction` → `jobId`.
4. Poll `GET /api/noise-reduction/[jobId]` every ~3s (bounded — fail with a
   timeout message past, say, 5 minutes) until `succeeded`/`failed`.
5. On success: `GET .../result` → decode via `decodeAudioData` → hash via
   `hashFileBytes` → `registerAsset` → `saveAsset` (persist, same
   fire-and-forget-with-warning treatment as silence removal/TTS) → build
   the replacement `ClipMeta` (same `assetId`/gain/name-suffix/color
   pattern as silence removal's `newClip`; preserve `fadeIn`/`fadeOut` only
   if `durationSamples` matches exactly, else drop both — conservative, same
   spirit as silence removal's edge-based gating just simpler since there's
   no leading/trailing-edge distinction here).
6. Live-clip recheck (see above) → `commit()` → `processingClipId` back to
   `null` → toast.

## Suggested build order

For whichever session implements this — each step is independently
checkable before moving to the next, so a mistake surfaces close to where
it was made rather than at the end:

1. **Spike, before writing any app code**: resolve the Model section's one
   open item (`resemble-ai` vs `lucataco` listing) by fetching both live
   `openapi_schema`s. Confirm the winning model with one manual prediction
   (Replicate dashboard or a throwaway script) against a short real WAV,
   inspecting the actual response shape end to end.
2. Provider abstraction: `types.ts`, `index.ts` factory,
   `replicateProvider.ts`. Test it standalone (a small script or a temporary
   route) against a real clip before wiring any UI — confirms file upload,
   job creation, polling, and result-fetch all work in isolation.
3. The three Next.js routes, modeled directly on `src/app/api/tts/route.ts`.
4. `src/utils/audioBufferSlice.ts` (or inline in the hook if it ends up
   trivial enough not to warrant its own file) + `useNoiseReduction.ts`,
   without UI wiring yet — exercise it from a temporary test harness first.
5. Wire into `ClipActionsOverlay.tsx` / `EditorShell.tsx`: menu item,
   outcome messaging (all four message variants above), Export gate.
6. Guards: max clip duration (server-side), confirm single-flight disables
   correctly across clips.
7. `e2e/noiseReduction.spec.ts`, then the manual real-`REPLICATE_API_TOKEN`
   pass described in Verification below.
8. Documentation pass — see "Definition of done" below.

> **As shipped**: steps 1 and the manual-pass half of step 7 did not
> run — no `REPLICATE_API_TOKEN` was available in the implementing session.
> Everything else above happened in roughly this order, including a
> `src/server/audioProcessing/index.ts` test-only provider-override seam
> (not anticipated by this plan) added specifically to make step 6's
> "route contract" tests possible without depending on the still-unresolved
> step 1 spike — see `CLAUDE.md`'s "Noise reduction (Replicate)" section,
> finding 4.

## Critical files

- `src/server/audioProcessing/{types.ts,index.ts,replicateProvider.ts}` — new.
- `src/app/api/noise-reduction/route.ts`,
  `src/app/api/noise-reduction/[jobId]/route.ts`,
  `src/app/api/noise-reduction/[jobId]/result/route.ts` — new, modeled on
  `src/app/api/tts/route.ts`.
- `src/hooks/useNoiseReduction.ts` — new; near-direct copy of
  `useRemoveSilence.ts`'s shape (single `processingClipId` +
  `isProcessingRef`, app-wide single-flight). Owns the poll loop.
- `src/utils/audioBufferSlice.ts` (name tentative) — new, small.
- `src/components/clip-menu/ClipActionsOverlay.tsx` — in `buildActions`, add
  the `"reduce-noise"` action **immediately after** `"remove-silence"` (so
  `buildActions`' order becomes: split, duplicate, remove-silence,
  reduce-noise, delete — the two audio-only, single-flight-guarded actions
  grouped together, same `!clip.midiNotes` gate `remove-silence` already
  uses, delete staying last as the destructive item). Disabled on every clip
  while `useNoiseReduction`'s `processingClipId !== null` (passed down as a
  prop, same wiring `"remove-silence"` already has), labeled "Reducing
  noise…" on whichever clip matches it.
- `src/components/timeline/EditorShell.tsx` — calls `useNoiseReduction()`
  alongside the existing `useRemoveSilence()`; small toast-queue change so
  both features' outcomes can share one `Toast` instance instead of one
  clobbering the other mid-display; Export button gains the
  `processingClipId !== null` guard described above (`TopBar.tsx`'s export
  button prop, threaded the same way `isExporting` already is — check
  whether that prop lives in `EditorShell.tsx` or needs passing one level
  further into `TopBar.tsx` itself when implementing).
- `.env.local` — add `REPLICATE_API_TOKEN` (setup step, not code).
- `package.json` — add `replicate` (npm SDK), used only inside
  `replicateProvider.ts`.

## Verification

- Decide `resemble-ai/resemble-enhance` vs `lucataco/resemble-enhance` by
  fetching both models' live `openapi_schema` (`replicate.models.get()`) and
  confirming which one actually matches this document's schema (see
  "Model" above) before wiring field names — the schema itself is already
  confirmed from source for the `lucataco` listing, this step is only about
  which listing to point at, same "verify against the real thing before
  shipping" bar `TTS_CARTESIA_PLAN.md` set for Cartesia's endpoint.
  **Not done as shipped** — no `REPLICATE_API_TOKEN` available; still open,
  see `CLAUDE.md`.
- New Playwright coverage, modeled on `e2e/ttsRoute.spec.ts`'s pattern
  (import the route handlers directly, mock the provider or `global.fetch`
  — never hit real Replicate in CI): create/status/result route contracts,
  the client poll-to-completion path, "Reduce noise" disabling app-wide
  (every clip's menu, not just the one running) while a job is in flight,
  **and** drag/trim/duplicate/undo on a *different* clip still succeeding
  during that same window (the core stays-usable assertion this whole
  feature exists for), the live-clip-recheck discard path (changed trim)
  vs. tolerate path (plain move), undo restoring the original clip in one
  step. **As shipped**, split into two files rather than one: route
  contracts live in `e2e/noiseReductionRoute.spec.ts` (imports the handlers
  directly, injects a fake provider via the test-only seam mentioned above
  — not `global.fetch`, since the wire format it would need to mock isn't
  live-verified) and everything client/UI-facing lives in
  `e2e/noiseReduction.spec.ts` (mocks `**/api/noise-reduction*` via
  `page.route`, the way `tts.spec.ts` mocks `**/api/tts`) — mirrors this
  repo's existing `tts.spec.ts`/`ttsRoute.spec.ts` split rather than the
  single-file `e2e/noiseReduction.spec.ts` this section originally named.
- One manual pass against a real `REPLICATE_API_TOKEN` and a real recorded
  clip with actual background noise before calling this shippable — same
  "committed suite + separate manual pass" discipline every prior AI
  feature in this repo followed, since mocked coverage alone never proves
  the real Replicate integration's field names/response shape are right.
  **Not done as shipped** — no token available; do this before treating the
  feature as production-ready.
- `tsc --noEmit` and `eslint` clean, full `npm run test:e2e` suite green
  against a fresh `npm run build && npm run start` (not `next dev`) — the
  same bar every other feature in this repo is held to; see `CLAUDE.md`'s
  "Verification approach" section for why prod-build testing specifically
  is the reliable signal here, not dev mode. **Done** — both clean, full
  suite (85 tests) passed with the one pre-existing, unrelated flaky retry
  already documented elsewhere in this repo.

## Definition of done

Matches this repo's own established discipline for every prior feature —
don't skip the documentation half, it's as much a part of "done" here as
the code:

- `CLAUDE.md` gains a new `## Noise reduction (Replicate)` section, same
  shape as `## Silence removal (done)`/`## Text-to-Speech (Cartesia)
  (done)` immediately above it: files, the provider-abstraction design and
  why, real bugs actually found while building (not hypothetical ones —
  this plan's own "unverified but plausible" Export/Tone-context note above
  should turn into either a confirmed real bug with its fix, or a confirmed
  non-issue with the reasoning why, not stay speculative in the shipped
  writeup), disclosed gaps (job-tracking-lost-on-reload, no cancel unless
  built), committed + manual verification coverage.
- The "AI features" bullet under "Planned features (not started)" updates
  from "Noise removal: accepted, not yet implemented — see
  `NOISE_REDUCTION_PLAN.md`" to reflect noise removal done (humming removal
  still open) — same pattern every other shipped bullet in that list
  already follows (Persistence, Undo/redo, Export, Fade in/out, TTS,
  Silence removal all read "**Done**" with a pointer to their real section,
  not left describing the pre-implementation plan).
- This document is corrected against what actually shipped, not left
  describing this planning session's guesses where implementation reality
  diverged — same discipline `TTS_CARTESIA_PLAN.md`/`SILENCE_REMOVAL_PLAN.md`
  already received after their own features landed.
