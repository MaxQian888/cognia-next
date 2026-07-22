/**
 * Outbound delivery runner — Tasks 38 & 39.
 *
 * Task 38 primitives:
 *   - Per-adapter circuit breaker: trips when failure rate in a sliding window
 *     exceeds the threshold; re-opens after cooldown. While open, due jobs are
 *     DEFERRED (retry after the cooldown ends) — never dead-lettered for the
 *     breaker alone — and breaker deferrals don't consume attempts.
 *   - Per-adapter token bucket: rate limits outbound send attempts (checked
 *     after the atomic claim so a lost claim never wastes a token; a
 *     rate-limit deferral un-claims and refunds the attempt).
 *   - Exponential back-off with jitter: `min(60 000, 1000 * 2^attempts) + jitter`,
 *     backed by the shared `computeBackoffDelay` from `@cognia/primitives`.
 *   - Idempotency dedupe: an in-memory LRU short-circuits retries when the
 *     platform already acked, backed by row-level delivery evidence
 *     (`platformMessageId` + the indexed `idempotencyKey` column) so a
 *     rebooted runner doesn't re-send what a prior session delivered.
 *   - Dead-letter after 5 attempts.
 *   - Stale-claim recovery: `sending` rows orphaned by a crash (claimed but
 *     never settled) are flipped back to `failed` after a 5-minute grace,
 *     on startup and lazily on every drain pass.
 *
 * Task 39 addition:
 *   - Per-conversation FIFO: lanes serialize jobs claimed in one drain pass,
 *     and a cross-pass guard (`hasOlderActiveOutboundSibling`) skips a due
 *     job while an OLDER non-terminal sibling exists in the same
 *     conversation — so createdAt order holds even when an older job was
 *     deferred to a later pass. Cross-conversation sends run in parallel.
 *
 * Usage:
 *   const controller = new AbortController()
 *   startOutboundRunner({ adapters, signal: controller.signal }).catch(console.error)
 *   // later:
 *   controller.abort()
 */

import type { PlatformAdapter } from "@/types/connectors"
import { createMutex, computeBackoffDelay } from "@cognia/primitives"
import {
  listDueNow,
  peekNextWakeAt,
  subscribeOutboundEnqueued,
  markSending,
  markSent,
  markFailed,
  markDeadlettered,
  enqueueOutbound,
  unclaimSending,
  recoverStaleSendingJobs,
  findDeliveredByIdempotencyKey,
  findOlderActiveOutboundSibling,
} from "@/lib/db/outbound-jobs"
import { getDb } from "@/lib/db/schema"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import type {
  AdapterInstanceRow,
  ConversationOverrideRow,
  OutboundJobRow,
  OutboundTuningConfig,
} from "@/lib/db/connector-types"
import {
  markResponded,
  readForResolution,
  wakeSnoozedConversations,
} from "@/lib/db/conversation-overrides"
import { appendAudit } from "./audit"
import { trackInboxEvent } from "@/lib/telemetry/inbox-events"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { parseConversationKey, buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
} from "./circuit-breaker"
import { createTokenBucket, type TokenBucket, type TokenBucketSnapshot } from "./rate-limit"

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
/**
 * Defer window for muted adapters / conversations. Long mutes are the norm
 * (hours), so re-checking every 5 min is plenty responsive while keeping the
 * defer loop from re-visiting each muted job every minute.
 */
const MUTED_DEFER_MS = 5 * 60_000
/** Throttle for drain-pass error audits — one audit row per minute at most. */
const DRAIN_ERROR_AUDIT_THROTTLE_MS = 60_000
/** Pseudo adapter id for runner-level (not adapter-attributable) audit rows. */
const RUNNER_AUDIT_ADAPTER_ID = "__outbound_runner__"
/**
 * Safety-net ceiling on how long the wake-driven loop sleeps when nothing is
 * scheduled. The loop is normally woken precisely (enqueue event or the next
 * retry deadline), so this only bounds the worst case if a wake is ever
 * missed — it is NOT a poll interval. Overridable via `pollIntervalMs`.
 */
const DEFAULT_IDLE_CAP_MS = 60_000

// ── Per-bot outbound tuning ──────────────────────────────────────────────────

/**
 * Runner defaults for the per-adapter token bucket + circuit breaker. Any
 * knob an operator leaves unset on `AdapterInstanceRow.outboundTuning`
 * falls back to these values (they match the pre-tuning hardcoded ones, so
 * rows without tuning behave exactly as before).
 */
export const DEFAULT_OUTBOUND_TUNING: Required<OutboundTuningConfig> = {
  rateCapacity: 20,
  rateRefillPerSec: 5,
  breakerWindowMs: 30_000,
  breakerMinEvents: 5,
  breakerFailureThresholdPct: 50,
  breakerCooldownMs: 30_000,
}

/**
 * Fold an operator-supplied tuning block over the defaults, rejecting
 * non-finite / out-of-range knobs individually (a bad knob degrades to its
 * default rather than poisoning the whole block). Exported for the settings
 * UI so form placeholders and the runner agree on the effective values.
 */
