/**
 * Headless read aggregations over `codeAdoptionTurns` — the Phase-1
 * verification/consumption surface (no UI). Pure roll-up helpers plus a few
 * Dexie-backed convenience queries.
 */

import { listRecentCodeAdoptionTurns } from "./persist"
import type { CodeAdoptionTurnRow } from "./types"

export interface AdoptionRollup {
  turns: number
  files: number
  added: number
  removed: number
}

const EMPTY: AdoptionRollup = { turns: 0, files: 0, added: 0, removed: 0 }

/** Sum a set of turn rows into a single roll-up. */
export function rollup(rows: CodeAdoptionTurnRow[]): AdoptionRollup {
  return rows.reduce<AdoptionRollup>(
    (acc, r) => ({
      turns: acc.turns + 1,
      files: acc.files + r.totalFiles,
      added: acc.added + r.totalAdded,
      removed: acc.removed + r.totalRemoved,
    }),
    { ...EMPTY }
  )
}

/** Group rows by a key, rolling each group up. */
export function groupRollup(
  rows: CodeAdoptionTurnRow[],
  key: (row: CodeAdoptionTurnRow) => string
): Record<string, AdoptionRollup> {
  const buckets: Record<string, CodeAdoptionTurnRow[]> = {}
  for (const row of rows) {
    const k = key(row)
    ;(buckets[k] ??= []).push(row)
  }
  return Object.fromEntries(Object.entries(buckets).map(([k, group]) => [k, rollup(group)]))
}

/** Roll up the most recent turns by model. */
export async function rollupByModel(limit = 500): Promise<Record<string, AdoptionRollup>> {
  const rows = await listRecentCodeAdoptionTurns(limit)
  return groupRollup(rows, (r) => r.model ?? "unknown")
}

/** Roll up the most recent turns by workspace root. */
export async function rollupByWorkspace(limit = 500): Promise<Record<string, AdoptionRollup>> {
  const rows = await listRecentCodeAdoptionTurns(limit)
  return groupRollup(rows, (r) => r.workspaceRoot)
}
