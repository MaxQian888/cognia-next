"use client"

// ZIP-many-sessions exporter. Wraps `lib/export/batch/batch-export.ts` and
// handles the save/download path. JSZip stays lazy-loaded inside the lib
// module — no eager bundling.

import { useCallback, useState } from "react"
import { exportBatch } from "@/lib/export/batch/batch-export"
import type { ChatSession } from "@/lib/claude/types"
import type { SingleExportFormat } from "@/lib/export/single"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"
import { saveExport, type SaveExportOutcome } from "@/lib/files/save-export"

interface RunArgs {
  sessions: ChatSession[]
  format: SingleExportFormat
  theme?: ThemeId
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
}

export interface BatchProgress {
  completed: number
  total: number
  currentTitle: string
}

export interface BatchExportResult {
  /** Where the ZIP landed — feed straight into `notifyExportOutcome`. */
  outcome: SaveExportOutcome
  /** Number of sessions packed into the archive (0 when cancelled/errored). */
  exportedCount: number
}

export function useBatchExport() {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BatchProgress | null>(null)

  const run = useCallback(async (args: RunArgs): Promise<BatchExportResult> => {
    setBusy(true)
    setProgress({ completed: 0, total: args.sessions.length, currentTitle: "" })
    try {
      const result = await exportBatch({
        sessions: args.sessions,
        format: args.format,
        theme: args.theme,
        customTheme: args.customTheme,
        includeMetadata: args.includeMetadata,
        includeTimestamps: args.includeTimestamps,
        onProgress: setProgress,
      })

      const outcome = await saveExport({
        filename: result.filename,
        data: result.blob,
        mimeType: "application/zip",
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      })
      return {
        outcome,
        exportedCount: outcome.kind === "saved" ? result.exportedCount : 0,
      }
    } catch (err) {
      return {
        outcome: { kind: "error", message: err instanceof Error ? err.message : String(err) },
        exportedCount: 0,
      }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [])

  return { run, busy, progress }
}
