// Bulk export of many sessions to a single ZIP. Each session lands as a
// separate file under `<slug>.<ext>`. JSZip is loaded lazily to keep it out
// of the main bundle until the user opens the batch dialog.

import type { ChatSession } from "@cognia/agent-config-types"
import { listMessages } from "@/lib/db/messages"
import { renderSingleExport, type SingleExportFormat } from "@/lib/export/single"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"
import { getDb } from "@/lib/db/schema"
import type { UIMessage } from "ai"
import type { StoredMessage } from "@cognia/agent-config-types"

export interface BatchExportOptions {
  /** Sessions to export. */
  sessions: ChatSession[]
  format: SingleExportFormat
  theme?: ThemeId
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
  /** Reports progress per-session for the UI's progress bar. */
  onProgress?: (info: { completed: number; total: number; currentTitle: string }) => void
}

export interface BatchExportResult {
  /** Generated ZIP as a binary Blob (browser) or Uint8Array (Node tests). */
  blob: Blob
  filename: string
  /** Number of sessions actually written (skipped sessions with 0 messages). */
  exportedCount: number
}

export async function exportBatch(opts: BatchExportOptions): Promise<BatchExportResult> {
  const { sessions, onProgress } = opts
  // Lazy-load jszip — only paid for when the user opens this dialog.
  const { default: JSZip } = await import("jszip")
  const zip = new JSZip()
  const exportedAt = new Date()
  const seen = new Map<string, number>()
  let exportedCount = 0

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    onProgress?.({ completed: i, total: sessions.length, currentTitle: session.title })

    const uiMessages = await listMessages(session.id)
    if (uiMessages.length === 0) continue

    // Reconstitute StoredMessage from the UIMessage list — `listMessages`
    // strips the senderId/createdAt; we re-fetch the raw rows so the export
    // has everything it needs.
    const rows = await getDb().messages.where("sessionId").equals(session.id).sortBy("createdAt")
    const messages = rows.length > 0 ? rows : reconstitute(uiMessages, session.id)

    const rendered = renderSingleExport({
      format: opts.format,
      session,
      messages,
      exportedAt,
      theme: opts.theme,
      customTheme: opts.customTheme,
      includeMetadata: opts.includeMetadata,
      includeTimestamps: opts.includeTimestamps,
    })

    // Disambiguate identical filenames (two sessions called "Hello world").
    const dupCount = seen.get(rendered.filename) ?? 0
    seen.set(rendered.filename, dupCount + 1)
    const filename =
      dupCount === 0 ? rendered.filename : appendSuffix(rendered.filename, ` (${dupCount + 1})`)

    zip.file(filename, rendered.content)
    exportedCount++
  }

  onProgress?.({ completed: sessions.length, total: sessions.length, currentTitle: "" })

  const blob = await zip.generateAsync({ type: "blob" })
  const datePart = exportedAt.toISOString().slice(0, 10)
  return {
    blob,
    filename: `cognia-batch-export-${datePart}.zip`,
    exportedCount,
  }
}

function reconstitute(messages: UIMessage[], sessionId: string): StoredMessage[] {
  return messages.map((m, i) => ({
    id: m.id,
    sessionId,
    role: m.role,
    parts: m.parts,
    createdAt: i,
  }))
}

function appendSuffix(filename: string, suffix: string): string {
  const dot = filename.lastIndexOf(".")
  if (dot < 0) return filename + suffix
  return filename.slice(0, dot) + suffix + filename.slice(dot)
}
