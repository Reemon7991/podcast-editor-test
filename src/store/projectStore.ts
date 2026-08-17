import { create } from "zustand";
import type { ClipTrack } from "@waveform-playlist/browser";
import type { TrackMeta } from "../utils/types";
import { deepEqual } from "../utils/deepEqual";

/**
 * Module-level, never part of React/Zustand state — same pattern as
 * utils/assetRegistry.ts, and for the same reason: this is an imperative
 * escape hatch, not project data, so it has no business triggering
 * subscriber re-renders when it changes.
 *
 * Registered once from EditorShell.tsx (the component with actual
 * usePlaylistControls().stop()/usePlaybackAnimation().isPlaying access —
 * the store itself lives outside WaveformPlaylistProvider's context and
 * can't reach either directly), kept fresh every render there. `commit`/
 * `undo`/`redo` call it before mutating `present`, so every *hand-applied*
 * mutation (duplicate, delete, add/remove track, import, undo, redo — today
 * and any future one that goes through `commit`) gets the playing-while-
 * editing guard for free, without each call site needing to remember to add
 * it — see CLAUDE.md's "editing while already playing" section for why the
 * guard exists at all, and this file's own doc comments below for why it has
 * to be `flushSync`'d by the caller, not a plain `stop()`.
 *
 * Deliberately NOT called from `commitEngineOutput`: that path also carries
 * trim/split's engine-driven mirror-back, which must NOT stop playback (no
 * rebuild happens for those — stopping would be a pure regression). Only a
 * hand-applied *move* (ClipDragLayer.tsx's onDragEnd) reaches
 * commitEngineOutput in a way that actually needs the guard, and that one
 * call site is the only place that can tell the difference (it knows it's
 * about to hand-apply a move, vs. mirror back an engine transaction) — so it
 * keeps its own local guard instead of relying on this one.
 */
let stopIfPlaying: () => void = () => {};

export function registerStopIfPlaying(fn: () => void): void {
  stopIfPlaying = fn;
}

/**
 * Live per-track mute/solo/volume/pan. The engine mutates these in place but
 * only bumps `mixerVersion`, never `tracksVersion` — so onTracksChange never
 * fires for them, and `present` never learns about a mixer click on its own.
 */
export interface TrackMixerState {
  muted: boolean;
  soloed: boolean;
  volume: number;
  pan: number;
}

/** Bridges live mixer state out of WaveformPlaylistProvider's context for
 *  code that can't reach it directly (this store, PodcastEditor.tsx) — same
 *  pattern as stopIfPlaying above. Registered from EditorShell.tsx. */
let getLiveMixerState: () => Map<string, TrackMixerState> = () => new Map();

export function registerLiveMixerState(fn: () => Map<string, TrackMixerState>): void {
  getLiveMixerState = fn;
}

/**
 * Merges live mixer state onto a TrackMeta[] snapshot by track id — without
 * this, a structural commit or a persistence save silently keeps each
 * track's creation-time muted/soloed/volume/pan instead of what's live.
 * Preserves object identity when nothing changed, so it doesn't defeat
 * hydrate()'s cache or the incremental-add fast path in the common case.
 */
export function withLiveMixerState(tracks: TrackMeta[]): TrackMeta[] {
  const live = getLiveMixerState();
  if (live.size === 0) return tracks;
  return tracks.map((t) => {
    const m = live.get(t.id);
    if (!m) return t;
    if (t.muted === m.muted && t.soloed === m.soloed && t.volume === m.volume && t.pan === m.pan) {
      return t;
    }
    return { ...t, ...m };
  });
}

/**
 * `undo`/`redo` clone every track object before restoring, deliberately
 * breaking reference equality. Reason: the library's incremental-add
 * fast-path only checks that old track objects still exist *somewhere* in
 * the new array, not at the same *position* — its `engine.addTrack()`
 * remedy always appends to the end. Undoing a "Remove track" (or redoing an
 * "Add track" after other track-count changes) can restore a track to the
 * *middle* of the array; the library still takes the fast-path, appends it
 * at the end instead, and mirrors that reordered mismatch back as a
 * spurious history entry that wipes `future` (confirmed via direct
 * instrumentation). Cloning forces a full rebuild instead, which is always
 * safe. Not needed in `commit`/`commitEngineOutput` — only undo/redo can
 * reintroduce a track at a non-end position.
 */
