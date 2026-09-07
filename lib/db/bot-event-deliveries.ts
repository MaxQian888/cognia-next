/**
 * The Bot delivery queue.
 *
 * One row per (event, installation). This is the only thing the Bot plane
 * persists about an event, because every source already persists, verifies and
 * deduplicates its own arrival. What is genuinely per-recipient is the
 * DELIVERY: its lease, its attempts, its dead letter, and the run it started.
 *
 * The retry mathematics are `lib/queue/retry-policy.ts`, the same ones the
 * mobile outbound queue uses. Two backoff curves for two queues is how one of
 * them quietly stops matching the timeouts it was tuned against.
 */

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import type { BotDeliveryStatus, BotEventDeliveryRow } from "@/lib/db/bot-types"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import { decideNextAttempt } from "@/lib/queue/retry-policy"

/** How long a runner may hold a delivery before another may take it. */
export const BOT_DELIVERY_LEASE_MS = 2 * 60_000

/** Settled rows are pruned after this long. Mirrors the governance policy. */
export const BOT_DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60_000

const TERMINAL_STATUSES = new Set<BotDeliveryStatus>(["succeeded", "deadletter", "dismissed"])

/** Is this delivery finished, for better or worse? */
export function isTerminalBotDelivery(status: BotDeliveryStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * What a recovered attempt records as its failure.
 *
 * Deliberately worded to miss every pattern in `NON_RETRYABLE_PATTERNS`, so an
 * interrupted attempt backs off and retries rather than dead-lettering on the
 * first crash.
 */
export const BOT_DELIVERY_INTERRUPTED_ERROR = "bot run interrupted: the host stopped mid-attempt"

/**
 * Was this row mid-attempt when whatever was running it disappeared?
 *
 * `leased` and `running` are the same answer. They differ only in which half of
 * the attempt the runner had reached, and neither half survives the process
 * that was executing it. Treating `running` as a state only its own runner can
 * leave is what used to strand a delivery forever: nothing listed it, nothing
 * pruned it, and `countActiveBotDeliveriesForKey` counted it as live, so its
 * concurrency key was retired along with it.
 */
/**
 * May this process act on the row at all?
 *
 * A mirrored row belongs to the Host that synced it. Fencing here rather than
 * in the runner is deliberate: `listDueBotDeliveries`, `claimBotDelivery` and
 * `countActiveBotDeliveriesForKey` all flow through this module, and a fence in
 * only one of them leaves the other two able to act on a foreign row. This is
 * the same choke point `isLocallyDispatchable` occupies for the outbound queue.
 */
function isLocallyOwned(row: BotEventDeliveryRow): boolean {
  return row.syncedFromHost !== true
}

function isMidAttempt(status: BotDeliveryStatus): boolean {
  return status === "leased" || status === "running"
}

function isAbandonedAttempt(row: BotEventDeliveryRow, now: number): boolean {
  if (!isMidAttempt(row.status)) return false
  return (row.leaseExpiresAt ?? 0) <= now
}

/**
 * The row an abandoned attempt becomes: one attempt spent, backed off, and
 * dead-lettered once the budget is gone.
 *
 * The charge is the whole point. Without it a delivery that kills whatever runs
 * it is re-claimed forever, because the attempt it was supposed to spend is
 * never recorded and the lease expiry alone makes it due again.
 */
function chargeAbandonedAttempt(
  row: BotEventDeliveryRow,
  now: number,
  random?: () => number
): BotEventDeliveryRow {
  const decision = decideNextAttempt({
    attempts: row.attempts,
    error: new Error(BOT_DELIVERY_INTERRUPTED_ERROR),
    nowMs: now,
    random,
  })
  const deadlettered = decision.status === "deadlettered"
  const next: BotEventDeliveryRow = {
    ...row,
    status: deadlettered ? "deadletter" : "pending",
    attempts: decision.attempts,
    nextAttemptAt: decision.nextAttemptAt,
    lastError: decision.lastError,
    updatedAt: now,
    ...(deadlettered ? { settledAt: now } : {}),
  }
  delete next.leaseOwner
  delete next.leaseExpiresAt
  return next
}

/**
 * The arrival-dedup key for one delivery.
 *
 * Scoped to the installation, not the event: the same event legitimately fans
 * out to several installations, and a global key would let the first recipient
 * swallow everyone else's copy.
 */
export function botDeliveryDedupKey(installationId: string, eventId: string): string {
  return `${installationId}::${eventId}`
}

export interface EnqueueBotDeliveryInput {
  envelope: BotEventEnvelopeV1
  /** Hold the delivery until this instant, for a debounced trigger. */
  notBefore?: number
  concurrencyKey?: string
  now?: number
}

/**
 * Record a delivery, or return the one that already exists.
 *
 * Enqueue-once by unique index, not by read-then-write: two runners fanning
 * out the same at-least-once webhook race here constantly, and the read alone
 * cannot stop the second row from being written.
 */
export async function enqueueBotDelivery(
  input: EnqueueBotDeliveryInput
): Promise<BotEventDeliveryRow> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const envelope = input.envelope
  const dedupKey = botDeliveryDedupKey(envelope.installationId, envelope.eventId)

  const existing = await db.botEventDeliveries.where("dedupKey").equals(dedupKey).first()
  if (existing) return existing

  const row: BotEventDeliveryRow = {
    id: envelope.deliveryId,
    eventId: envelope.eventId,
    installationId: envelope.installationId,
    triggerId: envelope.triggerId,
    source: envelope.source,
    type: envelope.type,
    dedupKey,
    status: "pending",
    attempts: 0,
    nextAttemptAt: input.notBefore ?? now,
    envelope,
    receivedAt: now,
    updatedAt: now,
    ...(input.notBefore ? { notBefore: input.notBefore } : {}),
    ...(input.concurrencyKey ? { concurrencyKey: input.concurrencyKey } : {}),
    ...(envelope.correlation ? { correlation: envelope.correlation } : {}),
  }

  try {
    await db.botEventDeliveries.add(row)
    return row
  } catch (error) {
    if (!(error instanceof Dexie.ConstraintError)) throw error
    const winner = await db.botEventDeliveries.where("dedupKey").equals(dedupKey).first()
    if (!winner) throw error
    return winner
  }
}

