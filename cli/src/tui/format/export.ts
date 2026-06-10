/**
 * Pure formatters for `/export` — render a session's on-disk transcript
 * (`TranscriptEntry[]`, the CLI's append-only JSONL store) to markdown / json /
 * jsonl. `jsonl` is the raw persisted shape (one record per line); `json` is a
 * pretty array; `markdown` is a readable document. Kept pure so the controller's
 * fs side is the only thing that needs a fake in tests.
 */
import type { TranscriptEntry, TranscriptRole } from "../../agent/transcript"

export type ExportFormat = "markdown" | "json" | "jsonl"

/** Normalize a user-supplied format token; unknown/empty defaults to markdown. */
export function normalizeExportFormat(raw: string | undefined): ExportFormat {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "json":
      return "json"
    case "jsonl":
      return "jsonl"
    case "md":
    case "markdown":
    case "":
      return "markdown"
    default:
      return "markdown"
  }
}

/** File extension for a format (`markdown` → `md`). */
export function exportExtension(format: ExportFormat): string {
  return format === "markdown" ? "md" : format
}

const ROLE_HEADING: Record<TranscriptRole, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
}

/** Render the transcript to the requested format. */
export function formatTranscriptExport(entries: TranscriptEntry[], format: ExportFormat): string {
  if (format === "jsonl") {
    if (entries.length === 0) return ""
    return entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  }
  if (format === "json") {
    return JSON.stringify(entries, null, 2) + "\n"
  }
  const parts: string[] = ["# Conversation export", ""]
  for (const e of entries) {
    parts.push(`## ${ROLE_HEADING[e.role] ?? e.role}`, "", e.content.trim(), "")
  }
  return parts.join("\n")
}
