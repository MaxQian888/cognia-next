/**
 * Agent-trace transport.
 *
 * Detects span-shaped `StructuredLogEntry`s (those produced by
 * `lib/agent-trace/span-to-log-entry.ts:spanToLogEntry`) and persists the
 * embedded `AgentTraceSpan` rows to the Dexie `agentTraces` table. Other
 * entries are ignored — this transport is span-only, not a generic log
 * sink.
 *
 * Mirrors the buffer / flushTimer pattern from the IndexedDB transport so
 * the same operational shape (batch size, flush interval, retention) is
 * available without re-inventing the lifecycle.
 *
 * Privacy:
 *  - `captureContent: false` (default) strips `inputPreview` / `outputPreview`
 *    *before* anything is buffered, so opt-in content never lands on disk.
 *  - `captureContent: true` truncates each preview to `maxPreviewBytes` and
 *    passes it through `packages/redact/src/index.ts:hasNoLeakingPii`; spans
 *    whose previews leak PII have that single field dropped (the rest of
 *    the span is still persisted).
 */

import type { StructuredLogEntry, Transport, TransportHealthSnapshot } from "@/types/logging"
import { recordDrop, type LogDropCounts, type LogDropReason } from "@cognia/logging/types/transport"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import { bulkInsertSpans, pruneOlderThan } from "@/lib/db/agent-traces"
import { hasNoLeakingPii } from "@cognia/redact"

const consoleApi = globalThis.console

export interface AgentTraceTransportOptions {
  /** Buffer threshold before an auto-flush is triggered. */
  bufferSize?: number
  /** Background flush interval in ms. */
  flushInterval?: number
  /** Capture `inputPreview` / `outputPreview` payloads. Default false. */
  captureContent?: boolean
  /** Per-field byte cap when content capture is on. Default 4096. */
  maxPreviewBytes?: number
  /**
   * Days of retention. The transport prunes rows older than this on each
   * flush. Set to <= 0 to disable pruning.
   */
  retentionDays?: number
  /** Optional sink override (used in tests to avoid Dexie). */
  writer?: (spans: AgentTraceSpan[]) => Promise<void>
}

const DEFAULT_OPTIONS: Required<Omit<AgentTraceTransportOptions, "writer">> = {
  bufferSize: 32,
  flushInterval: 1_000,
  captureContent: false,
  maxPreviewBytes: 4096,
  retentionDays: 7,
}

