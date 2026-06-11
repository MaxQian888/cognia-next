/**
 * Pure formatter for the usage panel's "top tools" breakdown — turns the
 * session's per-tool tallies (`TuiState.toolStats`) into the busiest few rows,
 * sorted by call count, with the MCP/plugin name normalization applied. No Ink,
 * no I/O.
 */
import { toolDisplayName } from "./tools"
import type { ToolStat } from "../state/types"

export interface ToolStatRow {
  name: string
  calls: number
  errors: number
}

/**
 * The top `limit` tools by call count (ties broken by display name for
 * deterministic output). Names are normalized via {@link toolDisplayName}.
 * Empty stats or a non-positive limit → [].
 */
export function topToolStats(stats: Record<string, ToolStat>, limit = 5): ToolStatRow[] {
  if (limit <= 0) return []
  return Object.entries(stats)
    .map(([name, s]) => ({ name: toolDisplayName(name), calls: s.calls, errors: s.errors }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** A one-line label for a row: `read ×12`, or `bash ×4 (1✗)` when it errored. */
export function formatToolStatRow(row: ToolStatRow): string {
  const base = `${row.name} ×${row.calls}`
  return row.errors > 0 ? `${base} (${row.errors}✗)` : base
}
