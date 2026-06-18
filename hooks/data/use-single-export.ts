"use client"

// One-shot exporter for a single session. Picks a format, fetches messages,
// renders, and saves to disk (Tauri) or triggers a browser download.

import { useCallback, useState } from "react"
import { renderSingleExport } from "@/lib/export/single"
import type { SingleExportFormat } from "@/lib/export/single"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"
import { getDb } from "@/lib/db/schema"
import { getPluginEventHooks } from "@/lib/plugin"
import { saveExport, type SaveExportOutcome } from "@/lib/files/save-export"

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

/**
 * Outcome of a single export. Mirrors {@link SaveExportOutcome} so callers feed
 * it straight into `notifyExportOutcome` for the where-did-it-go toast.
 */
export type SingleExportResult = SaveExportOutcome

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

      const outcome = await saveExport({
        filename: out.filename,
        data: out.content,
        mimeType: out.mimeType,
      })
      hooks.dispatchExportComplete(args.session.id, args.format, outcome.kind === "saved")
      return outcome
    } catch (err) {
      hooks.dispatchExportComplete(args.session.id, args.format, false)
      return { kind: "error", message: err instanceof Error ? err.message : String(err) }
    } finally {
      setBusy(false)
    }
  }, [])

  return { run, busy }
}