export class AgentTraceTransport implements Transport {
  name = "agent-trace"
  private options: Required<Omit<AgentTraceTransportOptions, "writer">>
  private buffer: AgentTraceSpan[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private writer: (spans: AgentTraceSpan[]) => Promise<void>
  private lastSuccessAt: string | undefined
  private lastFailureAt: string | undefined
  private lastError: string | undefined
  private droppedEntries = 0
  /** The same losses, attributed — see `LOG_DROP_REASONS`. */
  private droppedByReason: LogDropCounts = {}

  /**
   * The ONLY way this transport loses an entry. Keeping the total and the
   * per-reason breakdown in one place is what makes them agree — two
   * separate `+=` sites is how they drift.
   */
  private recordDropped(reason: LogDropReason, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.droppedEntries += count
    recordDrop(this.droppedByReason, reason, count)
  }

  private writes = 0

  constructor(options?: AgentTraceTransportOptions) {
    this.options = {
      bufferSize: options?.bufferSize ?? DEFAULT_OPTIONS.bufferSize,
      flushInterval: options?.flushInterval ?? DEFAULT_OPTIONS.flushInterval,
      captureContent: options?.captureContent ?? DEFAULT_OPTIONS.captureContent,
      maxPreviewBytes: options?.maxPreviewBytes ?? DEFAULT_OPTIONS.maxPreviewBytes,
      retentionDays: options?.retentionDays ?? DEFAULT_OPTIONS.retentionDays,
    }
    this.writer = options?.writer ?? bulkInsertSpans
    this.startFlushTimer()
  }

  /** Runtime option updates. Buffer is preserved across calls. */
  updateOptions(options: Partial<AgentTraceTransportOptions>): void {
    if (typeof options.bufferSize === "number") this.options.bufferSize = options.bufferSize
    if (typeof options.flushInterval === "number") {
      this.options.flushInterval = options.flushInterval
      this.startFlushTimer()
    }
    if (typeof options.captureContent === "boolean")
      this.options.captureContent = options.captureContent
    if (typeof options.maxPreviewBytes === "number")
      this.options.maxPreviewBytes = options.maxPreviewBytes
    if (typeof options.retentionDays === "number")
      this.options.retentionDays = options.retentionDays
    if (options.writer) this.writer = options.writer
  }

  log(entry: StructuredLogEntry): void {
    const span = extractSpanFromEntry(entry)
    if (!span) return
    const sanitized = this.sanitizeSpan(span)
    this.buffer.push(sanitized)
    if (this.buffer.length >= this.options.bufferSize) {
      void this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    try {
      await this.writer(batch)
      this.writes += batch.length
      this.lastSuccessAt = new Date().toISOString()
      this.lastError = undefined
      await this.maybePrune()
    } catch (err) {
      this.lastFailureAt = new Date().toISOString()
      this.lastError = err instanceof Error ? err.message : String(err)
      this.recordDropped("ship-failed", batch.length)
      consoleApi.error("agent-trace flush failed", err)
    }
  }

  getPendingCount(): number {
    return this.buffer.length
  }

  getHealth(): TransportHealthSnapshot {
    const status = this.lastError ? "degraded" : "healthy"
    return {
      transport: this.name,
      status,
      queueDepth: this.buffer.length,
      retryCount: 0,
      droppedEntries: this.droppedEntries,
      droppedByReason: { ...this.droppedByReason },
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  /** Strip content fields when capture is off; truncate + PII-gate them when on. */
  private sanitizeSpan(span: AgentTraceSpan): AgentTraceSpan {
    const out: AgentTraceSpan = { ...span }
    if (!this.options.captureContent) {
      delete out.inputPreview
      delete out.outputPreview
      return out
    }
    out.inputPreview = this.sanitizePreview(out.inputPreview)
    out.outputPreview = this.sanitizePreview(out.outputPreview)
    return out
  }

  private sanitizePreview(preview: string | undefined): string | undefined {
    if (typeof preview !== "string" || preview.length === 0) return undefined
    const truncated =
      preview.length > this.options.maxPreviewBytes
        ? preview.slice(0, this.options.maxPreviewBytes)
        : preview
    return hasNoLeakingPii(truncated) ? truncated : undefined
  }

  private startFlushTimer(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.options.flushInterval <= 0) {
      this.flushTimer = null
      return
    }
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.options.flushInterval)
  }

  private async maybePrune(): Promise<void> {
    if (this.options.retentionDays <= 0) return
    if (this.writer !== bulkInsertSpans) return // skip in tests with custom writer
    if (this.writes < this.options.bufferSize * 4) return
    this.writes = 0
    const cutoff = Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000
    try {
      await pruneOlderThan(cutoff)
    } catch (err) {
      consoleApi.warn("agent-trace prune failed", err)
    }
  }
}

/** Pull the embedded `AgentTraceSpan` out of a span-shaped log entry. */
function extractSpanFromEntry(entry: StructuredLogEntry): AgentTraceSpan | null {
  const data = entry.data as Record<string, unknown> | undefined
  if (!data || data.kind !== AGENT_TRACE_SPAN_KIND) return null
  const span = data.span
  if (
    !span ||
    typeof span !== "object" ||
    typeof (span as Record<string, unknown>).id !== "string"
  ) {
    return null
  }
  return span as AgentTraceSpan
}

export function createAgentTraceTransport(
  options?: AgentTraceTransportOptions
): AgentTraceTransport {
  return new AgentTraceTransport(options)
}
