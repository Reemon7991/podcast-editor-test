# Text-to-Speech (Cartesia) — design plan

**Status: accepted, not yet implemented.** Saved here so a future session can
pick this up without re-deriving it — same discipline `CLAUDE.md` already
applies to `PERSISTENCE_UNDO_ORIGINAL_PLAN.md`. See `CLAUDE.md`'s "Planned
features" list (AI features) for the current pointer to this file.

## Context

The podcast editor has no AI features yet — TTS is the first. Agreed direction: a
**backend-owned request** — a Next.js Route Handler calls Cartesia server-side
with a server-only API key and returns finished audio bytes; the client never
talks to Cartesia directly and no token-exchange/WebSocket streaming is used
(rejected: this is a "type text → wait a few seconds → clip appears" batch
workflow, not a latency-critical interactive one, so the token/direct-streaming
pattern buys nothing and only adds a browser-exposed credential and new client
plumbing for no benefit).

Confirmed via user answers during planning: triggered from a **modal dialog**
opened from the **top toolbar**, voices are a **small hardcoded list** for v1,
generated audio is inserted **at the playhead on the active track**, exactly like
an uploaded clip.

**Toolbar entry point**: `TopBar.tsx`'s standalone "Upload clip" button is
replaced by a single **"+ Clip"** button — mirroring `EditorShell.tsx`'s existing
"+ New Track" button, this app's one established "+ Label" convention, reused
rather than inventing new iconography. Clicking it opens a small dropdown with
two items: **"Upload clip file"** (does exactly what the old button did) and
**"Generate clip (AI)"** (opens `GenerateSpeechModal`).

**Design approach**: this is a small addition to an established internal tool with
an already-consistent design language (`Button.tsx`'s variants, the CSS custom
properties in `theme/tokens.ts`, the portal/dismiss pattern shared by
`ClipSwapConfirmPopover.tsx`/`ClipActionsMenu.tsx`) — the goal is to match that
system exactly, not introduce a new visual identity. The one thing worth carrying
over deliberately: interface copy that names actions by what the user is doing
("Upload clip file" / "Generate clip (AI)", "Generate" / "Generating…"), keeps the
same verb from trigger through to result, and gives errors a specific, actionable
message rather than a generic failure string.

**No dedicated TTS store.** `projectStore.ts` gets zero new fields — the
generated clip reaches it only via the ordinary `commit()` call every other
mutation already uses, identical to an upload once it lands. Everything
TTS-specific (`isGenerating`/`error`, modal open/closed, text/voice form fields)
is transient UI/request-lifecycle state with no reason to be global, so it stays
local `useState` in the hook and the modal component — the same precedent
`useProjectExport.ts` already sets by keeping `isExporting`/`error` as local hook
state rather than store fields, even though export is a more central operation
than TTS.

## How this plugs into the existing app

The clip-insertion pipeline already used for uploads
(`useTimelineTracks.ts`'s `addFilesToTrack`) is: decode → content-hash → register
in-memory (`assetRegistry.ts`) → persist to IndexedDB (`persistence.ts`'s
`saveAsset`) → build a `ClipMeta` → `commit()` into the Zustand store
(`projectStore.ts`), positioned via `resolveNonOverlappingStart`
(`clipGeometry.ts`) so it never overlaps an existing clip. A generated TTS clip is
the same shape once it's a `Blob` — this feature reuses every one of those pieces;
the only new parts are the network call and the UI trigger.

## Implementation

### 1. Server: `src/app/api/tts/route.ts` (new)

Standard App Router Route Handler (confirmed against this repo's bundled Next.js
docs — no bleeding-edge surprises here, standard `export async function POST`,
Web `Request`/`Response`).

- Reads `CARTESIA_API_KEY` from `process.env` (server-only, never
  `NEXT_PUBLIC_*`) — returns a clean 500 with a clear message if unset, so local
  dev without the key fails obviously instead of mysteriously.
- Body: `{ text: string, voiceId: string }`. Validates `text` non-empty and under
  a length cap (e.g. 5,000 chars — reject early with 400 rather than let Cartesia
  do it, and to stop an accidental giant paste from generating a needlessly
  expensive job), and `voiceId` against the allow-list in `src/utils/cartesiaVoices.ts`
  (imported directly, not re-declared — that file is already dependency-free of
  React, so the route and the UI share one list instead of two that could drift).
- Calls Cartesia's synchronous TTS bytes endpoint server-side, **explicitly
  requesting `container: "wav"`** (Cartesia's output format lets container and
  encoding vary independently — `"raw"` returns headerless PCM samples, which
  `decodeAudioData` cannot decode on its own; it only decodes a self-describing
  file like WAV. This app's own test fixtures (`e2e/fixtures.ts`'s
  `makeSineWavBuffer`) hand-write a RIFF header for exactly this reason,
  confirming the decode path needs a real container, not just PCM bytes — so
  this is a required request parameter, not a detail to leave open).
  **Exact endpoint path, header names, and other request/response field names
  will still be verified against Cartesia's current docs at implementation
  time** rather than hardcoded from memory now — noting this explicitly so it
  isn't silently guessed. The container requirement above is the one field
  worth pinning down now rather than deferring with the rest, since getting it
  wrong doesn't fail loudly at the request level — it silently produces a clip
  that fails to decode client-side.
