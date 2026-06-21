/**
 * Pure helpers for presenting tool calls in the TUI: a one-line summary, the
 * diff-tool predicate, the TodoWrite parser, plus display-name normalization,
 * diff stats, and result-size hints for the tool card. No Ink, no I/O.
 */
import { formatEditDiff, bareToolName } from "../markdown/diff"
import type { Todo } from "../state/types"

/** Tools whose input describes a file edit we render as a diff. */
const DIFF_TOOLS = new Set(["edit", "write", "multi_edit", "multiedit", "str_replace", "create"])

export function isDiffTool(toolName: string): boolean {
  // Namespace-aware: the cognia builtin edit/write tools arrive as
  // `mcp__cognia-tools__edit` on the ai-sdk path; recognise them too, not just
  // the bare SDK-native names on the Anthropic path.
  return DIFF_TOOLS.has(bareToolName(toolName).toLowerCase())
}

/** Where a tool comes from — drives the small namespace badge on the card. */
export type ToolKind = "mcp" | "plugin" | "builtin"

/**
 * Classify a tool by its name prefix: MCP tools arrive as `mcp__<server>__…`
 * and plugin tools as `plugin__<id>__…`; everything else is a builtin.
 */
export function toolKind(toolName: string): ToolKind {
  if (toolName.startsWith("mcp__")) return "mcp"
  if (toolName.startsWith("plugin__")) return "plugin"
  return "builtin"
}

/**
 * A readable label for the tool card header. MCP tools (`mcp__<server>__<tool>`)
 * and plugin tools (`plugin__<id>__<tool>`) collapse to `<source>:<tool>`;
 * builtins are returned unchanged.
 */
export function toolDisplayName(toolName: string): string {
  const m = /^(?:mcp|plugin)__(.+?)__(.+)$/.exec(toolName)
  return m ? `${m[1]}:${m[2]}` : toolName
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

/** A `:offset-end` / `:offset+` / `:0-limit` suffix for a `read` line range. */
function readRange(input: Record<string, unknown>): string | undefined {
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined
  if (offset === undefined && limit === undefined) return undefined
  if (offset !== undefined && limit !== undefined) return `:${offset}-${offset + limit}`
  if (offset !== undefined) return `:${offset}+`
  return `:0-${limit}`
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
  if (name === "read") {
    const path = firstString(input, ["file_path", "filePath", "path"])
    if (!path) return ""
    const range = readRange(input)
    return range ? `${path} ${range}` : path
  }
  if (name === "webfetch" || name === "web_fetch" || name === "fetch") {
    return firstString(input, ["url", "uri"]) ?? ""
  }
  if (name === "task" || name === "dispatch_agent" || name === "agent") {
    return firstString(input, ["subagent_type", "description", "prompt"]) ?? ""
  }
  if (name === "apply_patch" || name === "patch" || name === "apply-patch") {
    const patch = typeof input.patch === "string" ? input.patch : ""
    const files = (patch.match(/^\+\+\+ /gm) ?? []).length
    return files > 0 ? `${files} file${files === 1 ? "" : "s"}` : ""
  }
  return firstString(input, ["file_path", "filePath", "path", "url", "query", "command"]) ?? ""
}

/** Added / removed line counts for a diff tool. */
export interface DiffStat {
  added: number
  removed: number
}

/**
 * Count added / removed lines for a diff tool by reusing the diff renderer
 * ({@link formatEditDiff}). Non-diff tools (and inputs the renderer can't
 * parse) yield zeros.
 */
export function diffStat(toolName: string, input: Record<string, unknown>): DiffStat {
  if (!isDiffTool(toolName)) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const line of formatEditDiff(toolName, input)) {
    if (line.kind === "add") added++
    else if (line.kind === "del") removed++
  }
  return { added, removed }
}

/** Magnitude of a tool result, for the collapsed-card size hint. */
export interface ResultSize {
  lines: number
  bytes: number
}

/**
 * Measure a tool result so a collapsed card can show its size (e.g. "· 320
 * lines") without expanding. Strings are measured directly; objects by their
 * JSON serialization. Nullish / empty results → zeros.
 */
export function summarizeResult(result: unknown): ResultSize {
  if (result == null) return { lines: 0, bytes: 0 }
  let text: string
  if (typeof result === "string") text = result
  else {
    try {
      text = JSON.stringify(result)
    } catch {
      text = String(result)
    }
  }
  if (text.length === 0) return { lines: 0, bytes: 0 }
  return { lines: text.split("\n").length, bytes: text.length }
}

/** Coerce a tool result to plain text: a string verbatim, an MCP content-block
 * array by joining its text blocks, anything else by JSON. */
function resultText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (Array.isArray(result)) {
    const texts = result
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : ""
      )
      .filter(Boolean)
    if (texts.length > 0) return texts.join("\n")
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/**
 * A tool-specific count for the collapsed card header — "12 matches" for grep,
 * "3 files" for glob, "8 entries" for ls — which reads more usefully than a raw
 * line count. Returns undefined for tools without a natural count, so the caller
 * falls back to {@link summarizeResult}.
 */
export function resultCountLabel(toolName: string, result: unknown): string | undefined {
  if (result == null) return undefined
  const text = resultText(result)
  if (!text) return undefined
  const n = text.split("\n").filter((l) => l.trim().length > 0).length
  switch (toolName.toLowerCase()) {
    case "grep":
    case "search":
      return `${n} match${n === 1 ? "" : "es"}`
    case "glob":
      return `${n} file${n === 1 ? "" : "s"}`
    case "ls":
    case "list":
      return `${n} entr${n === 1 ? "y" : "ies"}`
    default:
      return undefined
  }
}

/**
 * A one-line preview of a (usually error) result for the collapsed card — the
 * first non-blank line, trimmed to `max` chars. Lets an errored tool show what
 * failed without expanding. Objects are JSON-stringified; empty → "".
 */
export function resultPreview(result: unknown, max = 60): string {
  if (result == null) return ""
  let text: string
  if (typeof result === "string") text = result
  else {
    try {
      text = JSON.stringify(result)
    } catch {
      text = String(result)
    }
  }
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}
