/**
 * Agent-trace span persistence (Dexie v55).
 *
 * One row per finished span. The trace transport
 * (`lib/logging/transports/agent-trace-transport.ts`) is the only writer in
 * production; the hooks layer (`hooks/logging/use-agent-trace-logs.ts`,
 * `hooks/agent-trace/use-agent-trace-analytics.ts`) is the only reader.
 * Pattern mirrors `lib/db/session-usage.ts` — small focused functions, all
 * Dexie queries here so the rest of the app never opens the table directly.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { AgentTraceSessionAnalyticsSummary } from "@/types/agent/agent-trace"
import { getDb } from "./schema"

/** Idempotent upsert. The span's `id` is the Dexie primary key. */
export async function insertSpan(span: AgentTraceSpan): Promise<void> {
  if (!span.id) return
  await getDb().agentTraces.put(span)
}

/** Bulk upsert used by the transport's flush. Empty arrays no-op. */
export async function bulkInsertSpans(spans: AgentTraceSpan[]): Promise<void> {
  if (spans.length === 0) return
  await getDb().agentTraces.bulkPut(spans)
}

/** Read spans for one session, newest-first. `limit` defaults to 500. */
export async function queryBySession(sessionId: string, limit = 500): Promise<AgentTraceSpan[]> {
  if (!sessionId) return []
  const rows = await getDb().agentTraces.where("sessionId").equals(sessionId).toArray()
  rows.sort((a, b) => b.startTime - a.startTime)
  return rows.slice(0, Math.max(0, Math.floor(limit)))
}

/** Read the most-recent N spans across every session, newest-first. Used by
 * the unified log panel's Agent Trace merge (see `useAgentTraceAsLogs`).
 * Cardinality is low (≤ low thousands of rows) so a full-table scan + sort
 * is cheaper than maintaining a global `startTime` index. */
export async function queryRecent(limit = 500): Promise<AgentTraceSpan[]> {
  const safeLimit = Math.max(0, Math.floor(limit))
  if (safeLimit === 0) return []
  const rows = await getDb().agentTraces.toArray()
  rows.sort((a, b) => b.startTime - a.startTime)
  return rows.slice(0, safeLimit)
}

/** Read spans whose `startTime` falls in `[since, until]`, oldest-first. Used
 * by the observability dashboard's windowed reads. `until` defaults to "now
 * and later" (no upper bound). Same full-table-scan + client-filter rationale
 * as `aggregateStatsAll` — Dexie has no cheap global `startTime` index and the
 * cardinality is low thousands of rows. */
export async function queryByWindow(opts: {
  since: number
  until?: number
}): Promise<AgentTraceSpan[]> {
  const { since, until } = opts
  const rows = await getDb().agentTraces.toArray()
  const filtered = rows.filter(
    (r) => r.startTime >= since && (until === undefined || r.startTime <= until)
  )
  filtered.sort((a, b) => a.startTime - b.startTime)
  return filtered
}

/** Read all spans for one trace, ordered chronologically (oldest-first) so
 * the trace view can render a proper timeline. */
export async function queryByTrace(traceId: string): Promise<AgentTraceSpan[]> {
  if (!traceId) return []
  const rows = await getDb().agentTraces.where("traceId").equals(traceId).toArray()
  rows.sort((a, b) => a.startTime - b.startTime)
  return rows
}

/** Aggregate session-level stats from persisted spans. Matches the existing
 * `AgentTraceSessionAnalyticsSummary` contract consumed by the chat-side
 * external-agent manager (`hooks/agent-trace/use-agent-trace-analytics.ts`). */
export async function aggregateBySession(
  sessionId: string
): Promise<AgentTraceSessionAnalyticsSummary> {
  const spans = sessionId
    ? await getDb().agentTraces.where("sessionId").equals(sessionId).toArray()
    : []
  return aggregate(spans)
}

/** Aggregate stats across all spans currently persisted. Cheap on the
 * expected cardinality (≤ low thousands of spans per day) and used by the
 * /logs Agent Trace tab's stats bar. */
export async function aggregateAll(): Promise<AgentTraceSessionAnalyticsSummary> {
  const spans = await getDb().agentTraces.toArray()
  return aggregate(spans)
}

/** Richer per-window stats consumed by the agent-trace stats bar — adds
 * token / cache / cost breakdowns + per-model histogram on top of the
 * legacy `AgentTraceSessionAnalyticsSummary`. */
export interface AgentTraceStatsSummary extends AgentTraceSessionAnalyticsSummary {
  totalSpans: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  /** `cacheReadTokens / (inputTokens + cacheReadTokens)` ∈ [0, 1]. 0 when no input tokens recorded. */
  cacheHitRate: number
  errorCount: number
  byModel: Record<
    string,
    { spans: number; inputTokens: number; outputTokens: number; costUsd: number }
  >
  bySurface: Record<string, number>
}

/** Compute the richer stats summary for a span window. The `since` filter
 * is applied client-side because Dexie can't index a global `startTime`
 * cheaply (no compound `startTime`-only index) and the typical cardinality
 * (≤ low thousands of spans) doesn't warrant one. */