function cloneTracks(tracks: TrackMeta[]): TrackMeta[] {
  return tracks.map((track) => ({ ...track }));
}

export function createEmptyTrack(index: number, id: string = crypto.randomUUID()): TrackMeta {
  return {
    id,
    name: `Track ${index}`,
    clips: [],
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0,
  };
}

interface HistoryEntry {
  label: string;
  before: TrackMeta[];
  after: TrackMeta[];
}

/**
 * The engine-driven (hydrated) commit `TimelineStage.tsx` last produced,
 * kept alongside its dehydrated form so the *next* render can recognize
 * "this is the same commit coming back around" and hand the engine its own
 * array reference back unchanged, instead of paying for a fresh hydrate()
 * that would defeat WaveformPlaylistProvider's own
 * `tracks === engineTracksRef.current` rebuild-avoidance check. See
 * PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Confirmed library behavior" section.
 *
 * Lives in the store (not TimelineStage.tsx component state) so it updates
 * *atomically* with `present` in the same `set()` call — keeping it as
 * separate React state alongside a Zustand-store `present` update caused a
 * real bug: the two didn't always land in the same render (observed via
 * direct instrumentation — an intermediate render saw the new `present` but
 * the old `lastEngineOutput`), producing one extra render per commit where
 * the passthrough check spuriously missed and hydrate() ran fresh, which was
 * enough to defeat the engine's own `isEngineTracks` check and trigger an
 * avoidable full rebuild. Colocating both in one store update removes the
 * possibility entirely.
 */
interface EngineOutputCache {
  dehydrated: TrackMeta[];
  raw: ClipTrack[];
}

const HISTORY_LIMIT = 100;

