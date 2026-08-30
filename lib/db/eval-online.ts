/**
 * Accessors for the online-evaluation tables (Dexie v211).
 *
 * The budget functions mirror `DexieEvalOrchestratorRepository.reserveTask`:
 * spend is RESERVED inside an `rw` transaction before dispatch and settled
 * after. Checking spend after the call is how a cap gets exceeded by exactly
 * one request, every time.
 */

import { getDb } from "./schema"
import {
  budgetDayKey,
  budgetRowId,
  queueDedupeKey,
  type EvalObservationRow,
  type EvalOnlineBudgetRow,
  type EvalOnlinePolicyRow,
  type EvalOnlineQueueRow,
  type EvalOnlineQueueState,
} from "./eval-online-types"
import { validateOnlineEvalPolicy, type JudgeSamplingDecision } from "@cognia/eval-core"

// ── Policies ────────────────────────────────────────────────────────────────

export async function listOnlinePolicies(workspaceId?: string): Promise<EvalOnlinePolicyRow[]> {
  const table = getDb().evalOnlinePolicies
  return workspaceId ? table.where("workspaceId").equals(workspaceId).toArray() : table.toArray()
}

/** Enabled policies only — the read the trace path makes on every root span. */
export async function listEnabledOnlinePolicies(
  workspaceId: string
): Promise<EvalOnlinePolicyRow[]> {
  return getDb()
    .evalOnlinePolicies.where("[workspaceId+enabledFlag]")
    .equals([workspaceId, 1])
    .toArray()
}

/**
 * Thrown instead of writing a policy that cannot be honoured. The budget rule
 * in particular is not advisory: an LLM judge with no daily cap, pointed at a
 * production trace stream, is an unbounded bill.
 */
export class InvalidOnlineEvalPolicyError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`Invalid online evaluation policy: ${problems.join("; ")}`)
    this.name = "InvalidOnlineEvalPolicyError"
    this.problems = problems
  }
}

/**
 * Validation lives HERE, on the only write path, rather than in the caller.
 * A rule enforced by whoever remembers to call the validator is a rule that
 * holds until the second caller.
 */
export async function putOnlinePolicy(policy: EvalOnlinePolicyRow): Promise<void> {
  const problems = validateOnlineEvalPolicy(policy)
  if (problems.length > 0) throw new InvalidOnlineEvalPolicyError(problems)
  await getDb().evalOnlinePolicies.put({ ...policy, enabledFlag: policy.enabled ? 1 : 0 })
}

export async function deleteOnlinePolicy(id: string): Promise<void> {
  await getDb().evalOnlinePolicies.delete(id)
}

// ── Queue ───────────────────────────────────────────────────────────────────

export interface EnqueueOnlineEvalInput {
  id: string
  policyId: string
  policyVersionId: string
  traceId: string
  now: number
}

/**
 * Returns the row, whether it was just created or already existed.
 *
 * `dedupeKey` is a unique index, so a trace offered twice — a retry, a second
 * transport, a restarted session replaying its buffer — resolves to the SAME
 * work item instead of a second charge against the budget.
 */
export async function enqueueOnlineEval(
  input: EnqueueOnlineEvalInput
): Promise<{ row: EvalOnlineQueueRow; created: boolean }> {
  const db = getDb()
  const dedupeKey = queueDedupeKey(input.policyVersionId, input.traceId)
  return db.transaction("rw", db.evalOnlineQueue, async () => {
    const existing = await db.evalOnlineQueue.where("dedupeKey").equals(dedupeKey).first()
    if (existing) return { row: existing, created: false }
    const row: EvalOnlineQueueRow = {
      id: input.id,
      policyId: input.policyId,
      policyVersionId: input.policyVersionId,
      traceId: input.traceId,
      dedupeKey,
      state: "queued",
      reservedUsd: 0,
      attempts: 0,
      enqueuedAt: input.now,
      updatedAt: input.now,
    }
    await db.evalOnlineQueue.add(row)
    return { row, created: true }
  })
}

export async function claimQueuedOnlineEvals(limit: number): Promise<EvalOnlineQueueRow[]> {
  const db = getDb()
  return db.transaction("rw", db.evalOnlineQueue, async () => {
    const rows = await db.evalOnlineQueue
      .where("[state+enqueuedAt]")
      .between(["queued", 0], ["queued", Infinity])
      .limit(limit)
      .toArray()
    const now = Date.now()
    const claimed = rows.map((row) => ({
      ...row,
      state: "running" as const,
      attempts: row.attempts + 1,
      updatedAt: now,
    }))
    await db.evalOnlineQueue.bulkPut(claimed)
    return claimed
  })
}

export async function setOnlineEvalState(
  id: string,
  state: EvalOnlineQueueState,
  patch: Partial<Pick<EvalOnlineQueueRow, "error" | "skipReason" | "attempts">> = {},
  now = Date.now()
): Promise<void> {
  await getDb().evalOnlineQueue.update(id, { state, ...patch, updatedAt: now })
}

/**
 * A trace the budget refused. Recorded as a terminal `skipped` row carrying the
 * reason — never dropped, and never left `queued` to be retried forever. A
 * policy that has gone quiet must be able to say which control silenced it.
 */
