// The ONE place a usage row and its daily budget projection are committed.
//
// Before ADR-0165 the two were written by different code on different clocks:
// `upsertSessionUsage` wrote the canonical per-turn row while
// `recordProviderOutcome` independently incremented `providerCostDaily` from
// its own estimate. The tables therefore disagreed by construction. A turn
// whose SDK cost was 0 but whose tokens were priceable landed in the rollup
// and not in the ledger. A retried turn overwrote its ledger row in place but
// added a SECOND increment to the rollup. Nothing detected either, because no
// reader ever compared them.
//
// This module makes `sessionUsage` the money and `providerCostDaily` a
// projection of it:
//
//   1. cost is resolved and FROZEN once, here, before anything is written,
//   2. the prior row (if any) is read inside the same transaction so an
//      overwrite applies a DELTA rather than a second full increment,
//   3. both tables commit together or neither does,
//   4. `imported` rows (spend paid on another machine, incl. every external
//      scan row) are written to the ledger and excluded from the projection,
//   5. the in-memory budget mirror is reconciled to the committed day total
//      rather than to an optimistic guess.
//
// The mirror is reached through an injected sink so `lib/db` and `lib/usage`
// stay free of a zustand import on the write path. `lib/usage/cost-budget-runtime.ts`
// installs the production sink at boot.

import { getDb } from "@/lib/db/schema"
import {
  buildCostDailyId,
  localDayString,
  type ProviderCostDailyRow,
} from "@/lib/db/provider-cost-daily"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { effectiveCostUsdDetailed, type PricingResolver } from "@/lib/usage/session-analytics"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"

/** What a committed write did to the budget projection. */
export interface UsageCommitDaily {
  day: string
  providerId: string
  /** The provider's committed total for `day`, summed across its models. */
  providerTotalUsd: number
  /** Signed change this write applied. Negative when a retry got cheaper. */
  deltaUsd: number
}

export interface UsageCommitResult {
  /** The row exactly as persisted, with cost frozen. */
  row: SessionUsageRow
  /** `null` when the row is imported, unpriceable, or carries no provider. */
  daily: UsageCommitDaily | null
  /** True when this write replaced an existing row rather than inserting one. */
  replaced: boolean
}

/**
 * Sink the committed day total is pushed to. Production wires the provider-cost
 * mirror store. Kept injectable so node-env tests exercise the transaction
 * without a React/zustand dependency.
 */
export type BudgetMirrorSink = (committed: UsageCommitDaily) => void

let mirrorSink: BudgetMirrorSink | null = null

/**
 * localStorage key marking that the one-time v218 projection rebuild has run.
 * Owned here rather than by the initializer so the ledger and its repair path
 * agree on the name without the ledger importing a React module.
 */
export const USAGE_LEDGER_RECONCILE_MARKER = "usage.ledger.reconciled.v218"

/** Install the production budget-mirror sink. Returns a disposer. */
export function setBudgetMirrorSink(sink: BudgetMirrorSink | null): () => void {
  const prior = mirrorSink
  mirrorSink = sink
  return () => {
    mirrorSink = prior
  }
}

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * Resolve and FREEZE a row's cost, if it is not frozen already.
 *
 * A row that already carries `costSource` was frozen by an earlier writer and
 * is returned untouched. Everything else is priced once here, so the frozen
 * fields are set by exactly one code path instead of by each of the seven
 * `record*Usage` helpers guessing separately.
 */
export function freezeUsageCost(
  row: SessionUsageRow,
  resolve: PricingResolver = resolveModelPricingUsd
): SessionUsageRow {
  if (row.costSource !== undefined) return row
  const detail = effectiveCostUsdDetailed(row, resolve)
  return {
    ...row,
    costUsd: detail.known ? detail.cost : 0,
    costSource: detail.source === "sdk" ? "sdk" : detail.known ? "derived" : "unknown",
    costKnown: detail.known,
  }
}

/**
 * True when a row contributes to the local daily budget projection.
 *
 * Imported spend never does: it was paid in another agent, often on another
 * account, and blending it in would misfire the budget gate. A row with no
 * provider or no model has nowhere to land in a `[day, provider, model]`
 * rollup, so it stays ledger-only.
 */