interface ProjectStoreState {
  present: TrackMeta[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  lastEngineOutput: EngineOutputCache | null;
  /**
   * The state as it was *before a live-drag gesture started* (see
   * ClipDragLayer.tsx's `beginLiveDrag`/`cancelLiveDrag` calls) — null
   * outside of an in-progress trim drag. `commitEngineOutput` uses this
   * (instead of `present`) as the undo entry's `before` when set. Needed
   * because `updateEngineOutputLive` continuously overwrites `present` with
   * each live-preview frame so the waveform visibly tracks the drag — by the
   * time the drag settles, `present` already reflects something very close
   * to the final trimmed state, not the true pre-drag baseline. Found via
   * direct instrumentation: without this, a trim's single undo landed back
   * on (essentially) the last live-preview frame instead of the original,
   * pre-trim clip — visually indistinguishable from "undo did nothing."
   */
  dragBaseline: TrackMeta[] | null;
  /** "Please save" signal, bumped from EditorShell.tsx on a live mixer
   *  change — mute/solo/volume/pan never touch `past`, so this is what
   *  re-arms PodcastEditor.tsx's save timer for a session that ends on a
   *  pure mixer toggle. Value itself is never read. */
  mixerTouchVersion: number;
  touchMixerState: () => void;
  /**
   * `update` is always applied to whatever `present` *actually is* at the
   * moment this runs (read from `set`'s own state parameter, never a value
   * captured earlier) — never a materialized array. A caller with an
   * intervening `await` (e.g. useTimelineTracks.ts's addFilesToTrack, which
   * decodes before committing) that closed over a stale `present` snapshot
   * would silently revert any commit made during that gap — the same
   * check-then-act shape as the play()/rebuild races already documented in
   * CLAUDE.md, just one layer up. See PERSISTENCE_UNDO_ORIGINAL_PLAN.md's
   * "Stale-closure rule."
   */
  commit: (update: (prev: TrackMeta[]) => TrackMeta[], label: string) => void;
  /**
   * For TimelineStage.tsx's onTracksChange only — a *settled* engine-driven
   * update (trim/split/move's actual commit). Pushes one "Edit timeline"
   * history entry, using `dragBaseline` as `before` when set (see its own
   * doc comment), falling back to `present` otherwise (split, move, and any
   * other single-shot engine-driven change never sets a dragBaseline, so
   * `present` is already the correct pre-change value for those). Skips the
   * history push entirely if the resulting content is structurally identical
   * (see utils/deepEqual.ts) to `before` — the incremental-add path's
   * `engine.addTrack()` triggers the engine's own "statechange" mirror-back
   * purely to confirm what `useTimelineTracks.addTrack()` already committed
   * itself, and without this check every "Add track" was silently followed
   * by a second, content-identical "Edit timeline" entry, so a single Undo
   * only ever undid the harmless echo, never the actual add (found via
   * direct instrumentation). A no-op still updates `present`/
   * `lastEngineOutput` to the engine's own object references (needed for the
   * passthrough cache) — it just doesn't touch `past`/`future`.
   */
  commitEngineOutput: (raw: ClipTrack[], dehydrated: TrackMeta[]) => void;
  /**
   * For ClipDragLayer.tsx's live trim preview only (see its own doc comment)
   * — updates `present` so the waveform visibly tracks the drag, but does
   * NOT push undo history. Without this, every intermediate pointer-move
   * frame of a single trim gesture (there can be dozens) would each become
   * its own separately-undoable step, instead of the whole trim undoing in
   * one press like every other mutation in this app.
   */
  updateEngineOutputLive: (raw: ClipTrack[], dehydrated: TrackMeta[]) => void;
  /** Captures `present` as `dragBaseline`, if not already set — called once
   *  from ClipDragLayer.tsx's onDragStart, only for boundary (trim) drags. */
  beginLiveDrag: () => void;
  /** Clears `dragBaseline` without committing anything — called from
   *  ClipDragLayer.tsx's onDragEnd when a boundary drag is cancelled (no
   *  final commit will ever arrive to consume the baseline otherwise). */
  cancelLiveDrag: () => void;
  undo: () => void;
  redo: () => void;
  /** Non-history-pushing replace — used by Phase 3's load-on-mount only. */
  replacePresent: (tracks: TrackMeta[]) => void;
}

export const useProjectStore = create<ProjectStoreState>((set) => ({
  present: [createEmptyTrack(1)],
  past: [],
  future: [],
  lastEngineOutput: null,
  dragBaseline: null,
  mixerTouchVersion: 0,

  touchMixerState: () => set((state) => ({ mixerTouchVersion: state.mixerTouchVersion + 1 })),

  commit: (update, label) => {
    // Called before `set`, not inside its updater — flushSync (which
    // stopIfPlaying uses internally, see its own doc comment above) throws if
    // called from inside another component's render/commit.
    stopIfPlaying();
    set((state) => {
      // Catch up on any live mixer change before this edit's `after` builds
      // from it (see withLiveMixerState's doc comment).
      const before = withLiveMixerState(state.present);
      const after = update(before);
      return {
        present: after,
        past: [...state.past, { label, before, after }].slice(-HISTORY_LIMIT),
        future: [],
      };
    });
  },

  commitEngineOutput: (raw, dehydrated) =>
    set((state) => {
      // `dehydrated` already has live mixer state (from the engine's own
      // _tracks). `before` doesn't yet if this is the first engine-driven
      // mirror since a mixer change — catch it up so undo doesn't revert it.
      const before = withLiveMixerState(state.dragBaseline ?? state.present);
      if (deepEqual(before, dehydrated)) {
        return { present: dehydrated, lastEngineOutput: { dehydrated, raw }, dragBaseline: null };
      }
      return {
        present: dehydrated,
        lastEngineOutput: { dehydrated, raw },
        past: [...state.past, { label: "Edit timeline", before, after: dehydrated }].slice(-HISTORY_LIMIT),
        future: [],
        dragBaseline: null,
      };
    }),

  updateEngineOutputLive: (raw, dehydrated) =>
    set({ present: dehydrated, lastEngineOutput: { dehydrated, raw } }),

  beginLiveDrag: () =>
    set((state) => (state.dragBaseline === null ? { dragBaseline: state.present } : state)),

  cancelLiveDrag: () => set({ dragBaseline: null }),

  undo: () => {
    stopIfPlaying();
    set((state) => {
      if (state.past.length === 0) return state;
      const entry = state.past[state.past.length - 1];
      return {
        present: cloneTracks(entry.before),
        past: state.past.slice(0, -1),
        future: [...state.future, entry],
      };
    });
  },

  redo: () => {
    stopIfPlaying();
    set((state) => {
      if (state.future.length === 0) return state;
      const entry = state.future[state.future.length - 1];
      return {
        present: cloneTracks(entry.after),
        past: [...state.past, entry],
        future: state.future.slice(0, -1),
      };
    });
  },

  replacePresent: (tracks) => set({ present: tracks, past: [], future: [] }),
}));

export const selectCanUndo = (state: ProjectStoreState) => state.past.length > 0;
export const selectCanRedo = (state: ProjectStoreState) => state.future.length > 0;
