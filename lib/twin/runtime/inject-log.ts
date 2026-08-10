/**
 * Observability ring buffer for `applyTwinContext` calls (M6).
 *
 * Twin injection happens implicitly (a character with `twinId` triggers
 * it automatically inside `resolveSendOptions`), so without a log the
 * user has no way to confirm "yes, this turn used my twin profile".
 * This module records the last N invocations so the Settings UI can
 * surface them.
 *
 * The ring buffer remains the immediate subscription path. A safe, content-free
 * projection is also persisted as an existing `agentTraces` retrieval span so
 * diagnostics survive reloads without retaining prompt text.
 */

import { generateSpanId, generateTraceId } from "@cognia/agent-trace/emitter"
import { insertSpan, queryRecent } from "@/lib/db/agent-traces"
import type { AgentTraceSpan, SpanSurface } from "@/types/agent-trace/span"

const LIMIT = 200

export interface TwinInjectLogEntry {
  /** Stable id shared by the ring entry and persisted span. */
  id?: string
  ts: number
  twinId: string
  /** Optional caller identifier (chat / team / workflow node / connector). */
  source: string
  /** Was the runtime able to produce a non-empty applied result? */
  applied: boolean
  /** Set when the runtime degraded (vector store outage, missing embed key, …). */
  degraded: boolean
  /** Human-readable reason for degradation; null on success. */
  degradedReason: string | null
  /** Number of RAG chunks that landed in the final system prompt. */
  chunkCount: number
  /** Number of style few-shot samples used. */
  styleSampleCount: number
  /** Token approximation of the system prompt that was sent. */
  tokensApprox: number
  /** Retrieval latency measured by the caller. */
  durationMs?: number
  /** Safe retrieval evidence. Text is intentionally not accepted here. */
  chunkIds?: string[]
  chunkScores?: number[]
  styleSampleIds?: string[]
  sessionId?: string
}

const buffer: TwinInjectLogEntry[] = []
const subscribers = new Set<(entry: TwinInjectLogEntry) => void>()

function surfaceFor(source: string): SpanSurface {
  if (source.includes("team")) return "agent-team"
  if (source.includes("workflow")) return "workflow"
  if (source.includes("connector")) return "connector"
  return "chat"
}

function normalizeEntry(entry: TwinInjectLogEntry): TwinInjectLogEntry {
  return {
    ...entry,
    id: entry.id ?? generateSpanId(),
    chunkIds: entry.chunkIds?.slice(0, 50),
    chunkScores: entry.chunkScores?.slice(0, 50),
    styleSampleIds: entry.styleSampleIds?.slice(0, 50),
  }
}

function persistedDegradedReason(reason: string | null): string | null {
  if (!reason) return null
  const code = reason.split(":", 1)[0].trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) ? code : "runtime-degraded"
}

export async function persistTwinInject(entry: TwinInjectLogEntry): Promise<void> {
  const normalized = normalizeEntry(entry)
  const durationMs = Math.max(0, normalized.durationMs ?? 0)
  const spanId = normalized.id!
  const span: AgentTraceSpan = {
    id: spanId,
    traceId: generateTraceId(),
    spanId,
    startTime: normalized.ts - durationMs,
    endTime: normalized.ts,
    durationMs,
    operationName: "retrieval",
    providerName: "cognia.twin",
    sessionId: normalized.sessionId ?? `twin:${normalized.twinId}`,
    surface: surfaceFor(normalized.source),
    agentId: `twin:${normalized.twinId}`,
    metadata: {
      twinId: normalized.twinId,
      source: normalized.source,
      applied: normalized.applied,
      degraded: normalized.degraded,
      degradedReason: persistedDegradedReason(normalized.degradedReason),
      chunkIds: normalized.chunkIds ?? [],
      chunkScores: normalized.chunkScores ?? [],
      styleSampleIds: normalized.styleSampleIds ?? [],
      chunkCount: normalized.chunkCount,
      styleSampleCount: normalized.styleSampleCount,
      tokensApprox: normalized.tokensApprox,
    },
  }
  await insertSpan(span)
}

function entryFromSpan(span: AgentTraceSpan): TwinInjectLogEntry | null {
  if (span.providerName !== "cognia.twin" || span.operationName !== "retrieval") return null
  const meta = span.metadata
  if (typeof meta?.twinId !== "string") return null
  return {
    id: span.id,
    ts: span.endTime ?? span.startTime,
    twinId: meta.twinId,
    source: typeof meta.source === "string" ? meta.source : span.surface,
    applied: meta.applied === true,
    degraded: meta.degraded === true,
    degradedReason: typeof meta.degradedReason === "string" ? meta.degradedReason : null,
    chunkCount: typeof meta.chunkCount === "number" ? meta.chunkCount : 0,
    styleSampleCount: typeof meta.styleSampleCount === "number" ? meta.styleSampleCount : 0,
    tokensApprox: typeof meta.tokensApprox === "number" ? meta.tokensApprox : 0,
    durationMs: span.durationMs ?? 0,
    chunkIds: Array.isArray(meta.chunkIds)
      ? meta.chunkIds.filter((id): id is string => typeof id === "string")
      : [],
    chunkScores: Array.isArray(meta.chunkScores)
      ? meta.chunkScores.filter((score): score is number => typeof score === "number")
      : [],
    styleSampleIds: Array.isArray(meta.styleSampleIds)
      ? meta.styleSampleIds.filter((id): id is string => typeof id === "string")
      : [],
    sessionId: span.sessionId,
  }
}

export async function readPersistedTwinInjectLog(
  twinId: string,
  limit = 50
): Promise<TwinInjectLogEntry[]> {
  const safeLimit = Math.max(0, Math.floor(limit))
  if (!twinId || safeLimit === 0) return []
  const spans = await queryRecent(Math.max(500, safeLimit * 10))
  return spans
    .map(entryFromSpan)
    .filter((entry): entry is TwinInjectLogEntry => entry?.twinId === twinId)
    .slice(0, safeLimit)
}

export async function recordTwinInject(entry: TwinInjectLogEntry): Promise<void> {
  const normalized = normalizeEntry(entry)
  buffer.unshift(normalized)
  if (buffer.length > LIMIT) buffer.length = LIMIT
  for (const fn of subscribers) {
    try {
      fn(normalized)
    } catch {
      // Subscriber failures are non-fatal — debugging surfaces shouldn't
      // crash the producer.
    }
  }
  await persistTwinInject(normalized).catch(() => {
    // Persistence is diagnostic-only and must never break Twin injection.
  })
}

export function readTwinInjectLog(): TwinInjectLogEntry[] {
  return buffer.slice()
}

export function subscribeTwinInjectLog(fn: (entry: TwinInjectLogEntry) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Test-only — clears the buffer + subscribers. */
export function __resetTwinInjectLog(): void {
  buffer.length = 0
  subscribers.clear()
}

export const __TESTING__ = { LIMIT }
