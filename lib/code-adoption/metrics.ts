/**
 * Read aggregations over `codeAdoptionTurns`. Pure roll-up helpers plus a few
 * Dexie-backed convenience queries.
 */

import { listCodeAdoptionTurnsInRange, listRecentCodeAdoptionTurns } from "./persist"
import type { CodeAdoptionTurnRow } from "./types"

export interface AdoptionRollup {
  turns: number
  files: number
  added: number
  removed: number
  decidedTurns: number
  proposedFiles: number
  acceptedFiles: number
  proposedLines: number
  acceptedLines: number
  lineAdoptionRate: number | null
  fileAdoptionRate: number | null
  pendingTurns: number
  revertedTurns: number
  unavailableTurns: number
  truncatedTurns: number
  legacyTurns: number
}

const EMPTY: AdoptionRollup = {
  turns: 0,
  files: 0,
  added: 0,
  removed: 0,
  decidedTurns: 0,
  proposedFiles: 0,
  acceptedFiles: 0,
  proposedLines: 0,
  acceptedLines: 0,
  lineAdoptionRate: null,
  fileAdoptionRate: null,
  pendingTurns: 0,
  revertedTurns: 0,
  unavailableTurns: 0,
  truncatedTurns: 0,
  legacyTurns: 0,
}

const FINAL_STATES = new Set(["accepted", "partiallyAccepted", "rejected", "reverted"])

/** Sum a set of turn rows into a single roll-up. */
export function rollup(rows: CodeAdoptionTurnRow[]): AdoptionRollup {
  const result = rows.reduce<AdoptionRollup>(
    (acc, row) => {
      acc.turns += 1
      acc.files += row.totalFiles
      acc.added += row.totalAdded
      acc.removed += row.totalRemoved
      if (row.measurement === "legacyFingerprint" || row.measurement === undefined) {
        acc.legacyTurns += 1
      }
      if (row.adoptionState === "pending") acc.pendingTurns += 1
      if (row.adoptionState === "reverted") acc.revertedTurns += 1
      if (row.trackingState === "unavailable" || row.adoptionState === "unavailable") {
        acc.unavailableTurns += 1
      }
      if (row.truncated || row.trackingState === "truncated") acc.truncatedTurns += 1

      if (
        row.measurement === "taskWorkspace" &&
        row.trackingState !== "unavailable" &&
        FINAL_STATES.has(row.adoptionState ?? "")
      ) {
        acc.decidedTurns += 1
        acc.proposedFiles += row.proposedFiles ?? row.totalFiles
        acc.acceptedFiles += row.acceptedFiles ?? 0
        acc.proposedLines +=
          (row.proposedAdded ?? row.totalAdded) + (row.proposedRemoved ?? row.totalRemoved)
        acc.acceptedLines += (row.acceptedAdded ?? 0) + (row.acceptedRemoved ?? 0)
      }
      return acc
    },
    { ...EMPTY }
  )
  result.lineAdoptionRate =
    result.proposedLines === 0 ? null : result.acceptedLines / result.proposedLines
  result.fileAdoptionRate =
    result.proposedFiles === 0 ? null : result.acceptedFiles / result.proposedFiles
  return result
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
export async function rollupByModel(limit = 10_000): Promise<Record<string, AdoptionRollup>> {
  const rows = await listRecentCodeAdoptionTurns(limit)
  return groupRollup(rows, (r) => r.model ?? "unknown")
}

/** Roll up the most recent turns by workspace root. */
export async function rollupByWorkspace(limit = 10_000): Promise<Record<string, AdoptionRollup>> {
  const rows = await listRecentCodeAdoptionTurns(limit)
  return groupRollup(rows, (r) => r.workspaceRoot)
}

/** Roll up the most recent turns by chat session. */
export async function rollupBySession(limit = 10_000): Promise<Record<string, AdoptionRollup>> {
  const rows = await listRecentCodeAdoptionTurns(limit)
  return groupRollup(rows, (r) => r.sessionId)
}

/** Roll up an explicit inclusive time window without silently sampling recent rows. */
export async function rollupInTimeRange(from: number, to: number): Promise<AdoptionRollup> {
  return rollup(await listCodeAdoptionTurnsInRange(from, to))
}

function extension(path: string): string {
  const base = path.split("/").pop() ?? path
  const dot = base.lastIndexOf(".")
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "unknown"
}

/** Adoption by file type, derived from metric-only file rows (never patch bodies). */
export async function rollupByFileExtension(
  limit = 10_000
): Promise<Record<string, AdoptionRollup>> {
  const rows = await listRecentCodeAdoptionTurns(limit)
  const buckets: Record<string, CodeAdoptionTurnRow[]> = {}
  for (const row of rows) {
    for (const file of row.files) {
      const item: CodeAdoptionTurnRow = {
        ...row,
        totalFiles: 1,
        totalAdded: file.added,
        totalRemoved: file.removed,
        files: [file],
        proposedFiles: 1,
        proposedAdded: file.added,
        proposedRemoved: file.removed,
        acceptedFiles:
          file.adoptionState === "accepted" || file.adoptionState === "partiallyAccepted" ? 1 : 0,
        acceptedAdded: file.acceptedAdded ?? 0,
        acceptedRemoved: file.acceptedRemoved ?? 0,
        adoptionState: file.adoptionState ?? row.adoptionState,
      }
      ;(buckets[extension(file.path)] ??= []).push(item)
    }
  }
  return Object.fromEntries(Object.entries(buckets).map(([key, group]) => [key, rollup(group)]))
}
