/**
 * Pure helper that buckets a stream of `connectorAudit` rows into the cells
 * of the Health Tab's 24 h dot grid (48 cells of 30 minutes each).
 *
 * Cell colour precedence (within one bucket):
 *
 *   1. `adapter.error` / `adapter.reauth_required` / `delivery.deadlettered` /
 *      `inbound.signature_failed`
 *      → `"down"`              (red)
 *   2. `circuit.opened` / `delivery.error` / `rate_limit.tripped` /
 *      any `inbound.deferred_*`
 *      → `"degraded"`          (amber)
 *   3. `adapter.heartbeat` (state === "running") / `delivery.success` /
 *      `inbound.received` / `outbound.enqueued`
 *      → `"running"`           (green)
 *   4. `adapter.heartbeat` (state === "starting")
 *      → `"starting"`          (blue)
 *   5. no events
 *      → `"unknown"`           (grey)
 *
 * The helper is pure (no Dexie reads) so it can be tested in isolation and
 * reused on the server / in workers.
 */

import type { AuditEntry, AuditKind } from "@/types/connectors/audit"

export type HealthCellState = "running" | "starting" | "degraded" | "down" | "unknown"

export interface HealthBucket {
  bucketStart: number
  bucketEnd: number
  state: HealthCellState
  /** Count of events that fed this bucket (debug surfaces show it). */
  eventCount: number
}

