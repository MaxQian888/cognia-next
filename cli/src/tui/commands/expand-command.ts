/**
 * `/expand [n]` — open a tool cell's FULL result in the document pager.
 *
 * The transcript renders tool output truncated (the Ink `<Static>` region can't
 * grow a committed cell in place), but the cell keeps the whole `result`. This
 * pure command surfaces it: no arg → the newest tool cell; `<n>` → the n-th
 * (1-based, newest = count). Pure handler over `ctx.state.cells`, so it needs no
 * App / reducer changes.
 */
import { resultToText, toolResultLang } from "../format/result-render"
import type { ToolCell } from "../state/types"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function markdownFence(text: string, language: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(Math.max(3, longestRun + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

function singleLine(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined
}

function formatBashResultBody(cell: ToolCell, header: string): string | null {
  const command = typeof cell.input.command === "string" ? cell.input.command : undefined
  if (!command) return null

  const mode = cell.input.run_in_background
    ? cell.input.detach
      ? "background (detached)"
      : "background"
    : "foreground"
  const metadata = [`Status: ${cell.isError ? "error" : cell.status}`, `Mode: ${mode}`]
  const workdir = singleLine(cell.input.workdir)
  const description = singleLine(cell.input.description)
  if (workdir) metadata.push(`Workdir: ${workdir}`)
  if (typeof cell.input.timeout === "number") metadata.push(`Timeout: ${cell.input.timeout} ms`)
  if (description) metadata.push(`Description: ${description}`)

  const output = cell.result == null ? "(no result)" : resultToText(cell.result)
  return [
    header,
    "## Invocation",
    metadata.map((line) => `- ${line}`).join("\n"),
    "### Command",
    markdownFence(command, "bash"),
    "## Output",
    markdownFence(output, "text"),
  ].join("\n\n")
}

/**
 * Render a tool cell's result for the pager as a markdown document. File/code
 * and shell results are wrapped in a fenced block tagged with the detected
 * language so {@link DocumentViewer} syntax-highlights them; objects fall back to
 * a JSON fence; plain text with no detectable language is rendered verbatim.
 */
export function formatToolResultBody(cell: ToolCell): string {
  const header = `# ${cell.toolName}${cell.isError ? " (error)" : ""}`
  if (cell.toolName.toLowerCase() === "bash") {
    const detailed = formatBashResultBody(cell, header)
    if (detailed) return detailed
  }
  const r = cell.result
  if (r == null) return `${header}\n\n(no result)`
  if (typeof r !== "string") {
    return `${header}\n\n\`\`\`json\n${resultToText(r)}\n\`\`\``
  }
  const lang = toolResultLang(cell.toolName, cell.input)
  if (lang) return `${header}\n\n${markdownFence(r, lang)}`
  return `${header}\n\n${r}`
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
