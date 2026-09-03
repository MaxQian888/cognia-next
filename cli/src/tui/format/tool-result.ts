/**
 * One structured description of what a tool call *produced*, the terminal twin
 * of the GUI's `lib/chat/tool-result-summary.ts`. Both surfaces answer the same
 * question ("grep -> 12 matches", "edit -> +5 -2", "read -> 320 lines",
 * "failed -> first error line") from the same rules, so a transcript reads
 * identically in the app and in the CLI.
 *
 * Returns a descriptor rather than a string so the two TUI renderers, the Ink
 * `CellView` card and the plain-span `cellToTerminalBlock` used by the
 * virtualized viewport, can colour it themselves and never drift on the text.
 * Pure: no Ink, no I/O.
 */
import { diffStat, isDiffTool, resultPreview } from "./tools"
import { bareToolName } from "../markdown/diff"
import type { ToolCell } from "../state/types"

/** How a result chip should be tinted. */
export type ResultTone = "neutral" | "success" | "error"

/** A tool result distilled to one countable fact plus its tone. */
export type ToolResultDescriptor =
  | { kind: "diff"; added: number; removed: number; tone: "success" }
  | { kind: "matches"; count: number; tone: "neutral" }
  | { kind: "files"; count: number; tone: "neutral" }
  | { kind: "entries"; count: number; tone: "neutral" }
  | { kind: "lines"; count: number; tone: "neutral" }
  | { kind: "error"; preview: string; tone: "error" }

/** Count lines in a block of text. An empty string is zero lines, not one. */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length
}

/** Count non-blank lines, the natural "how many results" measure. */
function countNonBlankLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length
}

/**
 * Coerce a tool result to plain text: a string verbatim, an MCP content-block
 * array by joining its `text` blocks, anything else by JSON. Same coercion the
 * GUI's `coerceResultText` performs.
 */
export function coerceResultText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  if (Array.isArray(result)) {
    const texts = result
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
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
 * Describe a tool call's result, or `null` when there is nothing useful to show
 * yet (still running, cancelled, no output). Never throws.
 *
 * Ordering mirrors the GUI: a failure wins over everything, a diff tool is
 * summarized from its *input* (the proposed change) once it settles, and every
 * other completed tool falls back to a raw line count so no settled row is left
 * without a size hint.
 */
export function describeToolResult(cell: ToolCell): ToolResultDescriptor | null {
  if (cell.status === "error") {
    const preview = resultPreview(cell.result, 72)
    return preview ? { kind: "error", preview, tone: "error" } : null
  }

  // One deliberate deviation from the GUI, which waits for `output-available`
  // before counting a diff: there the tool input streams in, so an early count
  // would be wrong. A `ToolCell` is created with its complete input, so the
  // proposed +/- is known the moment the call starts and the header can show it
  // while the edit is still running.
  if (isDiffTool(cell.toolName)) {
    const { added, removed } = diffStat(cell.toolName, cell.input)
    if (added === 0 && removed === 0) return null
    return { kind: "diff", added, removed, tone: "success" }
  }
  if (cell.status !== "done") return null

  const text = coerceResultText(cell.result)
  if (!text) return null

  switch (bareToolName(cell.toolName).toLowerCase()) {
    case "grep":
    case "search":
      return { kind: "matches", count: countNonBlankLines(text), tone: "neutral" }
    case "glob":
      return { kind: "files", count: countNonBlankLines(text), tone: "neutral" }
    case "ls":
    case "list":
      return { kind: "entries", count: countNonBlankLines(text), tone: "neutral" }
    default:
      return { kind: "lines", count: countLines(text), tone: "neutral" }
  }
}

/**
 * True for a descriptor that belongs on the detail line under the header rather
 * than in the header chip. A failure's first line is worth full width, and both
 * renderers must agree on where it goes or the same call reads differently in
 * the two layouts.
 */
export function isDetailDescriptor(descriptor: ToolResultDescriptor): boolean {
  return descriptor.kind === "error"
}

/** Render a descriptor as the one-line chip text both renderers print. */
export function formatResultDescriptor(descriptor: ToolResultDescriptor): string {
  switch (descriptor.kind) {
    case "diff": {
      const parts: string[] = []
      if (descriptor.added > 0) parts.push(`+${descriptor.added}`)
      if (descriptor.removed > 0) parts.push(`-${descriptor.removed}`)
      return parts.join(" ")
    }
    case "matches":
      return `${descriptor.count} match${descriptor.count === 1 ? "" : "es"}`
    case "files":
      return `${descriptor.count} file${descriptor.count === 1 ? "" : "s"}`
    case "entries":
      return `${descriptor.count} entr${descriptor.count === 1 ? "y" : "ies"}`
    case "lines":
      return `${descriptor.count} line${descriptor.count === 1 ? "" : "s"}`
    case "error":
      return descriptor.preview
  }
}

/**
 * Live size of a still-running tool's streamed output, for the running row's
 * progress chip. Mirrors the GUI's `describeRunningProgress`: only tools whose
 * output streams while the call is in flight (Bash stdout) yield a value.
 */
export function describeRunningProgress(cell: ToolCell): { lines: number; bytes: number } | null {
  if (cell.status !== "running") return null
  const text = coerceResultText(cell.result)
  if (!text) return null
  return { lines: countLines(text), bytes: text.length }
}