export interface DeriveHistoryOptions {
  now: number
  windowMs?: number
  bucketMs?: number
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_BUCKET_MS = 30 * 60 * 1000

function classify(entry: AuditEntry): HealthCellState {
  const kind = entry.kind
  if (
    kind === "adapter.error" ||
    kind === "adapter.reauth_required" ||
    kind === "delivery.deadlettered" ||
    kind === "inbound.signature_failed"
  ) {
    return "down"
  }
  if (
    kind === "circuit.opened" ||
    kind === "delivery.error" ||
    kind === "rate_limit.tripped" ||
    kind === "inbound.deferred_quiet_hours" ||
    kind === "inbound.deferred_muted" ||
    kind === "inbound.deferred_manual_mode" ||
    kind === "inbound.policy_blocked"
  ) {
    return "degraded"
  }
  if (kind === "adapter.heartbeat") {
    const heartbeatState = (entry.fields?.state as string | undefined) ?? "running"
    if (heartbeatState === "starting") return "starting"
    if (heartbeatState === "degraded") return "degraded"
    if (heartbeatState === "down") return "down"
    return "running"
  }
  if (
    kind === "delivery.success" ||
    kind === "inbound.received" ||
    kind === "outbound.enqueued" ||
    kind === "outbound.ai_run_enqueued" ||
    kind === "credential.refreshed" ||
    kind === "circuit.closed" ||
    kind === "adapter.started"
  ) {
    return "running"
  }
  if (kind === "adapter.stopped" || kind === "circuit.half_opened") {
    return "starting"
  }
  // Default: treat unknown kinds as a benign signal of life.
  return "running"
}

const SEVERITY: Record<HealthCellState, number> = {
  down: 4,
  degraded: 3,
  starting: 2,
  running: 1,
  unknown: 0,
}

/**
 * Bucket the given audit entries into a fixed 24h × 30min grid. The output
 * is ordered oldest → newest so the renderer can map array index to column
 * directly.
 */
export function deriveHistory(
  entries: AuditEntry[],
  options: DeriveHistoryOptions
): HealthBucket[] {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS
  const bucketCount = Math.max(1, Math.floor(windowMs / bucketMs))
  const windowStart = options.now - bucketCount * bucketMs

  const buckets: HealthBucket[] = []
  for (let i = 0; i < bucketCount; i++) {
    const start = windowStart + i * bucketMs
    buckets.push({
      bucketStart: start,
      bucketEnd: start + bucketMs,
      state: "unknown",
      eventCount: 0,
    })
  }

  for (const entry of entries) {
    if (entry.at < windowStart || entry.at >= options.now) continue
    const idx = Math.floor((entry.at - windowStart) / bucketMs)
    if (idx < 0 || idx >= bucketCount) continue
    const bucket = buckets[idx]
    bucket.eventCount += 1
    const next = classify(entry)
    if (SEVERITY[next] > SEVERITY[bucket.state]) {
      bucket.state = next
    }
  }

  return buckets
}

/**
 * Find the latest `adapter.heartbeat` row's snapshot OR fall back to the
 * latest state-bearing kind. Used by the Health Tab pill.
 */
export function deriveCurrentState(entries: AuditEntry[]): {
  state: HealthCellState
  reason?: string
  lastActivityAt?: number
  at?: number
} {
  if (entries.length === 0) return { state: "unknown" }
  const sorted = [...entries].sort((a, b) => b.at - a.at)
  for (const entry of sorted) {
    if (entry.kind === "adapter.heartbeat") {
      const fields = entry.fields ?? {}
      const state = (fields.state as HealthCellState | undefined) ?? "running"
      return {
        state,
        reason: fields.reason as string | undefined,
        lastActivityAt: fields.lastActivityAt as number | undefined,
        at: entry.at,
      }
    }
  }
  // No heartbeats — synthesise from the latest classifying event.
  const latest = sorted[0]
  return { state: classify(latest), reason: latest.reason, at: latest.at }
}

/**
 * Find the most recent `adapter.error` / `delivery.error` /
 * `delivery.deadlettered` row, or undefined. The Health tab renders the
 * reason + message in a callout.
 */
export function deriveLastError(entries: AuditEntry[]): AuditEntry | undefined {
  return [...entries]
    .filter(
      (e) =>
        e.kind === "adapter.error" ||
        e.kind === "delivery.error" ||
        e.kind === "delivery.deadlettered" ||
        e.kind === "inbound.signature_failed"
    )
    .sort((a, b) => b.at - a.at)[0]
}

/**
 * Find the most recent `delivery.success` / `inbound.received` /
 * `adapter.heartbeat` (running) row, or undefined.
 */
export function deriveLastOk(entries: AuditEntry[]): AuditEntry | undefined {
  return [...entries]
    .filter((e) => {
      if (e.kind === "delivery.success") return true
      if (e.kind === "inbound.received") return true
      if (e.kind === "adapter.heartbeat") {
        const state = (e.fields?.state as string | undefined) ?? "running"
        return state === "running"
      }
      return false
    })
    .sort((a, b) => b.at - a.at)[0]
}

/** The health reason an adapter reports when the platform rejected its credential. */
export const AUTH_FAILED_HEALTH_REASON = "auth_failed"

/** Events proving the credential works again (or was replaced). */
const REAUTH_CLEARING_KINDS: ReadonlySet<AuditKind> = new Set<AuditKind>([
  "delivery.success",
  "adapter.credentials_rotated",
  "credential.refreshed",
])

/**
 * Decide whether the adapter needs the user to re-authenticate, returning the
 * row that says so (or undefined).
 *
 * Two sources, because a credential can be rejected on either side:
 *   - the adapter's own view: the latest heartbeat carries
 *     `reason: "auth_failed"` (inbound gateway / sync rejections);
 *   - the outbound runner's view: an `adapter.reauth_required` row newer than
 *     the last event that proves the credential works again.
 *
 * A healthy heartbeat does NOT clear the runner's row — several adapters stay
 * "running" on their transport while every send is refused with a 401.
 */
export function deriveReauthRequired(entries: AuditEntry[]): AuditEntry | undefined {
  const sorted = [...entries].sort((a, b) => b.at - a.at)
  const latestHeartbeat = sorted.find((e) => e.kind === "adapter.heartbeat")
  if (
    latestHeartbeat &&
    (latestHeartbeat.fields?.reason ?? latestHeartbeat.reason) === AUTH_FAILED_HEALTH_REASON
  ) {
    return latestHeartbeat
  }
  for (const entry of sorted) {
    if (REAUTH_CLEARING_KINDS.has(entry.kind)) return undefined
    if (entry.kind === "adapter.reauth_required") return entry
  }
  return undefined
}
