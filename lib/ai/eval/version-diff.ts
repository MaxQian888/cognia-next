/**
 * Compare two dataset version snapshots, and restore one.
 *
 * Snapshots were write-only: the UI could list them and tag them, but not say
 * what changed between two runs' pinned versions, and not get back to an
 * earlier case set after a bad edit. "Run A scored 80% and run B scored 60%"
 * is unactionable without knowing which cases moved underneath them.
 *
 * Snapshots store case IDS (see `types/eval/version.ts`), so a diff is a set
 * comparison over ids plus a content check on the cases that appear in both.
 * Cases deleted from the dataset since a snapshot was taken are reported as
 * `missing` rather than silently dropped — a restore cannot resurrect them.
 *
 * Pure over injected loaders so it is testable without Dexie.
 */

import type { EvalCase } from "@/types/eval/eval"
import type { EvalDatasetVersion } from "@/types/eval/version"

/** The case ids a snapshot froze, tolerating the legacy full-copy shape. */
export function versionCaseIds(version: EvalDatasetVersion): string[] {
  return version.caseIds ?? version.cases?.map((c) => c.id) ?? []
}

export interface VersionDiff {
  /** In `to` but not in `from`. */
  added: string[]
  /** In `from` but not in `to`. */
  removed: string[]
  /** In both, but the case content changed since. */
  changed: string[]
  /** In both and unchanged. */
  unchanged: string[]
}

/** Stable, order-independent fingerprint of a case's gradable content. */
function caseFingerprint(evalCase: EvalCase): string {
  // Timestamps are excluded: re-saving a case without editing it is not a
  // change, and `updatedAt` moves on every write.
  const { createdAt: _c, updatedAt: _u, ...rest } = evalCase
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(obj)
          .sort()
          .map((k) => [k, sortKeys(obj[k])])
      )
    }
    return value
  }
  return JSON.stringify(sortKeys(rest))
}

/**
 * What changed between two snapshots.
 *
 * `casesById` supplies the CURRENT case rows; ids present in both snapshots
 * but absent from it cannot be compared and are reported as `unchanged`
 * (nothing is known to have moved) rather than invented as `changed`.
 */
export function diffVersions(
  from: EvalDatasetVersion,
  to: EvalDatasetVersion,
  casesById: Map<string, EvalCase> = new Map()
): VersionDiff {
  const fromIds = new Set(versionCaseIds(from))
  const toIds = new Set(versionCaseIds(to))

  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  const unchanged: string[] = []

  for (const id of toIds) if (!fromIds.has(id)) added.push(id)
  for (const id of fromIds) if (!toIds.has(id)) removed.push(id)

  // Content comparison only works where the snapshot kept full copies (legacy
  // rows). For id-only snapshots there is nothing to compare against, so the
  // shared ids are reported as unchanged.
  const fromCases = new Map((from.cases ?? []).map((c) => [c.id, c]))
  const toCases = new Map((to.cases ?? []).map((c) => [c.id, c]))
  for (const id of toIds) {
    if (!fromIds.has(id)) continue
    const before = fromCases.get(id)
    const after = toCases.get(id) ?? casesById.get(id)
    if (before && after && caseFingerprint(before) !== caseFingerprint(after)) changed.push(id)
    else unchanged.push(id)
  }

  const sort = (xs: string[]) => xs.sort()
  return {
    added: sort(added),
    removed: sort(removed),
    changed: sort(changed),
    unchanged: sort(unchanged),
  }
}

export interface RestorePlan {
  /** Cases currently in the dataset that the snapshot did not contain. */
  toDelete: string[]
  /** Snapshot cases still present; restoring is a no-op for them. */
  toKeep: string[]
  /**
   * Snapshot cases that no longer exist and cannot be brought back. Id-only
   * snapshots keep no copy, so a deleted case is gone — the UI must say so
   * rather than silently restoring a smaller set than the user asked for.
   */
  missing: string[]
}

/**
 * What restoring `version` would do to the dataset's CURRENT case set.
 *
 * Returned rather than executed so the UI can show the consequences — a
 * restore deletes cases — before anything is written.
 */
export function planRestore(version: EvalDatasetVersion, currentIds: string[]): RestorePlan {
  const snapshotIds = new Set(versionCaseIds(version))
  const current = new Set(currentIds)
  const restorable = new Set((version.cases ?? []).map((c) => c.id))

  const toDelete: string[] = []
  const toKeep: string[] = []
  const missing: string[] = []

  for (const id of current) if (!snapshotIds.has(id)) toDelete.push(id)
  for (const id of snapshotIds) {
    if (current.has(id)) toKeep.push(id)
    else if (restorable.has(id))
      toKeep.push(id) // a legacy snapshot can re-add it
    else missing.push(id)
  }

  return { toDelete: toDelete.sort(), toKeep: toKeep.sort(), missing: missing.sort() }
}
