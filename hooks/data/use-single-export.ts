"use client"

// One-shot exporter for a single session. Picks a format, fetches messages,
// renders, and saves to disk (Tauri) or triggers a browser download.

import { useCallback, useState } from "react"
import { isTauri } from "@/lib/tauri"
import { renderSingleExport } from "@/lib/export/single"
import type { SingleExportFormat } from "@/lib/export/single"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"
import { getDb } from "@/lib/db/schema"
import { getPluginEventHooks } from "@/lib/plugin"

interface RunArgs {
  format: SingleExportFormat
  session: ChatSession
  /** Pass messages in if you already have them; otherwise we read from Dexie. */
  messages?: StoredMessage[]
  theme?: ThemeId
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
  includeTokens?: boolean
  /** JSONL formats only — include every regeneration branch (see renderSingleExport). */
  includeAllBranches?: boolean
}

export type SingleExportResult =
  | { ok: true; canceled: false; filename: string; sizeBytes: number }
  | { ok: true; canceled: true }
  | { ok: false; error: string }

export function useSingleExport() {
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (args: RunArgs): Promise<SingleExportResult> => {
    setBusy(true)
    const hooks = getPluginEventHooks()
    // Plugin host: announce export start so plugins can observe / log.
    await hooks.dispatchExportStart(args.session.id, args.format)
    try {
      const messages =
        args.messages ??
        (await getDb().messages.where("sessionId").equals(args.session.id).sortBy("createdAt"))

      const rendered = renderSingleExport({
        format: args.format,
        session: args.session,
        messages,
        theme: args.theme,
        customTheme: args.customTheme,
        includeMetadata: args.includeMetadata,
        includeTimestamps: args.includeTimestamps,
        includeTokens: args.includeTokens,
        includeAllBranches: args.includeAllBranches,
      })

      // Plugin host: let plugins rewrite the export payload before it's
      // written to disk / downloaded. The pipeline returns the original
      // content unchanged when no plugin transforms it.
      const transformed = await hooks.dispatchExportTransform(rendered.content, args.format)
      const out = { ...rendered, content: transformed }

      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog")
        const { writeTextFile } = await import("@tauri-apps/plugin-fs")
        const ext = extOf(out.filename)
        const path = await save({
          defaultPath: out.filename,
          filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        })
        if (!path) {
          hooks.dispatchExportComplete(args.session.id, args.format, false)
          return { ok: true, canceled: true }
        }
        await writeTextFile(path, out.content)
      } else {
        const blob = new Blob([out.content], { type: out.mimeType })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = out.filename
        a.click()
        URL.revokeObjectURL(url)
      }
      hooks.dispatchExportComplete(args.session.id, args.format, true)
      return { ok: true, canceled: false, filename: out.filename, sizeBytes: out.content.length }
    } catch (err) {
      hooks.dispatchExportComplete(args.session.id, args.format, false)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      setBusy(false)
    }
  }, [])

  return { run, busy }
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot >= 0 ? filename.slice(dot + 1) : "txt"
}
