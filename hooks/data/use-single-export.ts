"use client"

// One-shot exporter for a single session. Picks a format, fetches messages,
// renders, and saves to disk (Tauri) or triggers a browser download.

import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"

import { useCallback, useState } from "react"
import { renderSingleExport } from "@/lib/export/single"
import type { SingleExportFormat } from "@/lib/export/single"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"
import { resolveThemeWallpaper } from "@/lib/export/html/theme-wallpaper"
import { getDb } from "@/lib/db/schema"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { saveExport, type SaveExportOutcome } from "@/lib/files/save-export"
import { resolveSessionTwinProvenance } from "@/lib/twin/export-provenance"
import { enforceExportDisclosure } from "@/lib/export/disclosure"

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
  /** Lay the theme's real wallpaper behind the export (HTML/animated only). */
  withWallpaper?: boolean
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
  const scope = getRuntimeTargetScopeKey()
  const database = typeof window === "undefined" ? null : getDb()

  const run = useCallback(
    async (args: RunArgs): Promise<SingleExportResult> => {
      if (!database) return { kind: "cancelled" }
      const isCurrent = () => getRuntimeTargetScopeKey() === scope && getDb().name === database.name
      if (!isCurrent()) return { kind: "cancelled" }
      setBusy(true)
      const hooks = getPluginEventHooks()
      let saved = false
      // Plugin host: announce export start so plugins can observe / log.
      try {
        await hooks.dispatchExportStart(args.session.id, args.format)
        if (!isCurrent()) return { kind: "cancelled" }
        const messages =
          args.messages ??
          (await database.messages.where("sessionId").equals(args.session.id).sortBy("createdAt"))

        if (!isCurrent()) return { kind: "cancelled" }
        const [wallpaperDataUrl, provenance] = await Promise.all([
          resolveThemeWallpaper(args.theme, args.withWallpaper ?? false),
          resolveSessionTwinProvenance(args.session, messages),
        ])

        if (!isCurrent()) return { kind: "cancelled" }
        const rendered = renderSingleExport({
          format: args.format,
          session: args.session,
          messages,
          theme: args.theme,
          customTheme: args.customTheme,
          includeMetadata: args.includeMetadata,
          includeTimestamps: args.includeTimestamps,
          includeTokens: args.includeTokens,
          wallpaperDataUrl,
          includeAllBranches: args.includeAllBranches,
          provenance,
        })

        // Plugin host: let plugins rewrite the export payload before it's
        // written to disk / downloaded. The pipeline returns the original
        // content unchanged when no plugin transforms it.
        const transformed = await hooks.dispatchExportTransform(rendered.content, args.format)
        if (!isCurrent()) return { kind: "cancelled" }
        const out = {
          ...rendered,
          content: enforceExportDisclosure(transformed, args.format, provenance),
        }

        const outcome = await saveExport({
          filename: out.filename,
          data: out.content,
          mimeType: out.mimeType,
          shouldContinue: isCurrent,
        })
        saved = outcome.kind === "saved"
        return outcome
      } catch (err) {
        return { kind: "error", message: err instanceof Error ? err.message : String(err) }
      } finally {
        setBusy(false)
        hooks.dispatchExportComplete(args.session.id, args.format, saved)
      }
    },
    [scope, database]
  )

  return { run, busy }
}
