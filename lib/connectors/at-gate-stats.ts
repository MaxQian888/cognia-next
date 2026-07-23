/**
 * Aggregate stats over `inbound.policy_blocked` audit rows.
 *
 * `lib/connectors/at-gate.ts:gateInboundEvent` already writes one
 * `inbound.policy_blocked` row per dropped inbound message, with a
 * machine-readable `reason` (`chat_blocklist` / `chat_allowlist` /
 * `at_mention_required` / `at_direct_only`). This module is a pure
 * summariser — no new instrumentation, no schema bumps — that the
 * Health Detail panel (Task 5.3) and any future inbox surfaces consume
 * to render "filtered N inbound messages in the last 24h, top reasons:
 * mention_required (12), allowlist (4)".
 *
 * Pure JS — no Dexie, no React. Caller passes in the audit rows it
 * already has from `useAdapterHealth` (which live-queries a 24h slice
 * filtered by adapterId).
 */

import type { ConnectorAuditRow } from "@/lib/db/connector-types"

export type AtGateBlockReason =
  "chat_blocklist" | "chat_allowlist" | "at_mention_required" | "at_direct_only" | "other"

export interface AtGateBlockReasonCount {
  reason: AtGateBlockReason
  count: number
}

export interface AtGateStatsSummary {
  /** Total `inbound.policy_blocked` rows in the window. */
  total: number
  /** Per-reason histogram, sorted by descending count. */
  byReason: AtGateBlockReasonCount[]
}

const KNOWN_REASONS: ReadonlySet<AtGateBlockReason> = new Set<AtGateBlockReason>([
  "chat_blocklist",
  "chat_allowlist",
  "at_mention_required",
  "at_direct_only",
])

function normaliseReason(value: unknown): AtGateBlockReason {
  if (typeof value === "string" && KNOWN_REASONS.has(value as AtGateBlockReason)) {
    return value as AtGateBlockReason
  }
  return "other"
}

export interface SummariseAtGateBlocksOptions {
  /** Wall-clock window cutoff (ms). Rows older than `now - windowMs` are ignored. */
  windowMs?: number
  /** Override the clock for tests. */
  now?: number
  /** Cap the byReason histogram to top-N reasons; remainder folded into `"other"`. */
  topN?: number
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Summarise `inbound.policy_blocked` rows from the provided audit log.
 *
 * `rows` may contain any audit kinds — the helper filters internally so
 * callers can hand in the same un-narrowed `entries` array
 * `useAdapterHealth` returns.
 */
export function summariseAtGateBlocks(
  rows: ConnectorAuditRow[],
  options: SummariseAtGateBlocksOptions = {}
): AtGateStatsSummary {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const now = options.now ?? Date.now()
  const cutoff = now - windowMs

  const counts = new Map<AtGateBlockReason, number>()
  let total = 0

  for (const row of rows) {
    if (row.kind !== "inbound.policy_blocked") continue
    if (row.at < cutoff) continue
    total++
    const reason = normaliseReason(row.reason)
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }

  const sorted: AtGateBlockReasonCount[] = Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)

  if (options.topN !== undefined && options.topN >= 0 && sorted.length > options.topN) {
    const head = sorted.slice(0, options.topN)
    const tail = sorted.slice(options.topN)
    const otherCount = tail.reduce((acc, r) => acc + r.count, 0)
    if (otherCount > 0) {
      // Fold the tail into a single "other" entry, merging with any
      // pre-existing "other" so we don't emit duplicate buckets.
      const existingOther = head.find((r) => r.reason === "other")
      if (existingOther) {
        existingOther.count += otherCount
      } else {
        head.push({ reason: "other", count: otherCount })
      }
    }
    return { total, byReason: head.sort((a, b) => b.count - a.count) }
  }

  return { total, byReason: sorted }
}
