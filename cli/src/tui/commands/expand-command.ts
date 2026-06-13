/**
 * `/expand [n]` — open a tool cell's FULL result in the document pager.
 *
 * The transcript renders tool output truncated (the Ink `<Static>` region can't
 * grow a committed cell in place), but the cell keeps the whole `result`. This
 * pure command surfaces it: no arg → the newest tool cell; `<n>` → the n-th
 * (1-based, newest = count). Pure handler over `ctx.state.cells`, so it needs no
 * App / reducer changes.
 */
import type { ToolCell } from "../state/types"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** Render a tool cell's result for the pager (string verbatim, else JSON). */
export function formatToolResultBody(cell: ToolCell): string {
  const r = cell.result
  const text =
    typeof r === "string"
      ? r
      : r == null
        ? "(no result)"
        : "```json\n" + JSON.stringify(r, null, 2) + "\n```"
  const header = `# ${cell.toolName}${cell.isError ? " (error)" : ""}`
  return `${header}\n\n${text}`
}

export function expandHandler(ctx: CommandContext): CommandEffect {
  const tools = ctx.state.cells.filter((c): c is ToolCell => c.kind === "tool")
  if (tools.length === 0) {
    return { kind: "notice", message: "No tool output to expand yet." }
  }
  const arg = ctx.args.trim()
  let cell: ToolCell
  if (arg) {
    const n = Number(arg)
    if (!Number.isInteger(n) || n < 1 || n > tools.length) {
      return {
        kind: "notice",
        message: `Usage: /expand [1-${tools.length}] (newest = ${tools.length})`,
      }
    }
    cell = tools[n - 1]
  } else {
    cell = tools[tools.length - 1]
  }
  return {
    kind: "openOverlay",
    overlay: {
      kind: "document",
      title: `${cell.toolName} output`,
      body: formatToolResultBody(cell),
      format: "markdown",
    },
  }
}

export const EXPAND_COMMANDS: CommandDescriptor[] = [
  {
    name: "expand",
    description: "open a tool result's full output in the pager",
    category: "system",
    argumentHint: "[n]",
    handler: expandHandler,
  },
]