/**
 * Deliveries whose next attempt is due, oldest first.
 *
 * An abandoned attempt is due again whichever status it stopped in: the runner
 * that held it is gone, and leaving the delivery there forever is the
 * difference between a crash costing one retry and costing the event.
 */
export async function listDueBotDeliveries(
  limit = 20,
  now = Date.now()
): Promise<BotEventDeliveryRow[]> {
  const rows = await getDb().botEventDeliveries.toArray()
  return rows
    .filter((row) => {
      if (!isLocallyOwned(row)) return false
      if (row.status === "pending") return row.nextAttemptAt <= now
      return isAbandonedAttempt(row, now)
    })
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.receivedAt - b.receivedAt)
    .slice(0, limit)
}

/**
 * Take a delivery for `owner`, or return undefined when somebody else already
 * holds a live lease on it.
 *
 * Serialized in a transaction so two runners reading the same due row cannot
 * both conclude they won.
 */
export async function claimBotDelivery(
  id: string,
  owner: string,
  now = Date.now()
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row) return undefined
    if (!isLocallyOwned(row)) return undefined
    if (isTerminalBotDelivery(row.status)) return undefined
    // `running` counts here too. A live lease is a live lease whichever half of
    // the attempt its holder had reached, and letting a second runner take a
    // row somebody is executing is the same double-run the lease exists to stop.
    const heldByOther =
      (row.status === "leased" || row.status === "running") &&
      row.leaseOwner !== owner &&
      (row.leaseExpiresAt ?? 0) > now
    if (heldByOther) return undefined

    const claimed: BotEventDeliveryRow = {
      ...row,
      status: "leased",
      leaseOwner: owner,
      leaseExpiresAt: now + BOT_DELIVERY_LEASE_MS,
      updatedAt: now,
    }
    await db.botEventDeliveries.put(claimed)
    return claimed
  })
}

