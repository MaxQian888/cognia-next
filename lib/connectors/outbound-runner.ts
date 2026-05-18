/**
 * Outbound delivery runner — Tasks 38 & 39.
 *
 * Task 38 primitives:
 *   - Per-adapter circuit breaker: trips when failure rate in a sliding window
 *     exceeds the threshold; re-opens after cooldown.
 *   - Per-adapter token bucket: rate limits outbound send attempts.
 *   - Exponential back-off with jitter: `min(60 000, 1000 * 2^attempts) + jitter`.
 *   - Idempotency LRU: short-circuits retries when the platform already acked.
 *   - Dead-letter after 5 attempts.
 *
 * Task 39 addition:
 *   - Per-conversation FIFO lane: a `Map<conversationKey, Promise<void>>` chain
 *     ensures messages within a conversation are sent in createdAt order while
 *     cross-conversation sends run in parallel.
 *
 * Usage:
 *   const controller = new AbortController()
 *   startOutboundRunner({ adapters, signal: controller.signal }).catch(console.error)
 *   // later:
 *   controller.abort()
 */

import type { PlatformAdapter } from "@/types/connectors"
import {
  pickNextDue,
  markSending,
  markSent,
  markFailed,
  markDeadlettered,
} from "@/lib/db/outbound-jobs"
import { getDb } from "@/lib/db/schema"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "./audit"
import { createCircuitBreaker, type CircuitBreaker } from "./circuit-breaker"
import { createTokenBucket, type TokenBucket } from "./rate-limit"

// ── Quiet hours helpers ────────────────────────────────────────────────────────

/**
 * Return true if the given wall-clock timestamp (ms) falls within the quiet
 * window `[from, to]` in the specified IANA timezone. The window is expressed
 * as "HH:MM" strings (24-h). Supports cross-midnight windows (e.g. 22:00–06:00).
 */
export function isInQuietHours(nowMs: number, from: string, to: string, tz: string): boolean {
  // Parse HH:MM strings into total-minutes-since-midnight
  const toMins = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number)
    return (h ?? 0) * 60 + (m ?? 0)
  }

  // Get current local time in target timezone
  const localStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(nowMs))

  // "24:00" can appear for midnight in some locales — normalise to 0:00
  const [rawH, rawM] = localStr.split(":").map(Number)
  const currentMins = (rawH % 24) * 60 + (rawM ?? 0)

  const fromMins = toMins(from)
  const toMins2 = toMins(to)

  if (fromMins <= toMins2) {
    // Same-day window (e.g. 09:00–17:00)
    return currentMins >= fromMins && currentMins < toMins2
  } else {
    // Cross-midnight window (e.g. 22:00–06:00)
    return currentMins >= fromMins || currentMins < toMins2
  }
}

/**
 * Return the ms duration until the quiet window's `to` time next occurs in
 * the supplied timezone.
 *
 * O(1) implementation: we ask the platform's Intl.DateTimeFormat for the
 * current wall-clock (hour:minute:second) in `tz`, compute the delta to
 * the target `to` time on the same wall-clock day, and roll over by 24h
 * when the target is already past. Avoids the prior 1440-iteration
 * minute-stepping loop and its "should never happen" 24h fallback.
 *
 * DST: across a "spring forward" boundary the wall-clock gap can be off
 * by an hour, but quiet-hours wakeups are coarse enough that the runner
 * simply re-evaluates `isInQuietHours` after the deferral; an extra check
 * is much cheaper than handling DST exactly. Across "fall back" the same
 * tolerance applies — at most a one-hour delay before next attempt.
 */
export function msUntilQuietEnd(nowMs: number, to: string, tz: string): number {
  const [rawToH, rawToM] = to.split(":").map(Number)
  const toH = rawToH ?? 0
  const toM = rawToM ?? 0

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs))

  let curH = 0
  let curM = 0
  let curS = 0
  for (const p of parts) {
    if (p.type === "hour") curH = parseInt(p.value, 10) % 24
    else if (p.type === "minute") curM = parseInt(p.value, 10)
    else if (p.type === "second") curS = parseInt(p.value, 10)
  }

  const SECOND = 1_000
  const DAY = 86_400
  const curTotal = curH * 3600 + curM * 60 + curS
  const targetTotal = toH * 3600 + toM * 60
  let deltaSec = targetTotal - curTotal
  // If the target is already past today (or exactly now), roll over.
  // Strict `<= 0` matches the prior loop's "round up to next minute"
  // behaviour — the quiet window has closed; the runner should fire
  // again at the next occurrence, not zero-defer in an infinite loop.
  if (deltaSec <= 0) deltaSec += DAY
  return deltaSec * SECOND
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const IDEMPOTENCY_LRU_CAP = 1_000

