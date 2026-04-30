"use client"

// ZIP-many-sessions exporter. Wraps `lib/export/batch/batch-export.ts` and
// handles the save/download path. JSZip stays lazy-loaded inside the lib
// module — no eager bundling.

import { useCallback, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { exportBatch } from "@/lib/export/batch/batch-export"
import type { ChatSession } from "@/lib/claude/types"
import type { SingleExportFormat } from "@/lib/export/single"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"

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

export type BatchExportResult =
  | { ok: true; canceled: false; filename: string; exportedCount: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

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

      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const { writeFile } = await import("@tauri-apps/plugin-fs")
        const path = await save({
          defaultPath: result.filename,
          filters: [{ name: "ZIP", extensions: ["zip"] }],
        })
        if (!path) return { ok: true, canceled: true }
        const buffer = new Uint8Array(await result.blob.arrayBuffer())
        await writeFile(path, buffer)
      } else {
        const url = URL.createObjectURL(result.blob)
        const a = document.createElement("a")
        a.href = url
        a.download = result.filename
        a.click()
        URL.revokeObjectURL(url)
      }
      return {
        ok: true,
        canceled: false,
        filename: result.filename,
        exportedCount: result.exportedCount,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [])

  return { run, busy, progress }
}
