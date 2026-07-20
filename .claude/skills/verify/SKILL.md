---
name: verify
description: Drive the podcast editor in a real browser to verify changes end-to-end.
---

# Verifying editor-pro

There is no committed Playwright/Jest suite (see `CLAUDE.md`). Verification is
ad-hoc, per session, against a **production build** — `next dev`'s
Turbopack/Strict Mode double-invocation has previously masked/altered timing
bugs, so `next start` is the reliable signal.

## Setup

```bash
npm run build && npm run start   # serves on :3000
```

In a scratch dir:

```bash
npm install playwright-core@1.61.1
```

Chromium is normally already cached at
`C:\Users\<user>\AppData\Local\ms-playwright\chromium-<rev>\chrome-win64\chrome.exe`
— note **`chrome-win64`**, not `chrome-win` (a real, easy-to-guess-wrong
path). Find the exact revision folder with `ls` first rather than assuming.

Generate synthetic audio rather than depending on real files — a small Node
script writing a raw-PCM 44-byte-RIFF-header WAV (see any prior session's
scratchpad, or just: 16-bit mono, write the header fields, then a sine wave
loop) is enough for waveform/decode/playback testing.

## Driving it

- `data-testid="current-time"` / `"total-duration"` — prefer these over CSS
  classes; `font-mono` is reused by both the transport bar's time and
  `TrackListBar`'s per-clip duration labels, which has caused false-bug
  diagnoses from an ambiguous `.first()` locator before.
- Draggable clip element: `[data-clip-id]:not([data-boundary-edge])` (the
  clip's header bar) — not the waveform `<canvas>`, not the
  `data-boundary-edge="left"|"right"` trim handles.
- "Add clip" file inputs are `input[type="file"]`, one per track row, hidden
  (`className="hidden"`) — use `setInputFiles` directly, no need to click
  first.
- After any import or drag, the provider shows "Building waveform…" while
  rebuilding — `waitForSelector("text=Building waveform…", { state:
  "detached" })` before interacting again, or actions can silently no-op
  against unmounted drag targets.

## Known-hard-to-reproduce: play()/rebuild race

The `TonePlayout not initialized` crash documented in `CLAUDE.md` (library's
`play()` re-reading its engine ref after an `await init()` that a concurrent
tracks-change rebuild can invalidate) requires `play()`'s own `init()` await
to still be outstanding when a drag commits. CDP `Emulation.setCPUThrottlingRate`
does NOT reliably force this — `AudioContext.resume()` latency isn't
proportionally CPU-throttled the way JS execution is. The original discovery
only happened against a real ~65-minute/7-track session. Don't trust a clean
run under small synthetic clips as proof either way for this specific race;
say so explicitly rather than reporting a false PASS.

## Cleanup

The dev/prod server is a background process on :3000 — find and stop it
before finishing:

```bash
netstat -ano | grep ":3000" | grep LISTENING   # get the PID
powershell -Command "Stop-Process -Id <pid> -Force"
```