// ── LRU map (insertion-order, capped) ────────────────────────────────────────

class LruMap<K, V> {
  private readonly cap: number
  private readonly map: Map<K, V>

  constructor(cap: number) {
    this.cap = cap
    this.map = new Map()
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  get(key: K): V | undefined {
    return this.map.get(key)
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.cap) {
      // Evict oldest (first) entry
      this.map.delete(this.map.keys().next().value as K)
    }
    this.map.set(key, value)
  }

  size(): number {
    return this.map.size
  }
}

// ── Per-conversation FIFO lane (Task 39) ──────────────────────────────────────

/**
 * Chains work items for a single conversation so they execute serially,
 * preserving createdAt order while allowing cross-conversation parallelism.
 */
export class ConversationLane {
  private tail: Promise<void> = Promise.resolve()

  /** Enqueue `work` behind the current tail and return the new tail. */
  enqueue(work: () => Promise<void>): Promise<void> {
    this.tail = this.tail
      .then(() => work())
      .catch(() => {
        // Errors are handled inside `work`; lane must not stall on them.
      })
    return this.tail
  }
}

// ── Runner options ────────────────────────────────────────────────────────────

export interface OutboundRunnerOptions {
  /** All registered platform adapters keyed by adapterId. */
  adapters: Map<string, PlatformAdapter>
  /** Poll interval in ms. Default 200 ms. */
  pollIntervalMs?: number
  /** Cancellation signal — runner exits when this aborts. */
  signal: AbortSignal
  /** Clock injection for circuit breakers and rate limiters. */
  now?: () => number
  /**
   * Jitter factory — returns a random ms to add to the back-off.
   * Default: `() => Math.random() * 500`.
   */
  jitter?: () => number
}

// ── Per-adapter state ────────────────────────────────────────────────────────

interface AdapterState {
  breaker: CircuitBreaker
  bucket: TokenBucket
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Start the outbound delivery loop. Resolves when `signal` is aborted.
 * Never rejects — all delivery errors are surfaced via audit log.
 */
export async function startOutboundRunner(opts: OutboundRunnerOptions): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 200
  const clock = opts.now ?? (() => Date.now())
  const jitter = opts.jitter ?? (() => Math.random() * 500)

  const adapterState = new Map<string, AdapterState>()
  const idempotencyCache = new LruMap<string, string>(IDEMPOTENCY_LRU_CAP)
  // Task 39: per-conversation FIFO lanes
  const lanes = new Map<string, ConversationLane>()

  function getAdapterState(adapterId: string): AdapterState {
    if (!adapterState.has(adapterId)) {
      adapterState.set(adapterId, {
        breaker: createCircuitBreaker({ now: clock }),
        bucket: createTokenBucket({ capacity: 20, refillPerSec: 5, now: clock }),
      })
    }
    return adapterState.get(adapterId)!
  }

  function getLane(conversationKey: string): ConversationLane {
    if (!lanes.has(conversationKey)) {
      lanes.set(conversationKey, new ConversationLane())
    }
    return lanes.get(conversationKey)!
  }

