/**
 * Pure formatters for `/export` — render a session's on-disk transcript
 * (`TranscriptEntry[]`, the CLI's append-only JSONL store) to markdown / json /
 * jsonl. `jsonl` is the raw persisted shape (one record per line); `json` is a
 * pretty array; `markdown` is a readable document. Kept pure so the controller's
 * fs side is the only thing that needs a fake in tests.
 */
import { cellToText } from "./scrollback-search"
import type { TranscriptEntry, TranscriptRole } from "../../agent/transcript"
import type { Cell } from "../state/types"

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

/**
 * Heading for each transcript cell kind in the clipboard export, or null to drop
 * the cell. Notices are ephemeral UI chatter ("Copied…", "Mouse: scroll…") — they
 * are not part of the conversation and would only pollute a paste.
 */
const CELL_HEADING: Record<Cell["kind"], string | null> = {
  user: "## User",
  assistant: "## Assistant",
  thinking: "### Thinking",
  commentary: "### Commentary",
  tool: "### Tool",
  "content-part": "### Content",
  "canonical-event": "### Event",
  bash: "### Shell",
  todo: "### Todos",
  plan: "### Plan",
  error: "### Error",
  notice: null,
}

/** Cell kinds whose body is program output, not prose — fenced so a paste keeps
 * its formatting instead of being re-flowed as markdown. */
const FENCED_KINDS = new Set<Cell["kind"]>(["tool", "bash"])

/**
 * Render the LIVE transcript (the in-memory cells the TUI is showing) as
 * markdown, for the copy-transcript chord.
 *
 * Distinct from {@link formatTranscriptExport}, which renders the persisted
 * `TranscriptEntry[]` store and therefore only knows user/assistant/system
 * turns. This one covers every cell kind on screen — tool calls, shell output,
 * thinking, plans — because "copy the conversation" should hand over what you
 * are actually looking at. Both share {@link cellToText} with find/search, so a
 * cell renders to the same text everywhere.
 */
export function formatCellsAsMarkdown(cells: readonly Cell[]): string {
  const parts: string[] = []
  for (const cell of cells) {
    const heading = CELL_HEADING[cell.kind]
    if (heading === null || heading === undefined) continue
    const body = cellToText(cell).trim()
    if (!body) continue
    parts.push(heading, "", FENCED_KINDS.has(cell.kind) ? `\`\`\`\n${body}\n\`\`\`` : body, "")
  }
  return parts.length === 0 ? "" : `# Conversation\n\n${parts.join("\n")}`
}
