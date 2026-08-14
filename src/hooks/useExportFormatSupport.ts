"use client";

import { useEffect, useState } from "react";
import {
  EXPORT_FORMAT_ORDER,
  canEncodeFormat,
  ensureMp3EncoderReady,
  type ExportFormat,
} from "../utils/exportFormats";

const ALL_SUPPORTED = Object.fromEntries(
  EXPORT_FORMAT_ORDER.map((format) => [format, true])
) as Record<ExportFormat, boolean>;

/**
 * Feature-detects MP3/AAC encoder support once on mount (browser support
 * doesn't change mid-session) — see utils/exportFormats.ts's own doc comment
 * on why this varies by browser for MP3 specifically. Starts optimistic
 * (every format "supported") so the export menu doesn't flash disabled while
 * the check is in flight; corrects itself once canEncodeFormat resolves.
 *
 * Awaits ensureMp3EncoderReady() first — registers the WASM/LAME polyfill if
 * this browser has no native MP3 encoder — so the canEncodeFormat("mp3-*")
 * checks right after it reflect the *post-polyfill* reality, not the raw
 * native-only one. On a browser that already has native MP3, this resolves
 * immediately with no extra download. If registration itself ever fails
 * (e.g. Worker/WebAssembly blocked by a strict CSP), the catch below leaves
 * MP3 correctly disabled instead of throwing out of this effect.
 */
export function useExportFormatSupport(): Record<ExportFormat, boolean> {
  const [support, setSupport] = useState<Record<ExportFormat, boolean>>(ALL_SUPPORTED);

  useEffect(() => {
    let cancelled = false;
    ensureMp3EncoderReady()
      .catch((err) => {
        console.error("[podcast-editor] MP3 encoder polyfill failed to register", err);
      })
      .then(() => Promise.all(EXPORT_FORMAT_ORDER.map((format) => canEncodeFormat(format))))
      .then((results) => {
        if (cancelled) return;
        const next = Object.fromEntries(
          EXPORT_FORMAT_ORDER.map((format, i) => [format, results[i]])
        ) as Record<ExportFormat, boolean>;
        setSupport(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return support;
}
