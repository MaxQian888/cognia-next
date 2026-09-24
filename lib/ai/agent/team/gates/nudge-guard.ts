/**
 * Pure guards for the team rate-limit-resume nudge (ADR — compaction/nudge).
 * Ported as an algorithm from an external agent-orchestration app: exponential
 * backoff with a 60-min cap + stable jitter, per-member hourly rate limiting,
 * agenda-fingerprint de-duplication, and a busy-signal skip. No clock, no I/O —
 * `now` is always injected so the orchestrator and tests share one behaviour.
 */

import {
  classifyProviderErrorInfo,
  type ProviderErrorMeta,
} from "@cognia/provider-routing/error-classifier"

export type NudgeType = "agenda_sync" | "review_pickup" | "rate_limit_resume"

/** One delivered/scheduled nudge, kept per member for the rate + dedup guards. */
export interface NudgeRecord {
  memberId: string
  type: NudgeType
  fingerprint: string
  generation: number
  sentAt: number
  nextRetryAt: number
}

export interface NudgeDecision {
  allow: boolean
  /** Stable reason code (telemetry / notifier params), never user-facing prose. */
  reason: string
  /** When a retry should be attempted, if the nudge was deferred. */
  nextRetryAt?: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const BASE_BACKOFF_MIN = 10
const MAX_BACKOFF_MIN = 60
const JITTER_MAX_SEC = 5

/** Small deterministic jitter (0..JITTER_MAX_SEC seconds) derived from a seed. */
export function stableJitterMs(seed: string, generation: number): number {
  let h = 0x811c9dc5
  const text = `${seed}:${generation}`
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return (h % (JITTER_MAX_SEC + 1)) * 1000
}

/**
 * Next retry time: `10 * 2^(generation-1)` minutes capped at 60, plus stable
 * jitter. `generation` is 1-based (first attempt → 10 min).
 */
export function computeNextRetryAt(generation: number, now: number, seed: string): number {
  const exp = BASE_BACKOFF_MIN * 2 ** Math.max(0, generation - 1)
  const minutes = Math.min(MAX_BACKOFF_MIN, exp)
  return now + minutes * MINUTE_MS + stableJitterMs(seed, generation)
}

/** Stable fingerprint of a member's current agenda (remaining task ids+statuses). */
export function agendaFingerprint(items: Array<{ id: string; status: string }>): string {
  const sorted = [...items]
    .map((i) => `${i.id}:${i.status}`)
    .sort()
    .join("|")
  let h = 0x811c9dc5
  for (let i = 0; i < sorted.length; i++) {
    h ^= sorted.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(36)
}

export interface CanNudgeArgs {
  memberId: string
  type: NudgeType
  fingerprint: string
  now: number
  /** This member's prior nudge records (any age — the guard windows them). */
  history: NudgeRecord[]
  maxPerHour?: number
  /** Last tool-activity timestamp for the member (busy-signal). */
  lastToolActivityAt?: number
  busyWindowMs?: number
}

/**
 * Decide whether a nudge may be delivered now. Order of guards: a cooldown that
 * hasn't elapsed → defer; a duplicate (same fingerprint already nudged) → skip;
 * the member is busy (recent tool activity) → defer; the hourly cap is hit →
 * defer. Otherwise allow.
 */
export function canNudge(args: CanNudgeArgs): NudgeDecision {
  const {
    memberId,
    type,
    fingerprint,
    now,
    history,
    maxPerHour = 2,
    lastToolActivityAt,
    busyWindowMs = MINUTE_MS,
  } = args
  const mine = history.filter((r) => r.memberId === memberId)

  // 1) An outstanding cooldown for this member/type hasn't elapsed yet.
  const pending = mine.find((r) => r.type === type && r.nextRetryAt > now)
  if (pending) {
    return { allow: false, reason: "cooldown", nextRetryAt: pending.nextRetryAt }
  }

  // 2) Duplicate suppression: already nudged for this exact agenda.
  if (mine.some((r) => r.fingerprint === fingerprint)) {
    return { allow: false, reason: "duplicate" }
  }

  // 3) Busy signal: skip if the member acted recently (it isn't stuck).
  if (
    typeof lastToolActivityAt === "number" &&
    now - lastToolActivityAt < busyWindowMs &&
    type !== "rate_limit_resume" // a known rate-limit cooldown bypasses busy
  ) {
    return { allow: false, reason: "busy", nextRetryAt: lastToolActivityAt + busyWindowMs }
  }

  // 4) Hourly rate cap.
  const recent = mine.filter((r) => now - r.sentAt < HOUR_MS).length
  if (recent >= maxPerHour) {
    const oldest = mine
      .filter((r) => now - r.sentAt < HOUR_MS)
      .reduce((min, r) => Math.min(min, r.sentAt), now)
    return { allow: false, reason: "rate_limited", nextRetryAt: oldest + HOUR_MS }
  }

  return { allow: true, reason: "ok" }
}

/**
 * Parse a caught teammate error for a rate-limit cooldown. Returns the resume
 * delay (ms) when the failure is a rate limit and a Retry-After could be
 * derived, else null. Reuses the shared provider error classifier.
 */
export function parseRateLimitCooldown(
  message: string,
  meta: ProviderErrorMeta = {},
  now: () => number = Date.now
): { retryAfterMs: number } | null {
  const info = classifyProviderErrorInfo(message, meta, now)
  if (info.errorClass !== "rate-limit") return null
  if (typeof info.retryAfterMs !== "number" || info.retryAfterMs <= 0) return null
  return { retryAfterMs: info.retryAfterMs }
}
