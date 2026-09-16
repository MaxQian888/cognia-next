/**
 * Cross-database effects of the fusion ledger (ADR-0188 D39).
 *
 * The fusion database cannot share a transaction with the account database, so
 * anything the ledger must also make visible there — a usage row, a milestone
 * on the execution run — is written into `fusionOutbox` INSIDE the ledger
 * transaction that caused it, and applied afterwards. Every effect id is
 * derived from what it is about, and every applier is idempotent, so replaying
 * the outbox after a crash in any window yields each effect exactly once.
 *
 * A failing effect stays pending with its error recorded; it is retried on the
 * next drain (boot, run end, recovery) and never dropped.
 */

import type { FusionDB } from "./fusion-db"
import type { FusionOutboxKind, FusionOutboxRow } from "./types"

export type OutboxApplyResult = "applied" | "skipped"

/**
 * What an applier may read besides its row. Outbox rows carry ids only; an
 * effect that writes content (a session message) reads it back from the run's
 * encrypted artifacts through the store that queued it.
 */
export interface OutboxContext {
  readArtifact: (artifactId: string) => Promise<string | null>
}

export type OutboxApplier = (
  row: FusionOutboxRow,
  context: OutboxContext
) => Promise<OutboxApplyResult>
export type OutboxAppliers = Record<FusionOutboxKind, OutboxApplier>

/** A drain that was given no store cannot read content; an effect that needs it stays pending. */
const NO_ARTIFACTS: OutboxContext = {
  readArtifact: async () => {
    throw new Error("this outbox drain has no artifact reader; the effect waits for one that has")
  },
}

export interface DrainResult {
  applied: number
  skipped: number
  failed: number
}

const draining = new WeakMap<FusionDB, Promise<DrainResult>>()

export interface DrainOptions {
  limit?: number
  now?: () => number
  readArtifact?: OutboxContext["readArtifact"]
}

export function drainFusionOutbox(
  db: FusionDB,
  appliers: OutboxAppliers,
  options: DrainOptions = {}
): Promise<DrainResult> {
  // One drain per database at a time: a second caller joins the running one
  // instead of applying the same effects concurrently.
  const inFlight = draining.get(db)
  if (inFlight) return inFlight
  const run = drainOnce(db, appliers, options).finally(() => draining.delete(db))
  draining.set(db, run)
  return run
}

async function drainOnce(
  db: FusionDB,
  appliers: OutboxAppliers,
  options: DrainOptions
): Promise<DrainResult> {
  const now = options.now ?? (() => Date.now())
  const context: OutboxContext = options.readArtifact
    ? { readArtifact: options.readArtifact }
    : NO_ARTIFACTS
  const pending = await db.fusionOutbox.where("status").equals("pending").sortBy("createdAt")
  const batch = pending.slice(0, options.limit ?? 500)
  const result: DrainResult = { applied: 0, skipped: 0, failed: 0 }
  for (const row of batch) {
    const applier = appliers[row.kind]
    try {
      if (!applier) throw new Error(`No outbox applier for ${row.kind}`)
      const outcome = await applier(row, context)
      await db.fusionOutbox.update(row.effectId, {
        status: outcome,
        attempts: row.attempts + 1,
        lastError: null,
        appliedAt: now(),
      })
      result[outcome] += 1
    } catch (error) {
      result.failed += 1
      await db.fusionOutbox.update(row.effectId, {
        attempts: row.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}
