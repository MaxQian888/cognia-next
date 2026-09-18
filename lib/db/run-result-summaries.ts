// Dexie access for immutable run-result summaries (v227).
//
// Each row is ONE content-addressed revision of a run's derived result —
// the deterministic builder (`lib/notifications/result/builder`) produces
// the content, this layer allocates the monotonic `revision` and stores it
// under the unique `[runId+revision]` key. Re-derivation never mutates a
// committed row: a materially different result mints the NEXT revision,
// which is what lets a post-terminal summary refine the notification without
// re-opening the run.

import { nanoid } from "nanoid"
import { getDb, type CogniaDB } from "./schema"
import type { RunResultSummary } from "@/types/notifications/result"

export type { RunResultSummary }

/**
 * Allocate + persist the next revision for `runId`, inside the caller's
 * transaction when one is supplied (the journal-commit path) or its own.
 * `content` is everything except `id`/`revision`/`createdAt` — the unique
 * `[runId+revision]` index makes a double-allocation a constraint violation.
 *
 * Returns the committed row with its allocated revision.
 */
export async function appendRunResultSummary(
  content: Omit<RunResultSummary, "id" | "revision" | "createdAt">,
  txDb?: CogniaDB
): Promise<RunResultSummary> {
  const db = txDb ?? getDb()
  const now = Date.now()
  const run = async (): Promise<RunResultSummary> => {
    // Next revision = current max + 1. Reading inside the transaction keeps
    // two concurrent derivations from picking the same number; the unique
    // index is the final backstop.
    const existing = await db.runResultSummaries.where("runId").equals(content.runId).toArray()
    const nextRevision = existing.reduce((max, r) => Math.max(max, r.revision), 0) + 1
    const row: RunResultSummary = {
      ...content,
      id: nanoid(),
      revision: nextRevision,
      createdAt: now,
    }
    await db.runResultSummaries.put(row)
    return row
  }
  if (txDb) return run()
  return db.transaction("rw", db.runResultSummaries, run)
}

/** Latest revision for a run — the summary the projector renders from. */
export async function getLatestRunResultSummary(
  runId: string
): Promise<RunResultSummary | undefined> {
  const rows = await getDb().runResultSummaries.where("runId").equals(runId).toArray()
  if (rows.length === 0) return undefined
  return rows.reduce((a, b) => (b.revision > a.revision ? b : a))
}

/** A specific revision — replay / audit reads. */
export async function getRunResultSummary(
  runId: string,
  revision: number
): Promise<RunResultSummary | undefined> {
  return getDb().runResultSummaries.where("[runId+revision]").equals([runId, revision]).first()
}

/** All revisions for a run, oldest-first — the immutable history. */
export async function listRunResultSummaries(runId: string): Promise<RunResultSummary[]> {
  const rows = await getDb().runResultSummaries.where("runId").equals(runId).toArray()
  return rows.sort((a, b) => a.revision - b.revision)
}