/** Extend a live lease. Returns false when the lease is no longer this owner's. */
export async function renewBotDeliveryLease(
  id: string,
  owner: string,
  now = Date.now()
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row || row.leaseOwner !== owner || isTerminalBotDelivery(row.status)) return false
    await db.botEventDeliveries.put({
      ...row,
      leaseExpiresAt: now + BOT_DELIVERY_LEASE_MS,
      updatedAt: now,
    })
    return true
  })
}

/** Attach the ExecutionRun a delivery started, and mark it running. */
export async function markBotDeliveryRunning(
  id: string,
  runId: string,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  const row = await db.botEventDeliveries.get(id)
  if (!row) return
  await db.botEventDeliveries.put({ ...row, status: "running", runId, updatedAt: now })
}

export async function completeBotDelivery(id: string, now = Date.now()): Promise<void> {
  const db = getDb()
  const row = await db.botEventDeliveries.get(id)
  if (!row) return
  const settled: BotEventDeliveryRow = {
    ...row,
    status: "succeeded",
    updatedAt: now,
    settledAt: now,
  }
  delete settled.leaseOwner
  delete settled.leaseExpiresAt
  await db.botEventDeliveries.put(settled)
}

/**
 * Record a failed attempt, scheduling a retry or dead-lettering.
 *
 * The decision comes from the shared retry policy, which also refuses to retry
 * errors that will always fail (a 403, a schema violation). Retrying those
 * burns the attempt budget an intermittent failure needed.
 */
export async function failBotDelivery(
  id: string,
  error: unknown,
  now = Date.now(),
  random?: () => number
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  const row = await db.botEventDeliveries.get(id)
  if (!row) return undefined

  const decision = decideNextAttempt({ attempts: row.attempts, error, nowMs: now, random })
  const deadlettered = decision.status === "deadlettered"
  const next: BotEventDeliveryRow = {
    ...row,
    status: deadlettered ? "deadletter" : "pending",
    attempts: decision.attempts,
    nextAttemptAt: decision.nextAttemptAt,
    lastError: decision.lastError,
    updatedAt: now,
    ...(deadlettered ? { settledAt: now } : {}),
  }
  delete next.leaseOwner
  delete next.leaseExpiresAt
  await db.botEventDeliveries.put(next)
  return next
}

/**
 * Retire a delivery that was correctly never run.
 *
 * Kept apart from `failed` so a coalesced burst or a disabled installation
 * does not read as a broken queue.
 */
export async function dismissBotDelivery(
  id: string,
  reason: string,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  const row = await db.botEventDeliveries.get(id)
  if (!row) return
  const next: BotEventDeliveryRow = {
    ...row,
    status: "dismissed",
    lastError: reason,
    updatedAt: now,
    settledAt: now,
  }
  delete next.leaseOwner
  delete next.leaseExpiresAt
  await db.botEventDeliveries.put(next)
}

/** Put a dead letter back in the queue for one more attempt. */
export async function replayBotDelivery(
  id: string,
  now = Date.now()
): Promise<BotEventDeliveryRow | undefined> {
  const db = getDb()
  const row = await db.botEventDeliveries.get(id)
  if (!row) return undefined
  const next: BotEventDeliveryRow = {
    ...row,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    updatedAt: now,
  }
  delete next.settledAt
  delete next.leaseOwner
  delete next.leaseExpiresAt
  delete next.lastError
  await db.botEventDeliveries.put(next)
  return next
}

/** What became of a delivery whose attempt was abandoned. */
export type BotDeliveryRecovery = "recovered" | "deadlettered"

/**
 * Charge one attempt to a delivery whose runner disappeared, and put it back in
 * the queue (or dead-letter it once the budget is gone).
 *
 * Called before the claim rather than inside it so the runner can report why it
 * skipped this pass. The row comes back on the next drain, after its backoff,
 * which is what stops a delivery that kills its host from being re-claimed in a
 * tight loop.
 */