- Wraps the Cartesia call with a bounded timeout (`AbortController`, e.g. 30s)
  so a hung upstream request can't leave the client's "Generating…" state stuck
  forever with no way out — times out to the same clean `{ error: string }`
  failure path as any other Cartesia error. If this route ever runs on a
  serverless target with its own execution-time cap (Vercel etc.), revisit
  `export const maxDuration` alongside this; not needed if it always runs on a
  persistent Node server.
- **Retries once on a 429 or 5xx response, never on 4xx** — added post-launch
  after a real, self-resolving 404 was observed in manual testing against a
  voice id later confirmed to genuinely exist (see `cartesiaVoices.ts`'s own
  doc comment). A 404/400 is a deterministic client-input problem (bad text,
  unknown voice) and retrying it just delays the same inevitable failure; a
  429/5xx is plausibly transient, which that incident was direct evidence of.
  Each attempt gets its own fresh timeout rather than sharing one budget
  across both. Covered directly by `e2e/ttsRoute.spec.ts` (see "Verification"
  below) — both the retry-then-succeed and the exhausted-retries paths, plus
  the no-retry-on-404 case as a named regression test for the incident above.
- On success: returns the audio bytes directly with `Content-Type: audio/wav`.
- On failure: forwards a clean `{ error: string }` JSON with an appropriate
  status, so the client can surface something real instead of a generic failure.
