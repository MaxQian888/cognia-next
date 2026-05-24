"use client"

/**
 * Per-adapter health hook (im-refactored-crayon).
 *
 * Subscribes to BOTH `connectorAudit` (real events) and `connectorHeartbeats`
 * (the periodic filler split out at v51) for `adapterId` over the last
 * `windowMs` (default 24h), merges them, and returns a derived view ready for
 * the Settings → Adapters → Health detail tab. The dot grid interleaves
 * heartbeat "filler" with real delivery/error events, so both streams feed
 * the same `derive-history` helpers — heartbeat rows are structurally
 * `AuditEntry`-compatible so the merge is a plain concat:
 *
 *   - `current`  — latest heartbeat snapshot or classify(latest event)
 *   - `buckets`  — 48 × 30min cells coloured by predominant event
 *   - `lastOk`   — newest delivery.success / inbound.received / running heartbeat
 *   - `lastError`— newest adapter.error / delivery.error / deadlettered
 *
 * Re-derives every time a relevant audit row lands (live query).
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry } from "@/types/connectors/audit"
import type { ConnectorAuditRow } from "@/lib/db/connector-types"
import {
  deriveCurrentState,
  deriveHistory,
  deriveLastError,
  deriveLastOk,
  type HealthBucket,
  type HealthCellState,
} from "@/lib/connectors/health/derive-history"
import { summariseAtGateBlocks, type AtGateStatsSummary } from "@/lib/connectors/at-gate-stats"

export type CircuitBreakerHealth = "closed" | "open" | "half_open"

export interface BreakerHealthSnapshot {
  state: CircuitBreakerHealth
  openedAt: number | null
  failureRate: number
  eventCount: number
}

export interface RateBucketHealthSnapshot {
  available: number
  capacity: number
  refillPerSec: number
  nextRefillAt: number | null
}

export interface UseAdapterHealthResult {
  current: ReturnType<typeof deriveCurrentState>
  buckets: HealthBucket[]
  lastOk?: AuditEntry
  lastError?: AuditEntry
  /** Sum of `pendingOutboundCount` from the newest heartbeat, or 0. */
  pendingOutboundCount: number
  /**
   * Breaker snapshot pulled from the latest heartbeat row's `fields`.
   * `null` when no heartbeat has fired yet or when the runner had not
   * lazy-initialised state for this adapter at heartbeat time.
   */
  breaker: BreakerHealthSnapshot | null
  /**
   * Rate-limit bucket snapshot pulled from the latest heartbeat row's
   * `fields`. Same null semantics as `breaker`.
   */
  rateBucket: RateBucketHealthSnapshot | null
  /**
   * Summary of `inbound.policy_blocked` rows over the same window —
   * how many inbound messages the at-gate dropped and the top reasons.
   * Folded into the existing live-query so the Health panel doesn't have
   * to subscribe a second time.
   */
  atGateBlocks: AtGateStatsSummary
}

export interface UseAdapterHealthOptions {
  /** Override the look-back window (default 24h). */
  windowMs?: number
  /** Override the bucket size (default 30 min). */
  bucketMs?: number
  /** Override the clock (tests). */
  now?: () => number
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

export function useAdapterHealth(
  adapterId: string | null | undefined,
  options: UseAdapterHealthOptions = {}
): UseAdapterHealthResult {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const now = (options.now ?? Date.now)()
  const since = now - windowMs

  const entries = useLiveQuery<AuditEntry[]>(() => {
    if (typeof window === "undefined" || !adapterId) return Promise.resolve([])
    const db = getDb()
    const range: [start: [string, number], end: [string, number]] = [
      [adapterId, since],
      [adapterId, Number.MAX_SAFE_INTEGER],
    ]
    return Promise.all([
      db.connectorAudit.where("[adapterId+at]").between(range[0], range[1]).toArray(),
      db.connectorHeartbeats.where("[adapterId+at]").between(range[0], range[1]).toArray(),
    ]).then(([audit, heartbeats]) => [...audit, ...heartbeats])
  }, [adapterId, since])

  return useMemo(() => {
    const list = entries ?? []
    const buckets = deriveHistory(list, { now, windowMs, bucketMs: options.bucketMs })
    const current = deriveCurrentState(list)
    // Fallback only — the real count comes from the latest heartbeat row's
    // `fields.pendingOutboundCount` below; 0 when no heartbeat has fired yet.
    const pending = 0
    const latestHeartbeat = [...list]
      .filter((e) => e.kind === "adapter.heartbeat")
      .sort((a, b) => b.at - a.at)[0]
    const fields = latestHeartbeat?.fields as Record<string, unknown> | undefined
    const pendingOutboundCount = (fields?.pendingOutboundCount as number | undefined) ?? pending

    const breakerState = fields?.breakerState
    const breaker: BreakerHealthSnapshot | null =
      typeof breakerState === "string" &&
      (breakerState === "closed" || breakerState === "open" || breakerState === "half_open")
        ? {
            state: breakerState,
            openedAt: (fields?.breakerOpenedAt as number | null | undefined) ?? null,
            failureRate: (fields?.breakerFailureRate as number | null | undefined) ?? 0,
            eventCount: (fields?.breakerEventCount as number | null | undefined) ?? 0,
          }
        : null

    const rateCapacity = fields?.rateCapacity
    const rateBucket: RateBucketHealthSnapshot | null =
      typeof rateCapacity === "number"
        ? {
            available: (fields?.rateAvailable as number | undefined) ?? 0,
            capacity: rateCapacity,
            refillPerSec: (fields?.rateRefillPerSec as number | undefined) ?? 0,
            nextRefillAt: (fields?.rateNextRefillAt as number | null | undefined) ?? null,
          }
        : null

    const atGateBlocks = summariseAtGateBlocks(list as ConnectorAuditRow[], {
      now,
      windowMs,
      topN: 3,
    })

    return {
      current,
      buckets,
      lastOk: deriveLastOk(list),
      lastError: deriveLastError(list),
      pendingOutboundCount,
      breaker,
      rateBucket,
      atGateBlocks,
    }
  }, [entries, now, windowMs, options.bucketMs])
}

export type { HealthBucket, HealthCellState }