export async function recoverAbandonedBotDelivery(
  id: string,
  now = Date.now(),
  random?: () => number
): Promise<BotDeliveryRecovery | null> {
  const db = getDb()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const row = await db.botEventDeliveries.get(id)
    if (!row || !isLocallyOwned(row) || !isAbandonedAttempt(row, now)) return null
    const next = chargeAbandonedAttempt(row, now, random)
    await db.botEventDeliveries.put(next)
    return next.status === "deadletter" ? "deadlettered" : "recovered"
  })
}

/**
 * Reclaim, at boot, the rows this host was executing when it stopped.
 *
 * Owner-scoped on purpose. The connector plane can reclaim every `running` row
 * because it owns its adapters outright; the Bot queue may be drained by more
 * than one host, so a blanket sweep would yank a delivery out from under a peer
 * that is still working on it. What a restarting host *does* know is that its
 * own owner string cannot belong to a live attempt: that process is this one,
 * and it has just started. So its rows are recovered immediately instead of
 * waiting out a lease nobody is holding.
 */
export async function recoverStaleBotDeliveries(input: {
  owner: string
  now?: number
  random?: () => number
}): Promise<number> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", db.botEventDeliveries, async () => {
    const rows = await db.botEventDeliveries.toArray()
    const mine = rows.filter(
      (row) =>
        isLocallyOwned(row) &&
        row.leaseOwner === input.owner &&
        (row.status === "leased" || row.status === "running")
    )
    for (const row of mine) {
      await db.botEventDeliveries.put(chargeAbandonedAttempt(row, now, input.random))
    }
    return mine.length
  })
}

/** In-flight deliveries sharing a concurrency key, for serialisation. */
export async function countActiveBotDeliveriesForKey(
  concurrencyKey: string,
  now = Date.now()
): Promise<number> {
  const rows = await getDb()
    .botEventDeliveries.where("concurrencyKey")
    .equals(concurrencyKey)
    .toArray()
  // Both mid-attempt statuses need a LIVE lease to count. Counting `running`
  // unconditionally is what used to retire a concurrency key permanently: one
  // crash left a row nothing could clear, and every later delivery on that key
  // was skipped as serialised forever after.
  return rows.filter(
    (row) => isLocallyOwned(row) && !isAbandonedAttempt(row, now) && isMidAttempt(row.status)
  ).length
}

export async function listBotDeliveries(query: {
  installationId?: string
  status?: BotDeliveryStatus
  limit?: number
}): Promise<BotEventDeliveryRow[]> {
  const rows = await getDb().botEventDeliveries.toArray()
  return rows
    .filter((row) => {
      if (query.installationId && row.installationId !== query.installationId) return false
      if (query.status && row.status !== query.status) return false
      return true
    })
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, query.limit ?? 100)
}

/** Deliveries waiting on a correlation key, for a run parked in `waitForEvent`. */
export async function findBotDeliveryByCorrelation(
  correlation: string
): Promise<BotEventDeliveryRow | undefined> {
  return getDb().botEventDeliveries.where("correlation").equals(correlation).first()
}

/**
 * Drop settled rows past the retention window, and retire anything that has
 * been unsettled for longer than one. Returns the number of rows removed.
 *
 * The second half is the backstop. Recovery already returns an abandoned
 * attempt to the queue, so a row should not be able to sit unsettled for two
 * weeks; if one does, its installation is gone or its trigger no longer exists,
 * and leaving it is how a queue accumulates work nobody will ever do. It is
 * dismissed rather than deleted so the reason survives to the next sweep.
 */
export async function pruneSettledBotDeliveries(now = Date.now()): Promise<number> {
  const db = getDb()
  const cutoff = now - BOT_DELIVERY_RETENTION_MS
  const rows = await db.botEventDeliveries.toArray()

  const expired = rows.filter(
    (row) => isLocallyOwned(row) && !isTerminalBotDelivery(row.status) && row.receivedAt <= cutoff
  )
  for (const row of expired) {
    await dismissBotDelivery(row.id, "unsettled past the retention window", now)
  }

  const ids = rows
    .filter((row) => row.settledAt !== undefined && row.settledAt <= cutoff)
    .map((row) => row.id)
  if (ids.length === 0) return 0
  await db.botEventDeliveries.bulkDelete(ids)
  return ids.length
}
