/**
 * Observability ring buffer for `applyTwinContext` calls (M6).
 *
 * Twin injection happens implicitly (a character with `twinId` triggers
 * it automatically inside `resolveSendOptions`), so without a log the
 * user has no way to confirm "yes, this turn used my twin profile".
 * This module records the last N invocations so the Settings UI can
 * surface them.
 *
 * In-memory only — there's no value to persisting these across reloads
 * (they're diagnostic-only). Capped at LIMIT entries newest-first.
 */

const LIMIT = 200

export interface TwinInjectLogEntry {
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
}

const buffer: TwinInjectLogEntry[] = []
const subscribers = new Set<(entry: TwinInjectLogEntry) => void>()

export function recordTwinInject(entry: TwinInjectLogEntry): void {
  buffer.unshift(entry)
  if (buffer.length > LIMIT) buffer.length = LIMIT
  for (const fn of subscribers) {
    try {
      fn(entry)
    } catch {
      // Subscriber failures are non-fatal — debugging surfaces shouldn't
      // crash the producer.
    }
  }
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