export function sanitizeOutboundTuning(
  tuning: OutboundTuningConfig | undefined
): Required<OutboundTuningConfig> {
  const pick = (value: number | undefined, fallback: number, opts?: { max?: number }): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
    if (opts?.max !== undefined && value > opts.max) return fallback
    return value
  }
  return {
    rateCapacity: pick(tuning?.rateCapacity, DEFAULT_OUTBOUND_TUNING.rateCapacity),
    rateRefillPerSec: pick(tuning?.rateRefillPerSec, DEFAULT_OUTBOUND_TUNING.rateRefillPerSec),
    breakerWindowMs: pick(tuning?.breakerWindowMs, DEFAULT_OUTBOUND_TUNING.breakerWindowMs),
    breakerMinEvents: Math.round(
      pick(tuning?.breakerMinEvents, DEFAULT_OUTBOUND_TUNING.breakerMinEvents)
    ),
    breakerFailureThresholdPct: pick(
      tuning?.breakerFailureThresholdPct,
      DEFAULT_OUTBOUND_TUNING.breakerFailureThresholdPct,
      { max: 100 }
    ),
    breakerCooldownMs: pick(tuning?.breakerCooldownMs, DEFAULT_OUTBOUND_TUNING.breakerCooldownMs),
  }
}

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
  // Delegates serialization to the shared async mutex (lib/utils/async-mutex)
  // so the tail-chain pattern lives in one tested place. The lane keeps its
  // fire-and-forget contract: enqueue never rejects (errors are handled inside
  // `work`), so we swallow the mutex result here rather than in the primitive.
  private readonly mutex = createMutex()

  /** Enqueue `work` behind the current tail; resolves when it settles. */
  enqueue(work: () => Promise<void>): Promise<void> {
    return this.mutex.runExclusive(work).catch(() => {
      // Errors are handled inside `work`; lane must not stall on them.
    })
  }
}

// ── Runner options ────────────────────────────────────────────────────────────

export interface OutboundRunnerOptions {
  /**
   * Live adapter lookup. Structurally satisfied by a `Map`, but production
   * callers should pass a getter backed by the bus registry so adapters
   * rebuilt after boot (credential rotation, hot enable) are picked up — a
   * Map snapshotted at boot time delivers through stale instances forever.
   */
  adapters: { get(adapterId: string): PlatformAdapter | undefined }
  /**
   * Idle-sleep ceiling in ms (default 60 000). The loop is event-driven —
   * it wakes on enqueue and at each retry deadline — so this only caps the
   * worst-case sleep if a wake is missed; it is not a poll interval. Named
   * `pollIntervalMs` for backwards compatibility with existing call-sites
   * and tests (which pass a tiny value to tighten the safety net).
   */
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
  /**
   * Fired best-effort after a job is successfully delivered (or served from
   * the idempotency cache), with the delivered conversation key. Production
   * wires this to `ConnectorBus.recordBotReply` so the `cooldown-after-bot-reply`
   * trigger blocker (a default group-chat anti-spam rule) actually has a
   * `lastReplyAt` to read — the bus's policy state has no other writer. Kept
   * as an injected callback so the runner stays decoupled from the bus and
   * unit-testable. Must never throw.
   */
  onDelivered?: (conversationKey: string) => void
}

// ── Per-adapter state ────────────────────────────────────────────────────────

interface AdapterState {
  breaker: CircuitBreaker
  bucket: TokenBucket
  /**
   * Serialized effective tuning this state was built with. When the
   * adapter row's tuning changes mid-run, the runner rebuilds the
   * bucket/breaker pair (dropping their in-flight window — acceptable:
   * a tuning edit is an explicit operator action).
   */
  tuningFingerprint: string
}

// ── Runtime-state registry (heartbeat read-side) ─────────────────────────────

/**
 * Snapshot of the per-adapter outbound runtime state. The heartbeat probe
 * writes this into the `adapter.heartbeat` audit row so the Health Detail
 * panel can render current circuit / rate-limit metadata without holding
 * a reference to the runner.
 */
export interface AdapterRuntimeStateSnapshot {
  breaker: CircuitBreakerSnapshot
  bucket: TokenBucketSnapshot
}

/**
 * The runner singleton publishes its live `adapterState` Map here so the
 * heartbeat (which lives outside the runner closure) can read snapshots
 * without IPC. `null` between runner stop and the next start.
 */
let currentAdapterStateMap: Map<string, AdapterState> | null = null

/**
 * Read a snapshot of the outbound runtime for `adapterId`. Returns `null`
 * when the runner isn't currently running, or when the adapter has not
 * yet produced any outbound activity (lazy-initialised on first send).
 * Callers (e.g., the heartbeat probe, Health Detail panel) should treat
 * `null` as "no data yet" and fall back to neutral defaults in the UI.
 */
export function getAdapterRuntimeStateSnapshot(
  adapterId: string
): AdapterRuntimeStateSnapshot | null {
  if (currentAdapterStateMap === null) return null
  const state = currentAdapterStateMap.get(adapterId)
  if (!state) return null
  return {
    breaker: state.breaker.snapshot(),
    bucket: state.bucket.snapshot(),
  }
}