export async function aggregateStatsAll(opts?: {
  since?: number
}): Promise<AgentTraceStatsSummary> {
  const rows = await getDb().agentTraces.toArray()
  const filtered =
    typeof opts?.since === "number" ? rows.filter((r) => r.startTime >= opts!.since!) : rows
  return aggregateStats(filtered)
}

/** Same as `aggregateStatsAll` but scoped to one session. */
export async function aggregateStatsBySession(
  sessionId: string,
  opts?: { since?: number }
): Promise<AgentTraceStatsSummary> {
  if (!sessionId) return aggregateStats([])
  const rows = await getDb().agentTraces.where("sessionId").equals(sessionId).toArray()
  const filtered =
    typeof opts?.since === "number" ? rows.filter((r) => r.startTime >= opts!.since!) : rows
  return aggregateStats(filtered)
}

function aggregateStats(spans: AgentTraceSpan[]): AgentTraceStatsSummary {
  const base = aggregate(spans)
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let errorCount = 0
  const byModel: AgentTraceStatsSummary["byModel"] = {}
  const bySurface: Record<string, number> = {}
  for (const s of spans) {
    if (s.usage) {
      totalInputTokens += s.usage.inputTokens
      totalOutputTokens += s.usage.outputTokens
      totalCacheReadTokens += s.usage.cacheReadTokens
      totalCacheCreationTokens += s.usage.cacheCreationTokens
    }
    if (s.errorType || s.errorMessage) errorCount += 1
    const modelKey = s.responseModel ?? s.requestModel ?? "(unknown)"
    const slot = byModel[modelKey] ?? { spans: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
    slot.spans += 1
    if (s.usage) {
      slot.inputTokens += s.usage.inputTokens
      slot.outputTokens += s.usage.outputTokens
    }
    if (typeof s.costUsdEstimate === "number") slot.costUsd += s.costUsdEstimate
    byModel[modelKey] = slot
    bySurface[s.surface] = (bySurface[s.surface] ?? 0) + 1
  }
  const cacheable = totalInputTokens + totalCacheReadTokens
  const cacheHitRate = cacheable > 0 ? totalCacheReadTokens / cacheable : 0
  return {
    ...base,
    totalSpans: spans.length,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    cacheHitRate,
    errorCount,
    byModel,
    bySurface,
  }
}

/** Drop every span for a session — called when the session itself is deleted
 * (mirrors `deleteUsageForSession`). */
export async function deleteSpansForSession(sessionId: string): Promise<void> {
  if (!sessionId) return
  await getDb().agentTraces.where("sessionId").equals(sessionId).delete()
}

/** Prune spans older than `olderThanMs` epoch ms. Cheap full-table scan; we
 * don't expect millions of rows. Returns the count deleted for callers that
 * want to surface "kept N entries" in the UI. */
export async function pruneOlderThan(olderThanMs: number): Promise<number> {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) return 0
  return getDb()
    .agentTraces.filter((row) => row.startTime < olderThanMs)
    .delete()
}

/** Test-only: drop every row. Production code should never call this. */
export async function __clearAgentTracesForTesting(): Promise<void> {
  await getDb().agentTraces.clear()
}

function aggregate(spans: AgentTraceSpan[]): AgentTraceSessionAnalyticsSummary {
  if (spans.length === 0) {
    return {
      totalCost: 0,
      toolCallCount: 0,
      toolFailureCount: 0,
      avgLatencyMs: 0,
      eventTypeCounts: {},
    }
  }

  let totalCost = 0
  let toolCallCount = 0
  let toolFailureCount = 0
  let totalDuration = 0
  let durationSampleCount = 0
  let firstTimestamp = Number.POSITIVE_INFINITY
  let lastTimestamp = Number.NEGATIVE_INFINITY
  const eventTypeCounts: Record<string, number> = {}

  for (const span of spans) {
    if (typeof span.costUsdEstimate === "number") totalCost += span.costUsdEstimate

    if (span.operationName === "execute_tool") {
      toolCallCount += 1
      if (span.errorType || span.errorMessage) toolFailureCount += 1
    }

    if (typeof span.durationMs === "number") {
      totalDuration += span.durationMs
      durationSampleCount += 1
    }

    if (span.startTime < firstTimestamp) firstTimestamp = span.startTime
    const endish = span.endTime ?? span.startTime
    if (endish > lastTimestamp) lastTimestamp = endish

    eventTypeCounts[span.operationName] = (eventTypeCounts[span.operationName] ?? 0) + 1
  }

  return {
    totalCost,
    toolCallCount,
    toolFailureCount,
    avgLatencyMs: durationSampleCount > 0 ? totalDuration / durationSampleCount : 0,
    firstTimestamp: Number.isFinite(firstTimestamp) ? firstTimestamp : undefined,
    lastTimestamp: Number.isFinite(lastTimestamp) ? lastTimestamp : undefined,
    eventTypeCounts,
  }
}