- No new dependency — a direct `fetch` call, not the `@cartesia/cartesia-js` SDK
  (one server-side endpoint doesn't justify a new dependency, matching this
  repo's otherwise deliberate/lean dependency list per `CLAUDE.md`'s "Critical
  setup gotchas").

### 2. Shared clip-insertion helper (small refactor)

Extract the per-clip `ClipMeta` construction currently inline in
`useTimelineTracks.ts`'s `addFilesToTrack` loop into a small pure function —
e.g. `buildClipMeta(assetId, buffer, startSample, name)` in a new
`src/utils/clipInsertion.ts` (or alongside `clipGeometry.ts`) — so both the
upload path and the new TTS path build a `ClipMeta` the same way instead of
duplicating the field list. `addFilesToTrack` is updated to call it;
`resolveNonOverlappingStart` (already shared) stays exactly as-is and is called
directly by both call sites.

### 3. Client hook: `src/hooks/useGenerateSpeech.ts` (new)

Mirrors `addFilesToTrack`'s async-decode-then-commit shape, trimmed to the
single-clip case (no batch/cursor logic needed):

0. A synchronous `isGeneratingRef` guard, checked and set at the very top of
   `generateSpeech` before anything else — added post-launch once it became
   clear `isGenerating` *state* alone doesn't close a double-submit race: two
   calls landing before React re-renders/disables the Generate button (two
   rapid clicks, in principle) would both read `isGenerating === false` and
   fire two requests. Same reasoning this app's own `playPendingRef` already
   relies on (a ref flips synchronously, ahead of any render, where state
   can't) — see `CLAUDE.md`'s play()/rebuild race for the precedent.
1. `isGenerating` / `error` state.
2. `POST /api/tts` with `{ text, voiceId }`.
3. Non-OK response → parse `{ error }`, set `error` state, stop (nothing
   committed, modal stays open so the user can retry without retyping).
4. OK response → `arrayBuffer()`; construct `new Blob([arrayBuffer], { type:
   "audio/wav" })` **before** decoding (mirrors `assetRegistry.ts`'s documented
   reason for hashing before decode: `decodeAudioData` may detach the buffer).
5. `hashFileBytes` (reused from `assetRegistry.ts`) → `assetId` — content-
   addressed, so regenerating identical text+voice twice dedupes for free, same
   property uploads already get.
6. `Tone.getContext().rawContext.decodeAudioData(arrayBuffer)` (same call
   `addFilesToTrack` already uses).
7. `registerAsset(buffer, assetId)` + `saveAsset(assetId, blob)` (persist,
   failure logged and swallowed — same non-fatal treatment `addFilesToTrack`
   gives a persist failure).
8. `buildClipMeta(...)` (the new shared helper) with `startSample =
   resolveNonOverlappingStart(insertionTimeSeconds * sampleRate, buffer.length,
   track.clips)`, name derived from the input text (e.g. first ~40 chars +
   ellipsis).
9. `commit((prev) => prev.map(t => t.id === trackId ? {...t, clips: [...t.clips,
   newClip]} : t), "Generate speech")` — same `commit()` the store already
   exposes, so undo/redo (one step) and persistence fall out for free, no
   store changes needed.

### 4. UI

- **Superseded from the original plan**: this section originally called for
  generalizing `ClipActionsMenu.tsx` with an optional `renderTrigger` prop, so
  the "+ Clip" toolbar button and `ClipActionsOverlay.tsx`'s existing per-clip
  "…" menu could share one component. That was tried and abandoned mid-
  implementation: threading a caller-owned DOM ref out through `renderTrigger`
  (a function called during render) trips this repo's
  `eslint-plugin-react-hooks` "refs" rule — it flags a ref crossing any
  function call made during render, regardless of what the callee actually
  does with it (here: just forwarding it to a JSX `ref=` prop, never reading
  `.current`) — and this repo holds a clean `eslint` run as a hard bar with
  zero existing suppressions anywhere. `ClipActionsMenu.tsx` was reverted to
  its original form; what actually shipped is below.
- **`src/components/ui/MenuButton.tsx` (new)**: a small dedicated component —
  a labeled `Button` trigger that opens a portaled dropdown — duplicating
  `ClipActionsMenu`'s proven shape (fixed-positioned off the trigger's own
  `getBoundingClientRect`, viewport-clamped, Escape/outside-click dismiss,
  `role="menu"`/`menuitem`) rather than sharing it, since the trigger button
  itself is now fully internal to this component (no ref ever crosses a
  function-call boundary). Lives in `ui/` alongside `Button.tsx`/
  `LoadingState.tsx`, not `layout/` or `clip-menu/`, since it's a generic
  reusable primitive, not owned by the toolbar or by clips — `label`,
  optional `icon`, `minWidth` (defaults to 160px; TopBar's own instance passes
  200px to fit "Generate clip (AI)"), and `actions: { id, label, onSelect,
  icon? }[]` (each action's `icon` is optional and independent — a mix of
  icon and icon-less actions in the same menu is fine).
- `src/utils/cartesiaVoices.ts` (new): small hardcoded `{ id, name }[]` list of
  curated Cartesia voice ids for the picker, plus the shared
  `MAX_TTS_TEXT_LENGTH` constant (both the server's validation and the
  modal's `<textarea maxLength>` import it from here, instead of each
  declaring their own copy that could drift).
- `src/components/tts/GenerateSpeechModal.tsx` (new): centered modal (portaled
  to `document.body` via `createPortal`, `role="dialog"` `aria-modal="true"`,
  dismiss on Escape/backdrop click — same dismissal pattern
  `ClipSwapConfirmPopover.tsx` already uses, adapted from anchored-popover to
  centered-modal-with-backdrop). Contents: `<textarea>` for text, `<select>` for
  voice, Generate/Cancel buttons (`Button` from `ui/Button.tsx`, matching
  existing variants, visible keyboard focus preserved), inline error text on
  failure (same treatment `TopBar.tsx`'s `exportError` already gets — specific
  and actionable, not a generic "something went wrong"), closes itself on
  success.
- `TopBar.tsx`: the existing "Upload clip" `Button` + hidden `<input type=file>`
  become a `MenuButton` labeled **"+ Clip"** with a plus icon and two actions:
  "Upload clip file" (an upload icon; `onSelect: () => inputRef.current?.click()`
  — the exact previous behavior, unchanged) and "Generate clip (AI)" (a filled
  sparkle icon — the one deliberately-filled icon among this file's otherwise
  stroked set, a common differentiation for the one AI-powered action;
  `onSelect` opens `GenerateSpeechModal`). The modal and hidden file input are
  wired with the same `activeTrackIdRef`/`currentTime` (playhead) values
  `handleUpload` already reads, so both entry points target the same
  track/position — captured into local state at the moment "Generate clip
  (AI)" is clicked, not read from the ref during render (this repo's refs
  lint rule again — see the superseded-approach note above).