export function contributesToBudget(row: SessionUsageRow): boolean {
  // Inlined rather than imported from `lib/db/session-usage` so this module
  // holds only a TYPE edge back to the ledger table. `upsertSessionUsage`
  // imports `commitUsageRow`, and a second value edge in the other direction
  // would make the pair a genuine runtime cycle.
  const local = row.imported !== true
  return local && Boolean(row.providerId) && Boolean(row.model)
}

/** Signed contribution a row makes to the rollup, or zeros when it makes none. */
function rollupContribution(row: SessionUsageRow | null | undefined): {
  costUsd: number
  inputTokens: number
  outputTokens: number
  requestCount: number
  key: { day: string; providerId: string; modelId: string } | null
} {
  if (!row || !contributesToBudget(row)) {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, key: null }
  }
  const costUsd = row.costKnown === false ? 0 : Math.max(0, num(row.costUsd))
  return {
    costUsd,
    inputTokens: Math.max(0, num(row.inputTokens)),
    outputTokens: Math.max(0, num(row.outputTokens)),
    requestCount: 1,
    key: {
      day: localDayString(row.at),
      providerId: row.providerId as string,
      modelId: row.model as string,
    },
  }
}

/**
 * Apply a signed contribution to one rollup bucket. Exported for the rebuild
 * path and for tests. Never lets a bucket go negative, and deletes a bucket
 * that a retraction empties so the table does not accumulate zero rows.
 */
export async function applyRollupDelta(
  table: {
    get(id: string): Promise<ProviderCostDailyRow | undefined>
    put(row: ProviderCostDailyRow): Promise<unknown>
    delete(id: string): Promise<unknown>
  },
  key: { day: string; providerId: string; modelId: string },
  delta: { costUsd: number; inputTokens: number; outputTokens: number; requestCount: number },
  now: number
): Promise<void> {
  const id = buildCostDailyId(key.day, key.providerId, key.modelId)
  const existing = await table.get(id)
  const next: ProviderCostDailyRow = {
    id,
    day: key.day,
    providerId: key.providerId,
    modelId: key.modelId,
    totalCostUsd: Math.max(0, (existing?.totalCostUsd ?? 0) + delta.costUsd),
    requestCount: Math.max(0, (existing?.requestCount ?? 0) + delta.requestCount),
    inputTokens: Math.max(0, (existing?.inputTokens ?? 0) + delta.inputTokens),
    outputTokens: Math.max(0, (existing?.outputTokens ?? 0) + delta.outputTokens),
    updatedAt: now,
  }
  if (next.requestCount === 0 && next.totalCostUsd === 0 && next.inputTokens === 0) {
    if (existing) await table.delete(id)
    return
  }
  await table.put(next)
}

/**
 * Commit one usage row and its budget projection atomically.
 *
 * Idempotent on `messageId`: writing the same id twice leaves the ledger with
 * one row AND the projection with one turn's worth of spend, which is the
 * invariant `usage-ledger.test.ts` pins for every surface.
 */
