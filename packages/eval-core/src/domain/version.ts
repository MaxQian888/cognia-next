/**
 * Immutable dataset version snapshot (Approach A).
 *
 * On run launch the current case set is frozen here — the case IDS plus an
 * order-independent content hash — and the run records `datasetVersionId`, so
 * run-to-run comparison stays apples-to-apples regardless of later edits.
 * Persisted in Dexie `evalDatasetVersions` (v69); CRUD + snapshotting live in
 * `lib/db/eval-dataset-versions.ts`.
 *
 * It used to store a full frozen COPY of every case. Every case edit bumps the
 * dataset version, and the next run snapshots it, so a thousand-case benchmark
 * wrote roughly half a megabyte into IndexedDB per edit-then-run cycle — for
 * data that is already in `evalCases`. The hash is what makes a snapshot
 * identity-bearing; the ids are what make it reproducible.
 */

import type { EvalCase } from "./eval"

export interface EvalDatasetVersion {
  id: string
  datasetId: string
  /** Monotonic dataset version number at snapshot time. */
  version: number
  /** The case ids frozen into this snapshot, in dataset order. */
  caseIds: string[]
  /**
   * Full frozen copies, on snapshots written before this was slimmed down.
   * Present only on legacy rows; readers should prefer {@link caseIds} and
   * fall back to `cases.length` for the count.
   */
  cases?: EvalCase[]
  /** Stable content hash of the case CONTENT (order-independent) for dedup. */
  casesHash: string
  /** Optional human label, e.g. "prod" | "v1". */
  tag?: string
  createdAt: number
}

/** How many cases a snapshot froze, tolerating the legacy full-copy shape. */
export function snapshotCaseCount(version: EvalDatasetVersion): number {
  return version.caseIds?.length ?? version.cases?.length ?? 0
}
