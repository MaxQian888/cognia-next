/**
 * Pure builder for the `/inspect` overlay: turn the committed transcript cells
 * into a newest-first list of inspectable units (tool/bash/subagent cells that
 * produced output). The overlay lets the user jump straight to any past output's
 * full, syntax-highlighted view — the keyboard equivalent of "click to expand"
 * the screenshot asks for, since Ink can't capture clicks on scrollback.
 *
 * Reuses {@link summarizeToolCall} / {@link summarizeResult} / {@link resultPreview}
 * so the row labels match the transcript's own tool-card summaries. No Ink, no
 * I/O — unit-tested without rendering.
 */
import { summarizeResult, summarizeToolCall, toolGlyph, toolHeaderLabel } from "../format/tools"
import { isSubagentTool, subagentName } from "../format/subagent"
import type { Cell, InspectItem } from "../state/types"

/**
 * Collect inspectable cells (newest first). A tool/subagent cell qualifies once
 * it has a `result`; a bash shell-out qualifies once it has captured `output`.
 * Cells still running with no output yet are skipped.
 */
export function collectInspectables(cells: Cell[]): InspectItem[] {
  const out: InspectItem[] = []
  for (const cell of cells) {
    if (cell.kind === "tool") {
      if (cell.result == null) continue
      const sub = isSubagentTool(cell.toolName)
      const label = sub
        ? `◆ ${subagentName(cell.input)}`
        : `${cell.isError ? "✗" : "✓"} ${toolGlyph(cell.toolName)} ${toolHeaderLabel(cell.toolName)}`
      out.push({
        cellId: cell.id,
        label,
        summary: sub ? "subagent" : summarizeToolCall(cell.toolName, cell.input),
        lines: summarizeResult(cell.result).lines,
        isError: cell.isError === true,
      })
    } else if (cell.kind === "bash") {
      if (!cell.output) continue
      out.push({
        cellId: cell.id,
        label: `! ${cell.command}`,
        summary: "shell",
        lines: summarizeResult(cell.output).lines,
        isError: cell.status === "error",
      })
    }
  }
  return out.reverse()
}
