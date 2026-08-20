import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AssetTranscript, TrackMeta } from "./types";

/**
 * IndexedDB persistence. See PERSISTENCE_UNDO_ORIGINAL_PLAN.md's Phase 3 for
 * the original two-store design (`project`/`assets`); see
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 1 for the two stores
 * added on top of that (`compressedAssets`/`transcripts`).
 *
 * `project` holds a single fixed-key record: the current `present` snapshot
 * only, never `past`/`future` — undo history doesn't need to survive a
 * reload, and leaving it out sidesteps any asset-GC-vs-history-reference
 * question entirely (not in scope here, see CLAUDE.md's "Known limitations").
 *
 * `assets` holds the original uploaded `File`/`Blob` (not the decoded
 * `AudioBuffer` — no cheap re-encode path back to a file), keyed by the
 * same content-hash `assetId` minted in utils/assetRegistry.ts. Because that
 * key is a content hash, writing the same file's bytes twice is an
 * idempotent overwrite of the same record, not a duplicate — cross-upload
 * dedup falls out of the key itself, no extra logic needed here.
 *
 * `compressedAssets` holds the Opus-encoded blob each asset gets compressed
 * to for transcription (see utils/audioCompression.ts) — one record per
 * assetId. `transcripts` holds one `AssetTranscript` per assetId (status +
 * word-level timestamps, asset-relative — see utils/types.ts's own doc
 * comment on why).
 */

const DB_NAME = "editor-pro";
const DB_VERSION = 2;
const PROJECT_STORE = "project";
const ASSETS_STORE = "assets";
const COMPRESSED_ASSETS_STORE = "compressedAssets";
const TRANSCRIPTS_STORE = "transcripts";
const PROJECT_KEY = "current";

interface ProjectRecord {
  schemaVersion: 1;
  tracks: TrackMeta[];
  updatedAt: number;
}

interface AssetRecord {
  blob: Blob;
  type: string;
  addedAt: number;
}

interface CompressedAssetRecord {
  blob: Blob;
  addedAt: number;
}

interface EditorProDB extends DBSchema {
  [PROJECT_STORE]: {
    key: string;
    value: ProjectRecord;
  };
  [ASSETS_STORE]: {
    key: string;
    value: AssetRecord;
  };
  [COMPRESSED_ASSETS_STORE]: {
    key: string;
    value: CompressedAssetRecord;
  };
  [TRANSCRIPTS_STORE]: {
    key: string;
    value: AssetTranscript;
  };
}

// Opened lazily, on first actual use, never at module scope — `idb` itself
// doesn't touch `window`/`indexedDB` at import time, but there's no reason
// to rely on that holding forever when deferring costs nothing. Every caller
// below already only runs from inside an effect (useProjectHydration.ts,
// PodcastEditor.tsx's debounced save, useTimelineTracks.ts's addFilesToTrack),
// so this is never reached during Next's SSR pass regardless.
let dbPromise: Promise<IDBPDatabase<EditorProDB>> | null = null;

function getDb(): Promise<IDBPDatabase<EditorProDB>> {
  if (!dbPromise) {
    dbPromise = openDB<EditorProDB>(DB_NAME, DB_VERSION, {
      // Guarded on oldVersion so an existing v1 database (project/assets
      // already populated) only gains the two new stores rather than being
      // recreated — idb's upgrade callback fires with the DB's actual prior
      // version, 0 for a genuinely fresh database.
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore(PROJECT_STORE);
          db.createObjectStore(ASSETS_STORE);
        }
        if (oldVersion < 2) {
          db.createObjectStore(COMPRESSED_ASSETS_STORE);
          db.createObjectStore(TRANSCRIPTS_STORE);
        }
      },
    });
  }
  return dbPromise;
}

export async function saveProject(tracks: TrackMeta[]): Promise<void> {
  const db = await getDb();
  await db.put(
    PROJECT_STORE,
    { schemaVersion: 1, tracks, updatedAt: Date.now() },
    PROJECT_KEY
  );
}

/** Returns `null` if no project has ever been saved (fresh IndexedDB). */
export async function loadProject(): Promise<TrackMeta[] | null> {
  const db = await getDb();
  const record = await db.get(PROJECT_STORE, PROJECT_KEY);
  return record?.tracks ?? null;
}

export async function saveAsset(assetId: string, blob: Blob): Promise<void> {
  const db = await getDb();
  await db.put(ASSETS_STORE, { blob, type: blob.type, addedAt: Date.now() }, assetId);
}

export async function loadAsset(assetId: string): Promise<Blob | undefined> {
  const db = await getDb();
  const record = await db.get(ASSETS_STORE, assetId);
  return record?.blob;
}

/** Batched parallel read — used by useProjectHydration.ts to fetch every
 *  asset a loaded project references in one pass. Ids with no matching
 *  record (asset GC isn't implemented, see CLAUDE.md, but the store could
 *  still be evicted/cleared out-of-band) are simply absent from the
 *  returned map; the caller decides how to handle a miss. */
export async function loadAssets(assetIds: string[]): Promise<Map<string, Blob>> {
  const db = await getDb();
  const entries = await Promise.all(
    assetIds.map(async (assetId): Promise<[string, Blob | undefined]> => {
      const record = await db.get(ASSETS_STORE, assetId);
      return [assetId, record?.blob];
    })
  );
  const result = new Map<string, Blob>();
  for (const [assetId, blob] of entries) {
    if (blob) result.set(assetId, blob);
  }
  return result;
}

/** Same idempotent-overwrite-by-content-hash property as saveAsset — an
 *  assetId's compressed blob never changes once computed, so a repeat write
 *  is always a no-op in practice, not a real overwrite. A pre-refactor
 *  record has a `.chunks` field instead of `.blob` — read as undefined,
 *  handled the same as "nothing cached" by every caller. */
export async function saveCompressedAsset(assetId: string, blob: Blob): Promise<void> {
  const db = await getDb();
  await db.put(COMPRESSED_ASSETS_STORE, { blob, addedAt: Date.now() }, assetId);
}

export async function loadCompressedAsset(assetId: string): Promise<Blob | undefined> {
  const db = await getDb();
  const record = await db.get(COMPRESSED_ASSETS_STORE, assetId);
  return record?.blob;
}

export async function saveTranscript(transcript: AssetTranscript): Promise<void> {
  const db = await getDb();
  await db.put(TRANSCRIPTS_STORE, transcript, transcript.assetId);
}

export async function loadTranscript(assetId: string): Promise<AssetTranscript | undefined> {
  const db = await getDb();
  return db.get(TRANSCRIPTS_STORE, assetId);
}

/** Batched parallel read, same shape as loadAssets — used by
 *  useProjectHydration.ts to repopulate transcriptStore.ts on reload. */
export async function loadTranscripts(assetIds: string[]): Promise<Map<string, AssetTranscript>> {
  const db = await getDb();
  const entries = await Promise.all(
    assetIds.map(async (assetId): Promise<[string, AssetTranscript | undefined]> => {
      const record = await db.get(TRANSCRIPTS_STORE, assetId);
      return [assetId, record];
    })
  );
  const result = new Map<string, AssetTranscript>();
  for (const [assetId, transcript] of entries) {
    if (transcript) result.set(assetId, transcript);
  }
  return result;
}