  /**
   * Process a single outbound job. Called inside a conversation lane so
   * ordering is guaranteed within each conversation.
   */
  async function processJob(jobId: string, adapterId: string): Promise<void> {
    const now = clock()
    const { breaker, bucket } = getAdapterState(adapterId)

    // Re-fetch the job by id to get the latest state (attempts may have been
    // incremented by a prior lane execution for this same job).
    const job = await getDb().outboundQueue.get(jobId)
    if (!job) return // already processed or deleted

    const { conversationKey, request } = job
    const { idempotencyKey } = request.metadata

    // ── Muted / quiet-hours check ─────────────────────────────────────────
    const adapterRow = await getAdapterInstance(adapterId)
    if (adapterRow) {
      if (adapterRow.muted === true) {
        // Muted: defer by 60 s, do NOT count as failure
        await markFailed(job.id, "muted", "Adapter is globally muted", now + 60_000)
        await appendAudit({
          adapterId,
          kind: "delivery.error",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: "muted",
          message: "Adapter is globally muted — delivery deferred",
        })
        return
      }

      if (adapterRow.quietHours) {
        const { from, to, tz } = adapterRow.quietHours
        if (isInQuietHours(now, from, to, tz)) {
          const deferMs = msUntilQuietEnd(now, to, tz)
          await markFailed(job.id, "quiet_hours", "Within quiet hours window", now + deferMs)
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "quiet_hours",
            message: `Within quiet hours [${from}–${to} ${tz}] — deferred ${Math.round(deferMs / 60_000)} min`,
          })
          return
        }
      }
    }

    // ── Idempotency short-circuit ─────────────────────────────────────────
    if (idempotencyCache.has(idempotencyKey)) {
      const platformMsgId = idempotencyCache.get(idempotencyKey)!
      await markSent(job.id, platformMsgId)
      await appendAudit({
        adapterId,
        kind: "delivery.success",
        at: now,
        conversationKey,
        idempotencyKey,
        message: "idempotency_cache_hit",
      })
      return
    }

    // ── Circuit breaker ───────────────────────────────────────────────────
    if (!breaker.canPass()) {
      await markDeadlettered(job.id, "circuit_open", "Circuit breaker is open")
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "circuit_open",
      })
      return
    }

    // ── Rate limit ────────────────────────────────────────────────────────
    if (!bucket.tryAcquire()) {
      // Defer retry by 1 second (runner will re-pick on next poll)
      const nextAt = now + 1_000
      await markFailed(job.id, "rate_limited", "Token bucket exhausted", nextAt)
      await appendAudit({
        adapterId,
        kind: "rate_limit.tripped",
        at: now,
        conversationKey,
        idempotencyKey,
      })
      return
    }

    // ── Dead-letter gate: max attempts ────────────────────────────────────
    if (job.attempts >= MAX_ATTEMPTS) {
      await markDeadlettered(job.id, "max_attempts", `Exceeded ${MAX_ATTEMPTS} attempts`)
      breaker.recordFailure()
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "max_attempts",
      })
      return
    }

    // ── Send ──────────────────────────────────────────────────────────────
    await markSending(job.id)

    const adapter = opts.adapters.get(adapterId)
    if (!adapter) {
      await markDeadlettered(job.id, "adapter_not_found", `Adapter ${adapterId} not registered`)
      await appendAudit({
        adapterId,
        kind: "delivery.deadlettered",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "adapter_not_found",
      })
      return
    }

    let result: Awaited<ReturnType<PlatformAdapter["send"]>>
    try {
      result = await adapter.send(request)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** job.attempts) + jitter()
      await markFailed(job.id, "network", msg, now + backoff)
      breaker.recordFailure()
      await appendAudit({
        adapterId,
        kind: "delivery.error",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "network",
        message: msg,
      })
      return
    }

    if (result.ok) {
      const platformMsgId = result.platformMessageId ?? idempotencyKey
      await markSent(job.id, platformMsgId)
      breaker.recordSuccess()
      idempotencyCache.set(idempotencyKey, platformMsgId)
      await appendAudit({
        adapterId,
        kind: "delivery.success",
        at: now,
        conversationKey,
        idempotencyKey,
      })
    } else {
      const err = result.error!
      if (err.retryable) {
        const retryAfter = err.retryAfterMs ?? 0
        const backoff =
          Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** job.attempts) + jitter() + retryAfter
        await markFailed(job.id, err.code, err.message, now + backoff)
        breaker.recordFailure()
        await appendAudit({
          adapterId,
          kind: "delivery.error",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
      } else {
        // Non-retryable — dead-letter immediately
        await markDeadlettered(job.id, err.code, err.message)
        breaker.recordFailure()
        await appendAudit({
          adapterId,
          kind: "delivery.deadlettered",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
      }
    }
  }

  // ── Poll loop ─────────────────────────────────────────────────────────────
  while (!opts.signal.aborted) {
    try {
      const job = await pickNextDue()
      if (job) {
        // Task 39: enqueue into the conversation lane for FIFO ordering
        const lane = getLane(job.conversationKey)
        // Capture job id and adapterId for the lane closure
        const { id: jobId, adapterId } = job
        lane.enqueue(() => processJob(jobId, adapterId))
      }
    } catch {
      // Transient DB errors: ignore and retry next poll
    }

    if (opts.signal.aborted) break

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollIntervalMs)
      opts.signal.addEventListener("abort", () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
}
