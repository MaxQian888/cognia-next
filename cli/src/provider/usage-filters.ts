// Filters and source diagnostics for `cognia-agent provider usage` (ADR-0165).
//
// Pure, so both the human table and the `--json` payload are built from one
// place and cannot disagree about what a filter meant.
//
// The source vocabulary is DERIVED from the session-source registry rather
// than hand-listed here. A hand-listed copy is how a newly supported agent
// ends up unreachable from the CLI while the app happily indexes it, and the
// list is exactly the thing that changes most often.

import type { ProviderUsageRow } from "./usage"

/** Whose spend a run counts. Mirrors `UsageGlanceScope`. */
export type UsageCliScope = "cognia" | "all-tools"

export const USAGE_CLI_SCOPES: readonly UsageCliScope[] = ["cognia", "all-tools"]

export interface UsageFilters {
  scope: UsageCliScope
  /** External source id to restrict to (all-tools scope only). */
  sourceId?: string
  /** Substring match on the model id, case-insensitive. */
  model?: string
  providerId?: string
}

/**
 * Session-id prefixes the external index writes.
 *
 * `ext:` is what `lib/session-import/usage-scan.ts` namespaces rows with.
 * `import:` predates it and is what the one-off importer produced. Both mean
 * "another agent paid for this", so both are external for filtering.
 */
const EXTERNAL_PREFIXES = ["ext:", "import:"] as const

/** Source id encoded in a namespaced session id, or null when it is local. */
export function sourceOfSessionId(sessionId: string): string | null {
  for (const prefix of EXTERNAL_PREFIXES) {
    if (!sessionId.startsWith(prefix)) continue
    const rest = sessionId.slice(prefix.length)
    const cut = rest.indexOf(":")
    const id = cut === -1 ? rest : rest.slice(0, cut)
    return id.length > 0 ? id : null
  }
  return null
}

export function isExternalSessionId(sessionId: string): boolean {
  return sourceOfSessionId(sessionId) !== null
}

/** A row as the filters see it: the usage row plus the session it came from. */
export interface FilterableRow extends ProviderUsageRow {
  sessionId?: string
}

/**
 * Whether a row survives the filters.
 *
 * The scope check is first and is the one that matters: `cognia` must exclude
 * every external row, because that total is the one a budget is compared
 * against and blending another tool's bill into it would misfire the gate.
 */
export function rowMatches(row: FilterableRow, filters: UsageFilters): boolean {
  const external = row.sessionId ? isExternalSessionId(row.sessionId) : false
  if (filters.scope === "cognia" && external) return false
  if (filters.sourceId) {
    if (!row.sessionId) return false
    if (sourceOfSessionId(row.sessionId) !== filters.sourceId) return false
  }
  if (filters.providerId && row.providerId !== filters.providerId) return false
  if (filters.model && !row.model.toLowerCase().includes(filters.model.toLowerCase())) {
    return false
  }
  return true
}

export function applyFilters<T extends FilterableRow>(
  rows: readonly T[],
  filters: UsageFilters
): T[] {
  return rows.filter((row) => rowMatches(row, filters))
}

/** Parse and validate a `--scope` value. */
export function parseScope(raw: string | undefined): UsageCliScope | null {
  if (raw === undefined) return "cognia"
  return (USAGE_CLI_SCOPES as readonly string[]).includes(raw) ? (raw as UsageCliScope) : null
}

/** One external source's state, as the CLI reports it. */
export interface SourceDiagnostic {
  sourceId: string
  displayName: string
  /** Mirrors `UsageSourceStatus`. */
  status: string
  supportsScan: boolean
  rowCount: number
  failedCount: number
  lastScanAt: number
}

/**
 * One human line per source.
 *
 * A source that was never scanned and a source that could not be READ produce
 * different lines on purpose. Collapsing them is the confusion the whole
 * `usageSourceStates` table exists to prevent.
 */
export function formatSourceDiagnostic(d: SourceDiagnostic): string {
  if (!d.supportsScan) return `  ${d.displayName}: picker only, no machine-wide history`
  if (d.status === "unknown") return `  ${d.displayName}: not scanned yet`
  if (d.status === "unavailable") return `  ${d.displayName}: unreadable (root missing or moved)`
  const failed = d.failedCount > 0 ? `, ${d.failedCount} unreadable` : ""
  const suffix = d.status === "partial" ? " (partial)" : ""
  return `  ${d.displayName}: ${d.rowCount} rows${failed}${suffix}`
}
