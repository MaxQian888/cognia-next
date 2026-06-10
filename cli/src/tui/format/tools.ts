/**
 * Pure helpers for presenting tool calls in the TUI: a one-line summary, the
 * diff-tool predicate, and the TodoWrite parser. No Ink, no I/O.
 */
import type { Todo } from "../state/types"

/** Tools whose input describes a file edit we render as a diff. */
const DIFF_TOOLS = new Set(["edit", "write", "multi_edit", "multiedit", "str_replace", "create"])

export function isDiffTool(toolName: string): boolean {
  return DIFF_TOOLS.has(toolName.toLowerCase())
}

/** The TodoWrite tool name (case-insensitive match). */
export function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase() === "todowrite"
}

/**
 * Parse a TodoWrite tool input into a typed todo list. Tolerant of partial or
 * malformed entries (skips anything without a string `content`).
 */
export function parseTodos(input: unknown): Todo[] {
  if (!input || typeof input !== "object") return []
  const raw = (input as { todos?: unknown }).todos
  if (!Array.isArray(raw)) return []
  const out: Todo[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const content = (entry as { content?: unknown }).content
    if (typeof content !== "string" || content.length === 0) continue
    const statusRaw = (entry as { status?: unknown }).status
    const status = statusRaw === "in_progress" || statusRaw === "completed" ? statusRaw : "pending"
    const activeForm = (entry as { activeForm?: unknown }).activeForm
    out.push({
      content,
      status,
      ...(typeof activeForm === "string" ? { activeForm } : {}),
    })
  }
  return out
}

/** First string field present among the candidates, trimmed to `max` chars. */
function firstString(input: Record<string, unknown>, keys: string[], max = 80): string | undefined {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === "string" && v.length > 0) {
      return v.length > max ? v.slice(0, max - 1) + "…" : v
    }
  }
  return undefined
}

/**
 * A compact, human-readable summary of a tool call for the collapsed tool card
 * header — e.g. the file path for an edit, the command for bash, the pattern
 * for grep.
 */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.toLowerCase()
  if (name === "bash" || name === "shell") {
    return firstString(input, ["command", "cmd"]) ?? ""
  }
  if (name === "grep" || name === "search") {
    const pattern = firstString(input, ["pattern", "query", "regex"])
    const path = firstString(input, ["path", "glob"], 40)
    return [pattern, path].filter(Boolean).join("  ")
  }
  if (name === "glob") {
    return firstString(input, ["pattern", "glob"]) ?? ""
  }
  return firstString(input, ["file_path", "filePath", "path", "url", "query", "command"]) ?? ""
}
