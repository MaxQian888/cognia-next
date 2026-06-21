/**
 * Fold runs of completed context-gathering tool calls (read / grep / glob / ls)
 * into a single summary row — the "N reads, M searches" collapse OpenCode uses to
 * keep noisy context-gathering from burying the actual work. Pure; the Ink view
 * consumes the runs.
 *
 * Only *completed, non-error* context tools fold: a running tool keeps its own
 * card so live progress stays visible, and an errored one stays visible so the
 * failure isn't hidden. Verbose mode disables folding entirely. A lone context
 * tool (run length 1) is left as its own row — folding earns its keep only for a
 * burst.
 */
import type { Cell, ToolCell } from "../state/types"

/** Context-gathering tools whose bursts are worth folding. */
const CONTEXT_TOOLS = new Set(["read", "cat", "view", "grep", "search", "glob", "ls", "list"])

export function isContextTool(toolName: string): boolean {
  return CONTEXT_TOOLS.has(toolName.toLowerCase())
}

export type ContextRun = { kind: "single"; cell: Cell } | { kind: "group"; tools: ToolCell[] }

/** Group adjacent completed context tools; everything else passes through as a
 * single row. Order is preserved. */
export function groupContextRuns(cells: Cell[], verbose: boolean): ContextRun[] {
  if (verbose) return cells.map((cell) => ({ kind: "single", cell }))
  const out: ContextRun[] = []
  let run: ToolCell[] = []
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "group", tools: run })
    else for (const t of run) out.push({ kind: "single", cell: t })
    run = []
  }
  for (const cell of cells) {
    const groupable =
      cell.kind === "tool" &&
      isContextTool(cell.toolName) &&
      cell.status === "done" &&
      !cell.isError
    if (groupable) {
      run.push(cell as ToolCell)
    } else {
      flush()
      out.push({ kind: "single", cell })
    }
  }
  flush()
  return out
}

/** Coarse category for the group summary. */
function category(toolName: string): "read" | "search" | "glob" | "list" {
  const n = toolName.toLowerCase()
  if (n === "read" || n === "cat" || n === "view") return "read"
  if (n === "grep" || n === "search") return "search"
  if (n === "glob") return "glob"
  return "list"
}

const CATEGORY_LABELS: Array<[ReturnType<typeof category>, string, string]> = [
  ["read", "read", "reads"],
  ["search", "search", "searches"],
  ["glob", "glob", "globs"],
  ["list", "list", "lists"],
]

/** A one-line summary of a folded run, e.g. "3 reads, 2 searches". */
export function summarizeContextGroup(tools: ToolCell[]): string {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const c = category(t.toolName)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const [key, singular, plural] of CATEGORY_LABELS) {
    const n = counts.get(key)
    if (n) parts.push(`${n} ${n === 1 ? singular : plural}`)
  }
  return parts.join(", ")
}