export async function skipOnlineEval(
  id: string,
  reason: JudgeSamplingDecision,
  now = Date.now()
): Promise<void> {
  await setOnlineEvalState(id, "skipped", { skipReason: reason }, now)
}

// ── Budget ledger ───────────────────────────────────────────────────────────

export async function readBudget(policyId: string, now = Date.now()): Promise<EvalOnlineBudgetRow> {
  const day = budgetDayKey(now)
  const existing = await getDb().evalOnlineBudget.get(budgetRowId(policyId, day))
  return (
    existing ?? {
      id: budgetRowId(policyId, day),
      policyId,
      day,
      spentUsd: 0,
      reservedUsd: 0,
      judgedCount: 0,
      updatedAt: now,
    }
  )
}

/**
 * Reserve worst-case spend before dispatch. Returns false when the reservation
 * would breach the cap — the caller then records a `skipped-budget` result
 * rather than making the call and apologising afterwards.
 */
export async function reserveOnlineEvalBudget(
  policyId: string,
  amountUsd: number,
  dailyCapUsd: number,
  now = Date.now()
): Promise<boolean> {
  const db = getDb()
  const day = budgetDayKey(now)
  const id = budgetRowId(policyId, day)
  return db.transaction("rw", db.evalOnlineBudget, async () => {
    const row = (await db.evalOnlineBudget.get(id)) ?? {
      id,
      policyId,
      day,
      spentUsd: 0,
      reservedUsd: 0,
      judgedCount: 0,
      updatedAt: now,
    }
    if (row.spentUsd + row.reservedUsd + amountUsd > dailyCapUsd) return false
    await db.evalOnlineBudget.put({
      ...row,
      reservedUsd: row.reservedUsd + amountUsd,
      updatedAt: now,
    })
    return true
  })
}

/**
 * Settle a reservation: release it and record what was actually spent. Called
 * on BOTH success and failure — a failed judge call that still cost money must
 * charge the budget, or the cap leaks a little on every error.
 */
export async function settleOnlineEvalBudget(
  policyId: string,
  reservedUsd: number,
  actualUsd: number,
  judged: boolean,
  reservedAt: number,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  const day = budgetDayKey(reservedAt)
  const id = budgetRowId(policyId, day)
  await db.transaction("rw", db.evalOnlineBudget, async () => {
    const row = await db.evalOnlineBudget.get(id)
    if (!row) return
    await db.evalOnlineBudget.put({
      ...row,
      reservedUsd: Math.max(0, row.reservedUsd - reservedUsd),
      spentUsd: row.spentUsd + actualUsd,
      judgedCount: row.judgedCount + (judged ? 1 : 0),
      updatedAt: now,
    })
  })
}

// ── Observations ────────────────────────────────────────────────────────────

export async function putObservations(rows: readonly EvalObservationRow[]): Promise<void> {
  if (rows.length === 0) return
  await getDb().evalObservations.bulkPut([...rows])
}

export async function listObservationsForTrace(traceId: string): Promise<EvalObservationRow[]> {
  return getDb().evalObservations.where("scope.traceId").equals(traceId).toArray()
}

export async function listRecentObservations(
  origin: EvalObservationRow["origin"],
  since: number
): Promise<EvalObservationRow[]> {
  return getDb()
    .evalObservations.where("[origin+createdAt]")
    .between([origin, since], [origin, Infinity])
    .toArray()
}

// ── Retention ───────────────────────────────────────────────────────────────

export interface OnlineEvalPruneCutoffs {
  /** Observations created before this epoch are removed. */
  observationsBefore: number
  /** SETTLED queue rows updated before this epoch are removed. */
  queueBefore: number
  /** Budget rows for days before this epoch are removed. */
  budgetBefore: number
  /**
   * Unsettled rows older than this are abandoned and removed too.
   *
   * Without it, a row enqueued on a device whose worker never ran again — an
   * app closed for good, a policy deleted mid-flight — is immortal, because the
   * settled-only sweep can never reach it. Set far beyond the settled window so
   * it only ever catches genuinely stranded work.
   */
  abandonedBefore: number
}

/**
 * Central-sweep prune for the three online tables.
 *
 * Cutoffs are passed in rather than computed here so the windows stay declared
 * in one place — the governance catalog — instead of being restated as
 * constants that can drift from the policy they are supposed to implement.
 *
 * Queue rows are pruned only once SETTLED. Deleting a `queued` or `running`
 * item because it is old would drop work silently; age is not a reason to
 * forget something that has not finished.
 */
export async function pruneOnlineEvalData(cutoffs: OnlineEvalPruneCutoffs): Promise<number> {
  const db = getDb()
  const observations = await db.evalObservations
    .where("createdAt")
    .below(cutoffs.observationsBefore)
    .delete()
  const settled = await db.evalOnlineQueue
    .where("state")
    .anyOf("done", "failed", "skipped")
    .filter((row) => row.updatedAt < cutoffs.queueBefore)
    .delete()
  const abandoned = await db.evalOnlineQueue
    .where("state")
    .anyOf("queued", "running")
    .filter((row) => row.enqueuedAt < cutoffs.abandonedBefore)
    .delete()
  const budget = await db.evalOnlineBudget
    .where("day")
    .below(budgetDayKey(cutoffs.budgetBefore))
    .delete()
  return observations + settled + abandoned + budget
}