### 5. Docs

Add the `CARTESIA_API_KEY` requirement (env var, server-only, where to get it)
to `CLAUDE.md`, following its existing "Critical setup gotchas" convention,
rather than a committed `.env.example` file (`.gitignore` currently ignores all
`.env*` outright — simplest to document in `CLAUDE.md`, this repo's
already-established source of setup truth, instead of carving a `.gitignore`
exception for one file).

## Verification

- `tsc --noEmit` and `eslint` clean (existing repo bar for every change).
- Manual pass against `npm run build && npm run start` (prod build — this
  project's own established testing discipline, see `CLAUDE.md`'s
  "Verification approach") with a real `CARTESIA_API_KEY`: open modal, generate,
  confirm the clip lands at the playhead on the active track, undo removes it
  in one step, a reload still has it (same persistence path as upload),
  playback works.
- New committed test, `e2e/tts.spec.ts`, following this repo's existing
  Playwright conventions (`e2e/helpers.ts`, `data-testid` selectors) —
  mocks `**/api/tts` via `page.route` (reusing `e2e/fixtures.ts`'s
  `makeSineWavBuffer` for the mocked response body, no real Cartesia call in
  tests) covering: the "+ Clip" dropdown opens and "Generate clip (AI)" opens
  the modal, a successful generate inserts a clip at the playhead, an error
  response shows inline and inserts nothing, undo removes a generated clip in
  one step. Turned out existing upload specs needed **no** changes at all —
  they all drive the hidden file input directly via `setInputFiles`
  (`e2e/helpers.ts`'s `uploadFiles`), never by clicking the button through its
  accessible name, so the "+ Clip" dropdown replacing the old standalone
  button didn't touch anything they depend on.
- **`e2e/ttsRoute.spec.ts` (added post-launch, closing a real coverage gap)**:
  `e2e/tts.spec.ts` mocks `**/api/tts` via `page.route`, which intercepts the
  request at the *browser* level — it never reaches `route.ts` at all, so
  that suite was never actual proof this route's own logic (validation, the
  outgoing Cartesia request shape, the retry behavior) does the right thing.
  This file imports `POST` directly and mocks `global.fetch`, running as a
  plain in-process Node test with no browser and no dependency on the shared
  built/served Next app — deliberately so: hitting the real webServer over
  HTTP instead would need the outgoing Cartesia URL swapped to a local mock
  via an env var set at that server's *startup*, but
  `playwright.config.ts`'s `reuseExistingServer: !process.env.CI` means a
  developer's own already-running `npm run start` (pointed at the real
  Cartesia API via their real `.env.local`) would silently get reused
  instead, risking a real call to Cartesia during a test run. Covers:
  `output_format.container === "wav"` and the correct `voice`/`transcript`
  fields actually reach the outgoing request; a 429 retries once and
  succeeds; repeated 500s exhaust retries and give up (not unbounded); a 404
  does **not** retry (named regression test for the real incident that
  motivated the retry logic in the first place — see `cartesiaVoices.ts`'s
  doc comment); an unknown voice id and over-length text are both rejected
  before Cartesia is ever called; a missing `CARTESIA_API_KEY` returns a
  clear 500. All 7 tests run in under 2 seconds, no build/browser needed.
