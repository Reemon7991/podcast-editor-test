import { create } from "zustand";
import type { ClipTrack } from "@waveform-playlist/browser";
import type { TrackMeta } from "../utils/types";
import { deepEqual } from "../utils/deepEqual";

export function createEmptyTrack(index: number): TrackMeta {
  return {
    id: crypto.randomUUID(),
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

  commit: (update, label) =>
    set((state) => {
      const before = state.present;
      const after = update(before);
      return {
        present: after,
        past: [...state.past, { label, before, after }].slice(-HISTORY_LIMIT),
        future: [],
      };
    }),

  commitEngineOutput: (raw, dehydrated) =>
    set((state) => {
      const before = state.dragBaseline ?? state.present;
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

  undo: () =>
    set((state) => {
      if (state.past.length === 0) return state;
      const entry = state.past[state.past.length - 1];
      return {
        present: entry.before,
        past: state.past.slice(0, -1),
        future: [...state.future, entry],
      };
    }),

  redo: () =>
    set((state) => {
      if (state.future.length === 0) return state;
      const entry = state.future[state.future.length - 1];
      return {
        present: entry.after,
        past: [...state.past, entry],
        future: state.future.slice(0, -1),
      };
    }),

  replacePresent: (tracks) => set({ present: tracks, past: [], future: [] }),
}));

export const selectCanUndo = (state: ProjectStoreState) => state.past.length > 0;
export const selectCanRedo = (state: ProjectStoreState) => state.future.length > 0;
