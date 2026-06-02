/**
 * Immutable dataset version snapshot (Approach A).
 *
 * On run launch the current case set is frozen here (full `cases` + an
 * order-independent content hash + an optional tag) and the run records
 * `datasetVersionId`. Run-to-run comparison stays apples-to-apples regardless
 * of later case edits/deletes. Persisted in Dexie `evalDatasetVersions` (v69);
 * CRUD + snapshotting live in `lib/db/eval-dataset-versions.ts`.
 */

import type { EvalCase } from "./eval"

export interface EvalDatasetVersion {
  id: string
  datasetId: string
  /** Monotonic dataset version number at snapshot time. */
  version: number
  /** Frozen copy of every case in the dataset at snapshot time. */
  cases: EvalCase[]
  /** Stable content hash of `cases` (order-independent) for dedup. */
  casesHash: string
  /** Optional human label, e.g. "prod" | "v1". */
  tag?: string
  createdAt: number
}