export async function commitUsageRow(
  row: SessionUsageRow,
  opts: { now?: number; resolve?: PricingResolver } = {}
): Promise<UsageCommitResult | null> {
  if (!row.messageId || !row.sessionId) return null
  const now = opts.now ?? Date.now()
  const frozen = freezeUsageCost(row, opts.resolve)
  const db = getDb()

  let replaced = false
  let daily: UsageCommitDaily | null = null

  await db.transaction("rw", db.sessionUsage, db.providerCostDaily, async () => {
    const prior = await db.sessionUsage.get(frozen.messageId)
    replaced = prior != null
    await db.sessionUsage.put(frozen)

    const before = rollupContribution(prior)
    const after = rollupContribution(frozen)
    if (!before.key && !after.key) return

    const sameBucket =
      before.key != null &&
      after.key != null &&
      before.key.day === after.key.day &&
      before.key.providerId === after.key.providerId &&
      before.key.modelId === after.key.modelId

    if (before.key && !sameBucket) {
      // The retry moved buckets (different day, provider or model). Retract the
      // old contribution in full before adding the new one, otherwise a model
      // switch on a retry double-counts under two model ids forever.
      await applyRollupDelta(
        db.providerCostDaily,
        before.key,
        {
          costUsd: -before.costUsd,
          inputTokens: -before.inputTokens,
          outputTokens: -before.outputTokens,
          requestCount: -before.requestCount,
        },
        now
      )
    }

    if (after.key) {
      const base = sameBucket
        ? before
        : { costUsd: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 }
      await applyRollupDelta(
        db.providerCostDaily,
        after.key,
        {
          costUsd: after.costUsd - base.costUsd,
          inputTokens: after.inputTokens - base.inputTokens,
          outputTokens: after.outputTokens - base.outputTokens,
          requestCount: after.requestCount - base.requestCount,
        },
        now
      )
    }

    // Sum the provider's committed rows for the affected day INSIDE the
    // transaction. This is what lets the synchronous budget mirror snap to
    // durable state instead of drifting when a write is lost.
    const target = after.key ?? before.key
    if (!target) return
    const dayRows = await db.providerCostDaily
      .where("[providerId+day]")
      .equals([target.providerId, target.day])
      .toArray()
    daily = {
      day: target.day,
      providerId: target.providerId,
      providerTotalUsd: dayRows.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0),
      deltaUsd: after.costUsd - before.costUsd,
    }
  })

  if (daily && mirrorSink) {
    try {
      mirrorSink(daily)
    } catch {
      // The mirror is an accelerator for the budget gate, never the record.
      // A failing sink must not fail a committed write.
    }
  }

  return { row: frozen, daily, replaced }
}

/**
 * Rebuild the last {@param days} days of `providerCostDaily` from the ledger,
 * atomically. This is the one-time reconciliation the app runs on idle after
 * the v218 upgrade, and the repair path when a projection is suspected wrong.
 *
 * Every bucket in the window is recomputed from `sessionUsage`, so a projection
 * that drifted for any reason converges in one pass. Buckets outside the window
 * are untouched.
 */
export async function rebuildProviderCostDaily(
  days = 90,
  opts: { now?: number; resolve?: PricingResolver } = {}
): Promise<{ days: number; buckets: number; rows: number }> {
  const now = opts.now ?? Date.now()
  const windowDays = Math.max(1, Math.floor(days))
  const fromMs = now - windowDays * 86_400_000
  const fromDay = localDayString(fromMs)
  const toDay = localDayString(now)
  const db = getDb()

  let buckets = 0
  let rows = 0
  await db.transaction("rw", db.sessionUsage, db.providerCostDaily, async () => {
    const ledger = await db.sessionUsage.where("at").aboveOrEqual(fromMs).toArray()
    const next = new Map<string, ProviderCostDailyRow>()
    for (const raw of ledger) {
      const contribution = rollupContribution(freezeUsageCost(raw, opts.resolve))
      if (!contribution.key) continue
      rows += 1
      const { day, providerId, modelId } = contribution.key
      const id = buildCostDailyId(day, providerId, modelId)
      const acc = next.get(id) ?? {
        id,
        day,
        providerId,
        modelId,
        totalCostUsd: 0,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        updatedAt: now,
      }
      acc.totalCostUsd += contribution.costUsd
      acc.requestCount += contribution.requestCount
      acc.inputTokens = (acc.inputTokens ?? 0) + contribution.inputTokens
      acc.outputTokens = (acc.outputTokens ?? 0) + contribution.outputTokens
      next.set(id, acc)
    }
    const stale = await db.providerCostDaily
      .where("day")
      .between(fromDay, toDay, true, true)
      .primaryKeys()
    if (stale.length > 0) await db.providerCostDaily.bulkDelete(stale as string[])
    const values = [...next.values()]
    if (values.length > 0) await db.providerCostDaily.bulkPut(values)
    buckets = values.length
  })

  return { days: windowDays, buckets, rows }
}