/** Test-only: drop the runtime-state registry so unit tests don't bleed state. */
export function __resetAdapterRuntimeStateForTesting(): void {
  currentAdapterStateMap = null
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Start the outbound delivery loop. Resolves when `signal` is aborted.
 * Never rejects — all delivery errors are surfaced via audit log.
 */
export async function startOutboundRunner(opts: OutboundRunnerOptions): Promise<void> {
  const idleCapMs = opts.pollIntervalMs ?? DEFAULT_IDLE_CAP_MS
  const clock = opts.now ?? (() => Date.now())
  const jitter = opts.jitter ?? (() => Math.random() * 500)

  const adapterState = new Map<string, AdapterState>()
  // Publish this runner's adapterState to the module-level registry so the
  // heartbeat probe can read circuit / rate-limit snapshots. Cleared on
  // signal abort below.
  currentAdapterStateMap = adapterState
  const idempotencyCache = new LruMap<string, string>(IDEMPOTENCY_LRU_CAP)
  // Task 39: per-conversation FIFO lanes
  const lanes = new Map<string, ConversationLane>()
  // Jobs currently enqueued into a lane but not yet terminal. `markSending`
  // happens late (after the muted/quiet/idempotency/breaker gates), so
  // without this guard a tight drain would re-pick a job that is still
  // `pending` in the DB and double-enqueue it. The lane closure clears the
  // id in a `finally`.
  const inFlight = new Set<string>()
  // Job ids whose mute-deferral has already been audited this run. A long
  // mute defers the same job over and over; auditing each cycle floods the
  // capped audit table, so the audit fires once per job (per runner
  // lifetime). Entries are dropped when the job leaves the muted path.
  const mutedAuditedJobs = new Set<string>()
  // Last time a drain-pass DB error was audited (throttled to once/min so a
  // persistent Dexie failure is visible without flooding the audit table).
  // -Infinity ⇒ the first error always audits, whatever the injected clock.
  let lastDrainErrorAuditAt = -Infinity

  function getAdapterState(adapterId: string, row?: AdapterInstanceRow): AdapterState {
    const tuning = sanitizeOutboundTuning(row?.outboundTuning)
    const fingerprint = JSON.stringify(tuning)
    const existing = adapterState.get(adapterId)
    // Rebuild when the per-bot tuning changed since this state was built,
    // so an operator edit applies on the next delivery without a restart.
    // Callers that pass no row (heartbeat-less paths) reuse whatever state
    // exists rather than resetting it to defaults.
    if (existing && (row === undefined || existing.tuningFingerprint === fingerprint)) {
      return existing
    }
    const state: AdapterState = {
      breaker: createCircuitBreaker({
        windowMs: tuning.breakerWindowMs,
        minEvents: tuning.breakerMinEvents,
        failureThresholdPct: tuning.breakerFailureThresholdPct,
        cooldownMs: tuning.breakerCooldownMs,
        now: clock,
        // v49 breadcrumb — emit on every state transition so the
        // operator can see breaker history in the inbox telemetry
        // export. Also write the matching `circuit.*` audit kind so the
        // Health 24h dot grid (derive-history.ts) actually colours breaker
        // transitions — it reads the audit log, not the telemetry ring, so
        // without this the declared `circuit.*` kinds stayed dead.
        onStateChange: (from, to, at) => {
          if (to === "open") {
            void trackInboxEvent("breaker.open", { adapterId, fields: { from }, at })
          } else if (to === "closed") {
            void trackInboxEvent("breaker.close", { adapterId, fields: { from }, at })
          }
          const auditKind =
            to === "open"
              ? "circuit.opened"
              : to === "half_open"
                ? "circuit.half_opened"
                : "circuit.closed"
          void appendAudit({ adapterId, kind: auditKind, at, fields: { from, to } })
        },
      }),
      bucket: createTokenBucket({
        capacity: tuning.rateCapacity,
        refillPerSec: tuning.rateRefillPerSec,
        now: clock,
      }),
      tuningFingerprint: fingerprint,
    }
    adapterState.set(adapterId, state)
    return state
  }

  function getLane(conversationKey: string): ConversationLane {
    if (!lanes.has(conversationKey)) {
      lanes.set(conversationKey, new ConversationLane())
    }
    return lanes.get(conversationKey)!
  }

  /**
   * Re-enqueue `job` through the first eligible sibling of `fromRow` for
   * one of the two multi-bot reroute mechanisms:
   *
   *   - `"failover"` — this adapter's circuit is open (hard failure).
   *     Candidates come from `failoverAdapterIds`; a sibling qualifies when
   *     its breaker can pass.
   *   - `"balanced"` — this adapter's token bucket is exhausted (throughput
   *     pressure). Candidates come from `balanceAdapterIds`; a sibling
   *     qualifies when its breaker can pass AND its bucket still has send
   *     capacity (an untracked sibling counts as fresh = full bucket).
   *
   * Returns the new job id, or `null` when no sibling qualifies — the
   * caller then falls back to its normal path (dead-letter / defer).
   *
   * The re-enqueued job carries a derived idempotency key (`…:fo:<id>` /
   * `…:lb:<id>`) so it can never collide with the original in the runner's
   * idempotency cache, plus the mechanism's `*FromAdapterId` marker as the
   * shared single-hop guard.
   */
  async function rerouteJob(
    job: OutboundJobRow,
    fromRow: AdapterInstanceRow,
    mechanism: "failover" | "balanced",
    adapterCache?: Map<string, AdapterInstanceRow | undefined>
  ): Promise<string | null> {
    const candidates =
      (mechanism === "failover" ? fromRow.failoverAdapterIds : fromRow.balanceAdapterIds) ?? []
    if (candidates.length === 0) return null
    const now = clock()

    let parsedKey: ReturnType<typeof parseConversationKey>
    try {
      parsedKey = parseConversationKey(job.conversationKey)
    } catch {
      // Malformed key — fall through to the caller's normal path.
      return null
    }

    for (const targetId of candidates) {
      if (!targetId || targetId === job.adapterId) continue
      let targetRow: AdapterInstanceRow | undefined
      if (adapterCache?.has(targetId)) {
        targetRow = adapterCache.get(targetId)
      } else {
        targetRow = await getAdapterInstance(targetId).catch(() => undefined)
        adapterCache?.set(targetId, targetRow)
      }
      if (!targetRow || !targetRow.enabled || targetRow.muted === true) continue
      if (targetRow.type !== fromRow.type) continue
      // Skip a sibling whose own breaker is already open in this runner.
      const knownState = adapterState.get(targetId)
      if (knownState && !knownState.breaker.canPass()) continue
      // Balance additionally requires spare send capacity on the sibling:
      // spilling onto an equally-exhausted bot would just move the queue.
      // An untracked sibling has produced no outbound activity this run —
      // its bucket would initialise full, so it counts as capacity.
      if (mechanism === "balanced" && knownState && knownState.bucket.snapshot().available < 1) {
        continue
      }

      const keySuffix = mechanism === "failover" ? "fo" : "lb"
      const newConversationKey = buildConversationKey(
        parsedKey.platform,
        targetId,
        parsedKey.remoteChatId,
        parsedKey.threadId
      )
      const newJob = await enqueueOutbound({
        adapterId: targetId,
        conversationKey: newConversationKey,
        request: {
          ...job.request,
          conversationRef: { ...job.request.conversationRef, adapterId: targetId },
          metadata: {
            ...job.request.metadata,
            idempotencyKey: `${job.request.metadata.idempotencyKey}:${keySuffix}:${targetId}`,
            ...(mechanism === "failover"
              ? { failoverFromAdapterId: job.adapterId }
              : { balancedFromAdapterId: job.adapterId }),
          },
        },
        source: job.source,
        ...(job.source === "workflow" && job.sourceWorkflow
          ? { sourceWorkflow: job.sourceWorkflow }
          : {}),
      })
      const reasonText = mechanism === "failover" ? "circuit open" : "rate limited"
      // Point the dead-lettered original at the sibling job that now carries
      // the delivery, so `waitForOutboundTerminal` (plugin waitForDelivery /
      // the send node) follows the reroute to the sibling's true terminal
      // status instead of misreading this reroute as a failure.
      await markDeadlettered(
        job.id,
        mechanism,
        `${mechanism === "failover" ? "Failed over" : "Balanced"} to ${targetId} (${reasonText})`,
        { toJobId: newJob.id, mechanism }
      )
      await appendAudit({
        adapterId: job.adapterId,
        kind: mechanism === "failover" ? "delivery.failover" : "delivery.balanced",
        at: now,
        conversationKey: job.conversationKey,
        idempotencyKey: job.request.metadata.idempotencyKey,
        message: `${reasonText} — re-enqueued via ${targetId}`,
        fields:
          mechanism === "failover"
            ? { failoverToAdapterId: targetId, newJobId: newJob.id }
            : { balancedToAdapterId: targetId, newJobId: newJob.id },
      })
      void trackInboxEvent(mechanism === "failover" ? "outbound.failover" : "outbound.balanced", {
        adapterId: job.adapterId,
        conversationKey: job.conversationKey,
        fields: { toAdapterId: targetId, newJobId: newJob.id },
        at: now,
      })
      return newJob.id
    }
    return null
  }

  /**
   * Process a single outbound job. Called inside a conversation lane so
   * ordering is guaranteed within each conversation.
   */
  async function processJob(
    jobId: string,
    adapterId: string,
    // Per-drain caches: jobs batched in one drain pass frequently share an
    // adapter (a busy bot fanning to many conversations) or a conversation
    // (a multi-segment burst). The adapter + override rows are stable across a
    // single sub-second drain, so read each once per pass and reuse — a config
    // change (mute / quiet-hours toggle) lands on the next drain. Omitted by
    // any non-drain caller, which then reads fresh every time (current behaviour).
    adapterCache?: Map<string, AdapterInstanceRow | undefined>,
    overrideCache?: Map<string, ConversationOverrideRow | null>
  ): Promise<void> {
    const now = clock()

    // Re-fetch the job by id to get the latest state (attempts may have been
    // incremented by a prior lane execution for this same job).
    const job = await getDb().outboundQueue.get(jobId)
    if (!job) return // already processed or deleted

    const { conversationKey, request } = job
    const { idempotencyKey } = request.metadata

    // ── Cross-pass FIFO guard ─────────────────────────────────────────────
    // Lanes only serialize jobs claimed in ONE drain pass. When an older
    // sibling in this conversation was deferred to a later pass (retry
    // backoff, quiet hours, breaker cooldown), a newer sibling must not
    // overtake it. Push this job's `nextAttemptAt` out to the blocker's
    // retry time (status untouched) so it re-evaluates right when the older
    // sibling resolves — leaving it "due now" would busy-spin the wake loop.
    const olderSibling = await findOlderActiveOutboundSibling(job).catch(() => undefined)
    if (olderSibling) {
      const blockedUntil = Math.max(now + 1_000, olderSibling.nextAttemptAt)
      await getDb().outboundQueue.update(job.id, { nextAttemptAt: blockedUntil })
      return
    }

    // ── Muted / quiet-hours check ─────────────────────────────────────────
    let adapterRow: AdapterInstanceRow | undefined
    if (adapterCache?.has(adapterId)) {
      adapterRow = adapterCache.get(adapterId)
    } else {
      adapterRow = await getAdapterInstance(adapterId)
      adapterCache?.set(adapterId, adapterRow)
    }
    if (adapterRow) {
      if (adapterRow.muted === true) {
        // Muted: defer (do NOT count as failure). Audit only the FIRST
        // deferral per job — a long mute re-defers the same job every
        // cycle and would otherwise flood the capped audit table.
        await markFailed(job.id, "muted", "Adapter is globally muted", now + MUTED_DEFER_MS)
        if (!mutedAuditedJobs.has(job.id)) {
          mutedAuditedJobs.add(job.id)
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "muted",
            message: "Adapter is globally muted — delivery deferred",
          })
        }
        return
      }

      // Per-conversation override beats adapter default (im-refactored-crayon
      // Phase 1.4). When the operator sets a quiet window on the override
      // row, the runner consults that instead of the adapter-level one so
      // a single Telegram bot can have different on-call windows per chat.
      let convOverride: ConversationOverrideRow | null
      if (overrideCache?.has(conversationKey)) {
        convOverride = overrideCache.get(conversationKey) ?? null
      } else {
        convOverride = (await readForResolution(conversationKey).catch(() => null)) ?? null
        overrideCache?.set(conversationKey, convOverride)
      }
      // Per-conversation mute: same defer-not-fail semantics as the adapter
      // level mute above, scoped to one conversation — the bot keeps
      // delivering everywhere else. Audited once per job, like above.
      if (convOverride?.muted === true) {
        await markFailed(job.id, "muted", "Conversation is muted", now + MUTED_DEFER_MS)
        if (!mutedAuditedJobs.has(job.id)) {
          mutedAuditedJobs.add(job.id)
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "muted",
            message: "Conversation is muted — delivery deferred",
          })
        }
        return
      }

      // Past both mute gates — forget any mute-audit marker so a future
      // re-mute of this (still-undelivered) job audits again.
      mutedAuditedJobs.delete(job.id)

      const effectiveQuietHours = convOverride?.quietHours ?? adapterRow.quietHours
      if (effectiveQuietHours) {
        const { from, to, tz } = effectiveQuietHours
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
          // v49 breadcrumb
          void trackInboxEvent("quiet.deferred", {
            adapterId,
            conversationKey,
            fields: { from, to, tz, deferMs },
            at: now,
          })
          return
        }
      }
    }

    // Per-adapter breaker + bucket, built with (and live-rebuilt on changes
    // to) this bot's `outboundTuning` — the row was just read above.
    const { breaker, bucket } = getAdapterState(adapterId, adapterRow)

    // ── Idempotency short-circuit ─────────────────────────────────────────
    if (idempotencyCache.has(idempotencyKey)) {
      const platformMsgId = idempotencyCache.get(idempotencyKey)!
      await markSent(job.id, platformMsgId)
      try {
        opts.onDelivered?.(conversationKey)
      } catch {
        /* best-effort — cooldown bookkeeping must never break delivery */
      }
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

    // ── Row-evidence dedupe (persistent idempotency) ──────────────────────
    // The LRU above is in-memory only — a rebooted runner starts empty. Two
    // durable evidence sources close (most of) the duplicate window:
    //   1. This row already carries a `platformMessageId` (a prior attempt's
    //      `markSent` landed but the status was later rewound, e.g. an
    //      operator replay): the platform HAS the message — finish the
    //      bookkeeping, never re-send.
    //   2. A sibling row with the same idempotencyKey already delivered
    //      (indexed lookup): serve this row from that evidence, exactly
    //      like an LRU hit.
    // GAP: neither closes the crash window between a successful
    // `adapter.send()` and `markSent` — the ack died with the runner, so no
    // local evidence exists and a retry duplicates. Fully closing it needs
    // platform-side idempotency keys (e.g. Lark message create `uuid`)
    // passed through the adapters; adapters are intentionally untouched here.
    const rowEvidence =
      job.platformMessageId ??
      (await findDeliveredByIdempotencyKey(idempotencyKey, job.id).catch(() => undefined))
        ?.platformMessageId
    if (rowEvidence) {
      await markSent(job.id, rowEvidence)
      idempotencyCache.set(idempotencyKey, rowEvidence)
      try {
        opts.onDelivered?.(conversationKey)
      } catch {
        /* best-effort — cooldown bookkeeping must never break delivery */
      }
      await appendAudit({
        adapterId,
        kind: "delivery.success",
        at: now,
        conversationKey,
        idempotencyKey,
        message: "row_evidence_hit",
      })
      return
    }

    // ── Plugin onConnectorOutbound (observe + veto + transform) ───────────
    // Fires once per job (first attempt only) so a retry reuses the persisted
    // transform without re-dispatching. A `block` drops the job entirely; a
    // `transform` rewrites the segments AFTER passing the fail-closed PII gate
    // (a leaking rewrite is rejected, the original kept). Plugin errors never
    // break delivery.
    if (job.attempts === 0) {
      try {
        let platform = ""
        try {
          platform = parseConversationKey(conversationKey).platform
        } catch {
          platform = ""
        }
        const decision = await getPluginEventHooks().dispatchConnectorDecision(
          "onConnectorOutbound",
          {
            adapterId,
            conversationKey,
            platform,
            segments: request.segments,
            source: job.source,
            idempotencyKey,
          }
        )
        if (decision.action === "block") {
          await getDb().outboundQueue.delete(job.id)
          await appendAudit({
            adapterId,
            kind: "plugin.outbound_blocked",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: decision.reason ?? "plugin_blocked",
          })
          return
        }
        if (decision.action === "transform") {
          const segments = decision.segments as MessageSegment[]
          if (hasNoLeakingPiiDeep(segments)) {
            request.segments = segments
            await getDb().outboundQueue.update(job.id, { request })
            await appendAudit({
              adapterId,
              kind: "plugin.outbound_transformed",
              at: now,
              conversationKey,
              idempotencyKey,
            })
          } else {
            await appendAudit({
              adapterId,
              kind: "plugin.transform_pii_blocked",
              at: now,
              conversationKey,
              idempotencyKey,
              reason: "outbound_transform_pii",
            })
          }
        }
      } catch (err) {
        console.error("[outbound-runner] onConnectorOutbound dispatch failed", err)
      }
    }

    // ── Circuit breaker ───────────────────────────────────────────────────
    if (!breaker.canPass()) {
      // Multi-bot failover: before deferring, try to re-enqueue the payload
      // through an enabled same-platform sibling from this bot's
      // `failoverAdapterIds`. Single hop only — a job that already failed
      // over once (metadata guard) stays put so two open-circuit bots can't
      // ping-pong it forever.
      if (
        adapterRow &&
        request.metadata.failoverFromAdapterId === undefined &&
        request.metadata.balancedFromAdapterId === undefined
      ) {
        const newJobId = await rerouteJob(job, adapterRow, "failover", adapterCache)
        if (newJobId !== null) return
      }
      // An open breaker is a TRANSIENT adapter condition, not a property of
      // this job: DEFER until the cooldown ends (plus jitter so the whole
      // backlog doesn't stampede the half-open probe), never dead-letter.
      // `markFailed` leaves `attempts` untouched, so breaker deferrals
      // don't consume the max-attempts budget; jobs that genuinely exceed
      // it still dead-letter via the max-attempts gate below.
      const cooldownMs = sanitizeOutboundTuning(adapterRow?.outboundTuning).breakerCooldownMs
      const openedAt = breaker.snapshot().openedAt
      const nextAt = Math.max(now + 1_000, (openedAt ?? now) + cooldownMs) + jitter()
      await markFailed(job.id, "circuit_open", "Circuit breaker is open — deferred", nextAt)
      await appendAudit({
        adapterId,
        kind: "delivery.error",
        at: now,
        conversationKey,
        idempotencyKey,
        reason: "circuit_open",
        message: `Circuit breaker is open — deferred ${Math.max(0, Math.round((nextAt - now) / 1000))}s`,
      })
      return
    }

    // ── Dead-letter gate: max attempts ────────────────────────────────────
    // Bookkeeping only — no wire event happened here, so the breaker's
    // failure window is NOT fed (a burst of maxed-out retry jobs must not
    // open the circuit by itself).
    if (job.attempts >= MAX_ATTEMPTS) {
      await markDeadlettered(job.id, "max_attempts", `Exceeded ${MAX_ATTEMPTS} attempts`)
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
    // Atomic claim: if another runner already moved this job out of
    // pending/failed, yield rather than double-send the same message.
    // Claimed BEFORE the token bucket so a lost claim never consumes a
    // rate-limit token.
    const claimed = await markSending(job.id)
    if (!claimed) {
      return
    }

    // ── Rate limit (post-claim) ───────────────────────────────────────────
    if (!bucket.tryAcquire()) {
      // Multi-bot load balancing: before deferring behind the exhausted
      // bucket, try to spill the job onto a same-platform sibling from this
      // bot's `balanceAdapterIds` that still has send capacity. Single hop
      // only (shared guard with failover) so saturated bots can't ping-pong.
      // (`rerouteJob` dead-letters the original with a reroute pointer, so
      // the `sending` claim needs no separate rollback on this path.)
      if (
        adapterRow &&
        request.metadata.failoverFromAdapterId === undefined &&
        request.metadata.balancedFromAdapterId === undefined
      ) {
        const newJobId = await rerouteJob(job, adapterRow, "balanced", adapterCache)
        if (newJobId !== null) return
      }
      // Defer retry by 1 second (the lane-completion wake re-tightens the
      // loop's sleep so the runner re-picks once the deferral elapses).
      // `unclaimSending` refunds the attempt `markSending` charged — a
      // rate-limit deferral is not a delivery attempt.
      const nextAt = now + 1_000
      await unclaimSending(job.id, "rate_limited", "Token bucket exhausted", nextAt)
      await appendAudit({
        adapterId,
        kind: "rate_limit.tripped",
        at: now,
        conversationKey,
        idempotencyKey,
      })
      return
    }

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
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: "unknown",
        outcome: "failed",
        errorCode: "adapter_not_found",
      })
      return
    }

    // Edit-vs-send dispatch. When the request carries an
    // `editTargetMessageId`, route to `adapter.edit()` so the platform
    // updates the existing message in place. Adapters that don't
    // implement `edit()` fall back to `send()` and audit the fallback so
    // the caller can detect "you asked for in-place edit but this
    // platform can't do it".
    let result: Awaited<ReturnType<PlatformAdapter["send"]>>
    const editTargetId = request.editTargetMessageId
    try {
      if (editTargetId && typeof adapter.edit === "function") {
        result = await adapter.edit(editTargetId, request)
      } else {
        if (editTargetId) {
          await appendAudit({
            adapterId,
            kind: "delivery.error",
            at: now,
            conversationKey,
            idempotencyKey,
            reason: "edit_unsupported",
            message: `${adapterId} adapter has no edit() — falling back to send()`,
          })
        }
        result = await adapter.send(request)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const backoff = computeBackoffDelay(job.attempts, {
        baseDelayMs: BASE_BACKOFF_MS,
        maxDelayMs: MAX_BACKOFF_MS,
        jitter: { kind: "absolute", amountMs: jitter },
      })
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
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: adapter.meta.type,
        outcome: "failed",
        errorCode: err instanceof Error ? err.name : "Error",
      })
      return
    }

    if (result.ok) {
      const platformMsgId = result.platformMessageId ?? idempotencyKey
      await markSent(job.id, platformMsgId)
      try {
        opts.onDelivered?.(conversationKey)
      } catch {
        /* best-effort — cooldown bookkeeping must never break delivery */
      }
      breaker.recordSuccess()
      idempotencyCache.set(idempotencyKey, platformMsgId)
      await appendAudit({
        adapterId,
        kind: "delivery.success",
        at: now,
        conversationKey,
        idempotencyKey,
      })
      // Clear the response-SLA deadline now that a reply has gone out (CRM,
      // schema v83). No-op when the conversation has no SLA / override row.
      await markResponded(conversationKey, now).catch(() => undefined)
      // v49 breadcrumb
      void trackInboxEvent("outbound.sent", {
        adapterId,
        conversationKey,
        fields: { jobId: job.id, attempts: job.attempts + 1 },
        at: now,
      })
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: adapter.meta.type,
        outcome: "succeeded",
      })
    } else {
      const err = result.error!
      void trackEvent("connector.message.sent", {
        adapterId,
        platform: adapter.meta.type,
        outcome: "failed",
        errorCode: err.code,
      })
      if (err.retryable) {
        const retryAfter = err.retryAfterMs ?? 0
        const backoff =
          computeBackoffDelay(job.attempts, {
            baseDelayMs: BASE_BACKOFF_MS,
            maxDelayMs: MAX_BACKOFF_MS,
            jitter: { kind: "absolute", amountMs: jitter },
          }) + retryAfter
        await markFailed(job.id, err.code, err.message, now + backoff)
        // Platform rate limiting (429) is back-pressure, not adapter
        // failure: feeding it to the breaker would let a transient 429
        // storm open the circuit and stall the whole backlog.
        if (err.code !== "rate_limited") {
          breaker.recordFailure()
        }
        await appendAudit({
          adapterId,
          kind: "delivery.error",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
        void trackInboxEvent("outbound.failed", {
          adapterId,
          conversationKey,
          fields: { code: err.code, retryable: true, attempts: job.attempts + 1 },
          at: now,
        })
      } else {
        // Non-retryable — dead-letter immediately
        await markDeadlettered(job.id, err.code, err.message)
        if (err.code !== "rate_limited") {
          breaker.recordFailure()
        }
        await appendAudit({
          adapterId,
          kind: "delivery.deadlettered",
          at: now,
          conversationKey,
          idempotencyKey,
          reason: err.code,
          message: err.message,
        })
        void trackInboxEvent("outbound.failed", {
          adapterId,
          conversationKey,
          fields: { code: err.code, retryable: false, attempts: job.attempts + 1 },
          at: now,
        })
      }
    }
  }

  // ── Wake coordination ───────────────────────────────────────────────────
  //
  // The loop sleeps until the next thing that could change what's actionable:
  // a fresh enqueue (external event) or the next retry deadline (timeout). A
  // completed lane also wakes it so a job rescheduled to a sooner deadline
  // (rate-limit 1s defer, etc.) re-tightens the sleep. `pendingWake` guards
  // against a wake that lands between two waits (lost-wakeup). This mirrors
  // the `Notify` + sleep-until-next-deadline shape of the Rust cron daemon.
  let pendingWake = false
  let wakeResolver: (() => void) | null = null
  const wake = (): void => {
    pendingWake = true
    const r = wakeResolver
    wakeResolver = null
    if (r) r()
  }
  const waitForWakeOrTimeout = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (pendingWake || opts.signal.aborted) {
        pendingWake = false
        resolve()
        return
      }
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal.removeEventListener("abort", settle)
        wakeResolver = null
        pendingWake = false
        resolve()
      }
      const timer = setTimeout(settle, ms)
      wakeResolver = settle
      opts.signal.addEventListener("abort", settle, { once: true })
    })

  // Wake on every enqueue (any of the ai-run / manual / workflow / draft
  // paths). Unsubscribed in the `finally` below.
  const unsubscribeEnqueue = subscribeOutboundEnqueued(wake)

  // ── Wake-driven loop ──────────────────────────────────────────────────────
  try {
    while (!opts.signal.aborted) {
      // CRM (v83): reopen snoozed conversations whose snooze window has
      // elapsed, so a snooze wakes on schedule even when no inbound arrives.
      // Runs each loop tick (≤ idle cap); best-effort — a failure here must
      // never stall outbound delivery.
      await wakeSnoozedConversations(clock()).catch(() => undefined)

      // Stale-claim recovery (startup + every pass): flip `sending` rows
      // orphaned by a crashed/reloaded runner (claimed > 5 min ago, never
      // settled) back to `failed` so this drain can retry them. Best-effort;
      // audited per recovered row. `inFlight` jobs are claimed seconds ago
      // and sit safely inside the grace window.
      try {
        const recoveredRows = await recoverStaleSendingJobs(clock())
        for (const row of recoveredRows) {
          await appendAudit({
            adapterId: row.adapterId,
            kind: "delivery.error",
            at: clock(),
            conversationKey: row.conversationKey,
            idempotencyKey: row.idempotencyKey,
            reason: "stale_sending_recovered",
            message: "Recovered a stale sending claim — retrying now",
          }).catch(() => undefined)
        }
      } catch (err) {
        console.error("[outbound-runner] stale-sending recovery failed:", err)
      }

      // Drain everything currently due into per-conversation lanes in one
      // pass. Lanes run concurrently across conversations and FIFO within
      // one; the `inFlight` guard prevents re-enqueuing a job that is still
      // `pending` while its lane spins up.
      try {
        const due = await listDueNow()
        // Per-drain caches shared across all jobs scheduled in this pass so a
        // busy adapter / conversation reads its (stable) adapter + override row
        // once instead of once per job. Recreated each pass → bounded staleness.
        const adapterCache = new Map<string, AdapterInstanceRow | undefined>()
        const overrideCache = new Map<string, ConversationOverrideRow | null>()
        for (const job of due) {
          if (inFlight.has(job.id)) continue
          inFlight.add(job.id)
          const { id: jobId, adapterId, conversationKey } = job
          getLane(conversationKey).enqueue(async () => {
            try {
              await processJob(jobId, adapterId, adapterCache, overrideCache)
            } finally {
              inFlight.delete(jobId)
              // Re-evaluate: the job may have been rescheduled to a sooner
              // deadline than the loop is currently sleeping for.
              wake()
            }
          })
        }
      } catch (err) {
        // Transient DB errors self-heal on the next pass, but a PERSISTENT
        // Dexie failure must be visible: log every occurrence and audit at
        // most once per minute (`adapter.error` under the runner pseudo-id).
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[outbound-runner] drain pass failed:", msg)
        const nowMs = clock()
        if (nowMs - lastDrainErrorAuditAt >= DRAIN_ERROR_AUDIT_THROTTLE_MS) {
          lastDrainErrorAuditAt = nowMs
          await appendAudit({
            adapterId: RUNNER_AUDIT_ADAPTER_ID,
            kind: "adapter.error",
            at: nowMs,
            reason: "drain_failed",
            message: msg,
          }).catch(() => undefined)
        }
      }

      if (opts.signal.aborted) break

      // Sleep until the next future retry deadline, capped by the idle
      // ceiling. `undefined` means nothing is scheduled — sleep the full cap
      // and rely on the enqueue/lane wake to fire sooner.
      let sleepMs = idleCapMs
      try {
        const nextAt = await peekNextWakeAt()
        if (typeof nextAt === "number") {
          sleepMs = Math.max(0, Math.min(idleCapMs, nextAt - clock()))
        }
      } catch {
        // Fall back to the idle cap on a transient read error.
      }

      if (opts.signal.aborted) break
      await waitForWakeOrTimeout(sleepMs)
    }
  } finally {
    unsubscribeEnqueue()
    // Surrender ownership of the runtime-state registry only if we still own
    // it. A second runner instance (test scenarios) may have replaced us
    // while we were running; in that case the registry already points at
    // the newer Map and we must not clobber it back to null.
    if (currentAdapterStateMap === adapterState) {
      currentAdapterStateMap = null
    }
  }
}
