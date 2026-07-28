"use client";

interface ExportButtonProps {
  exportProject: () => Promise<unknown>;
  isExporting: boolean;
  error: string | null;
}

/**
 * "Export" button — same style as "Upload clip", disables while rendering.
 * No percentage: useExportWav's progress only fires at 10%/90%/100%, so a
 * number here would just sit unmoving and look stuck.
 */
export function ExportButton({ exportProject, isExporting, error }: ExportButtonProps) {
  const handleClick = () => {
    exportProject().catch(() => {
      // error is already surfaced via the `error` state below
    });
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isExporting}
        className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-700"
      >
        {isExporting ? "Exporting…" : "Export"}
      </button>
      {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
