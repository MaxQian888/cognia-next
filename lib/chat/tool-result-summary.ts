/**
 * Pure helpers that distill a tool call's *result* (output / errorText) into a
 * compact descriptor for the agent-flow display — e.g. grep → "12 matches",
 * glob → "3 files", edit → "+5 −2", read → "320 lines". Complements
 * {@link summarizeToolCall} (which summarizes the *input* target).
 *
 * Framework-free and i18n-neutral on purpose: it returns a structured
 * descriptor and lets the row/header component map `kind` → a translated label,
 * so the same logic stays trivially unit-testable without React or next-intl.
 *
 * Mirrors the CLI's `cli/src/tui/format/tools.ts` result helpers, adapted to
 * the web `ToolUIPart` shape (string output, MCP content-block arrays, objects).
 */

import { normalizeToolName, type ToolPartLike } from "./tool-summary"

/** Structured result summary; the component resolves `kind` to an i18n label. */
export type ToolResultDescriptor =
  | { kind: "diff"; added: number; removed: number; tone: "success" }
  | { kind: "matches"; count: number; tone: "neutral" }
  | { kind: "files"; count: number; tone: "neutral" }
  | { kind: "entries"; count: number; tone: "neutral" }
  | { kind: "lines"; count: number; tone: "neutral" }
  | { kind: "error"; preview: string; tone: "error" }

/** Diff-style tools whose +/− line counts come from the *input*. */
const DIFF_TOOLS = new Set(["edit", "write", "multiedit", "multi_edit", "str_replace", "create"])

/** Count lines in a block of text; an empty string is zero lines (not one). */
function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.split("\n").length
}

/** Count non-blank lines — the natural "how many results" measure. */
function countNonBlankLines(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length
}

/**
 * Coerce an arbitrary tool result to plain text: a string verbatim, an MCP
 * content-block array by joining its `text` blocks, anything else by JSON.
 */
export function coerceResultText(result: unknown): string {
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

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Added / removed line counts for a diff tool, derived from its input. */
export function diffCounts(
  name: string,
  input: Record<string, unknown> | undefined
): { added: number; removed: number } {
  if (!input) return { added: 0, removed: 0 }
  const lower = name.toLowerCase()
  if (lower === "write" || lower === "create") {
    const content = asString(input.content) ?? asString(input.new_string) ?? ""
    return { added: countLines(content), removed: 0 }
  }
  if (lower === "multiedit" || lower === "multi_edit") {
    let added = 0
    let removed = 0
    const edits = Array.isArray(input.edits) ? input.edits : []
    for (const e of edits) {
      if (!e || typeof e !== "object") continue
      const er = e as Record<string, unknown>
      added += countLines(asString(er.new_string) ?? "")
      removed += countLines(asString(er.old_string) ?? "")
    }
    return { added, removed }
  }
  // edit / str_replace
  const oldStr = asString(input.old_string) ?? ""
  const newStr = asString(input.new_string) ?? ""
  return { added: countLines(newStr), removed: countLines(oldStr) }
}

/** A one-line preview of an (error) result, trimmed to `max` chars. */
export function resultErrorPreview(result: unknown, max = 80): string {
  const text = coerceResultText(result)
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Produce a compact descriptor of a tool call's result, or `null` when there's
 * nothing useful to show yet (still streaming, no natural summary, empty
 * output). Never throws.
 */
export function describeToolResult(part: ToolPartLike): ToolResultDescriptor | null {
  const name = normalizeToolName(part).toLowerCase()
  const input = (part.input ?? undefined) as Record<string, unknown> | undefined

  // Errored tools: show the first line of the failure regardless of tool type.
  if (part.state === "output-error") {
    const preview = resultErrorPreview(
      (part as { errorText?: unknown }).errorText ?? (part as { output?: unknown }).output
    )
    return preview ? { kind: "error", preview, tone: "error" } : null
  }

  // Diff tools summarise the proposed change from the input once completed.
  if (DIFF_TOOLS.has(name)) {
    if (part.state !== "output-available") return null
    const { added, removed } = diffCounts(name, input)
    if (added === 0 && removed === 0) return null
    return { kind: "diff", added, removed, tone: "success" }
  }

  // Output-derived counts are only meaningful once the result has arrived.
  if (part.state !== "output-available") return null
  const text = coerceResultText((part as { output?: unknown }).output)
  if (!text) return null

  if (name === "grep" || name === "search") {
    return { kind: "matches", count: countNonBlankLines(text), tone: "neutral" }
  }
  if (name === "glob") {
    return { kind: "files", count: countNonBlankLines(text), tone: "neutral" }
  }
  if (name === "ls" || name === "list") {
    return { kind: "entries", count: countNonBlankLines(text), tone: "neutral" }
  }
  if (name === "read" || name === "bash" || name === "shell") {
    return { kind: "lines", count: countLines(text), tone: "neutral" }
  }

  // Any other completed tool that produced output text still gets a size hint —
  // a raw line count — so *every* collapsed row shows some result体量, matching
  // the TUI's "N lines" hint rather than leaving generic/MCP tools blank.
  return { kind: "lines", count: countLines(text), tone: "neutral" }
}

/**
 * Live size of a still-running tool's streamed output (stdout/stderr), for the
 * simplified row's progress chip. Only tools whose output streams while
 * `input-available` (e.g. Bash via the sidecar) yield a value; everything else
 * returns null and the row keeps just its pulsing status glyph. Never throws.
 */
export function describeRunningProgress(
  part: ToolPartLike
): { lines: number; bytes: number } | null {
  if (part.state !== "input-available") return null
  const text = coerceResultText((part as { output?: unknown }).output)
  if (!text) return null
  return { lines: countLines(text), bytes: text.length }
}
