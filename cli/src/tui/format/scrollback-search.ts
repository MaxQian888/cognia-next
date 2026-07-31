/**
 * Pure substring matcher over committed transcript cells — the search core for
 * the scrollback "find" overlay (Task 2.3). Given the cell history and a query,
 * it renders each {@link Cell} to plain searchable text and returns one
 * {@link SearchHit} per matching line, in cell order.
 *
 * No Ink, no I/O: each cell kind is flattened to text via {@link cellToText},
 * which mirrors what {@link CellView} renders (reusing {@link summarizeToolCall}
 * and {@link toolDisplayName} for tool cards) so a hit's excerpt reads like the
 * line the user actually sees. The overlay/App wiring lives elsewhere.
 */
import type { Cell, ToolCell } from "../state/types"
import { summarizeToolCall, toolDisplayName } from "./tools"

/** A single matching line within a committed cell. */
export interface SearchHit {
  /** The {@link Cell.id} the match was found in. */
  cellId: string
  /** The cell's discriminant (`kind`) — lets the overlay label the hit. */
  kind: string
  /** The matching line, trimmed with ellipses when long (see {@link EXCERPT_MAX}). */
  excerpt: string
  /** Zero-based index of the matching line within the cell's rendered text. */
  lineIndex: number
}

/** Max excerpt width before the matched line is trimmed around the hit. */
const EXCERPT_MAX = 120
/** Leading context kept before the match when an excerpt is trimmed. */
const EXCERPT_LEAD = 30

/** Render a tool result (string passthrough, else pretty JSON) to text. */
function resultText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/** Flatten a tool cell to a searchable header line plus its result body. */
function toolToText(cell: ToolCell): string {
  const summary = summarizeToolCall(cell.toolName, cell.input)
  const header = summary
    ? `${toolDisplayName(cell.toolName)} ${summary}`
    : toolDisplayName(cell.toolName)
  const body = resultText(cell.result)
  return body ? `${header}\n${body}` : header
}

/**
 * Render a cell to plain text for searching — the union is exhaustively
 * matched on the `kind` discriminant so every cell kind contributes its
 * user-visible content (and only that).
 */
export function cellToText(cell: Cell): string {
  switch (cell.kind) {
    case "user":
      return cell.text
    case "assistant":
      return cell.raw
    case "thinking":
      return cell.text
    case "tool":
      return toolToText(cell)
    case "todo":
      return cell.todos.map((t) => t.content).join("\n")
    case "error":
      return cell.message
    case "notice":
      return cell.message
    case "bash":
      return cell.output ? `${cell.command}\n${cell.output}` : cell.command
    case "plan":
      return cell.raw
    default:
      return ""
  }
}

/**
 * Build an excerpt for a matched line: when the line fits within
 * {@link EXCERPT_MAX} it is returned verbatim; otherwise it is trimmed to a
 * window around the (case-insensitive) match, with ellipses marking elision.
 */
function makeExcerpt(line: string, lowerQuery: string): string {
  if (line.length <= EXCERPT_MAX) return line
  const hit = line.toLowerCase().indexOf(lowerQuery)
  // Keep a little lead context before the match, then a window of EXCERPT_MAX.
  const start = Math.max(0, hit - EXCERPT_LEAD)
  const end = Math.min(line.length, start + EXCERPT_MAX)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < line.length ? "…" : ""
  return `${prefix}${line.slice(start, end)}${suffix}`
}

/**
 * Search committed cells for `query` (case-insensitive substring) and return one
 * hit per matching line, in cell order. An empty or whitespace-only query yields
 * no hits.
 *
 * @param cells The committed transcript history.
 * @param query The substring to find.
 */
export function searchCells(cells: Cell[], query: string): SearchHit[] {
  const trimmed = query.trim()
  if (trimmed === "") return []
  const lowerQuery = trimmed.toLowerCase()

  const hits: SearchHit[] = []
  for (const cell of cells) {
    const lines = cellToText(cell).split("\n")
    lines.forEach((line, lineIndex) => {
      if (line.toLowerCase().includes(lowerQuery)) {
        hits.push({
          cellId: cell.id,
          kind: cell.kind,
          excerpt: makeExcerpt(line, lowerQuery),
          lineIndex,
        })
      }
    })
  }
  return hits
}
