import {
  structuredLogEntriesToOtlpLogs,
  type OtlpLogResourceMetadata,
} from "@cognia/logging/otlp-log-record"
import { recordDrop, type LogDropCounts, type LogDropReason } from "@cognia/logging/types/transport"
import { hasNoLeakingPii } from "@cognia/redact"
import type { StructuredLogEntry, Transport, TransportHealthSnapshot } from "@/types/logging"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"

export interface OtlpLogTransportOptions {
  endpoint: string
  resource?: OtlpLogResourceMetadata
  bufferSize?: number
  maxQueueEntries?: number
  flushInterval?: number
  maxRetries?: number
  retryBaseMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  /** Platform-owned sender selected by the Host/Collector egress policy. */
  fetchImpl: typeof fetch
  sleepImpl?: (milliseconds: number) => Promise<void>
  randomImpl?: () => number
}

const DEFAULT_OPTIONS = {
  bufferSize: 50,
  maxQueueEntries: 5_000,
  flushInterval: 5_000,
  maxRetries: 3,
  retryBaseMs: 500,
  requestTimeoutMs: 10_000,
  maxRequestBytes: 4 * 1024 * 1024,
} as const

export class OtlpLogTransport implements Transport {
  readonly name = "otlp-logs"
  private options: Required<
    Omit<OtlpLogTransportOptions, "fetchImpl" | "sleepImpl" | "randomImpl" | "resource">
  > & {
    resource: OtlpLogResourceMetadata
  }
  private fetchImpl: typeof fetch
  private sleepImpl: (milliseconds: number) => Promise<void>
  private randomImpl: () => number
  private buffer: StructuredLogEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushChain: Promise<void> = Promise.resolve()
  private inFlightCount = 0
  private closed = false
  /**
   * Bumped by {@link discardPending}. Every in-flight step re-checks it, so a
   * batch whose consent was withdrawn mid-retry is abandoned instead of being
   * POSTed after the toggle went off. Mirrors `OtlpHttpTransport`.
   */
  private discardEpoch = 0
  private retryCount = 0
  private droppedEntries = 0
  private droppedByReason: LogDropCounts = {}
  private lastSuccessAt: string | undefined
  private lastFailureAt: string | undefined
  private lastError: string | undefined

  constructor(options: OtlpLogTransportOptions) {
    this.options = {
      endpoint: options.endpoint ?? "",
      resource: options.resource ?? { serviceName: "cognia-renderer" },
      bufferSize: positiveInteger(options.bufferSize, DEFAULT_OPTIONS.bufferSize),
      maxQueueEntries: positiveInteger(options.maxQueueEntries, DEFAULT_OPTIONS.maxQueueEntries),
      flushInterval: nonNegative(options.flushInterval, DEFAULT_OPTIONS.flushInterval),
      maxRetries: nonNegative(options.maxRetries, DEFAULT_OPTIONS.maxRetries),
      retryBaseMs: nonNegative(options.retryBaseMs, DEFAULT_OPTIONS.retryBaseMs),
      requestTimeoutMs: nonNegative(options.requestTimeoutMs, DEFAULT_OPTIONS.requestTimeoutMs),
      maxRequestBytes: positiveInteger(options.maxRequestBytes, DEFAULT_OPTIONS.maxRequestBytes),
    }
    if (typeof options.fetchImpl !== "function") {
      throw new Error("OTLP Logs transport requires a platform-owned sender")
    }
    this.fetchImpl = options.fetchImpl
    this.sleepImpl = options.sleepImpl ?? defaultSleep
    this.randomImpl = options.randomImpl ?? Math.random
    this.startFlushTimer()
  }

  updateOptions(patch: Partial<OtlpLogTransportOptions>): void {
    if (typeof patch.endpoint === "string") this.options.endpoint = patch.endpoint
    if (patch.resource) this.options.resource = patch.resource
    if (patch.bufferSize !== undefined)
      this.options.bufferSize = positiveInteger(patch.bufferSize, this.options.bufferSize)
    if (patch.maxQueueEntries !== undefined)
      this.options.maxQueueEntries = positiveInteger(
        patch.maxQueueEntries,
        this.options.maxQueueEntries
      )
    if (patch.flushInterval !== undefined) {
      this.options.flushInterval = nonNegative(patch.flushInterval, this.options.flushInterval)
      this.startFlushTimer()
    }
    if (patch.maxRetries !== undefined)
      this.options.maxRetries = nonNegative(patch.maxRetries, this.options.maxRetries)
    if (patch.retryBaseMs !== undefined)
      this.options.retryBaseMs = nonNegative(patch.retryBaseMs, this.options.retryBaseMs)
    if (patch.requestTimeoutMs !== undefined)
      this.options.requestTimeoutMs = nonNegative(
        patch.requestTimeoutMs,
        this.options.requestTimeoutMs
      )
    if (patch.maxRequestBytes !== undefined)
      this.options.maxRequestBytes = positiveInteger(
        patch.maxRequestBytes,
        this.options.maxRequestBytes
      )
    if (patch.fetchImpl) this.fetchImpl = patch.fetchImpl
    if (patch.sleepImpl) this.sleepImpl = patch.sleepImpl
    if (patch.randomImpl) this.randomImpl = patch.randomImpl
  }

  log(entry: StructuredLogEntry): void {
    if (isSyntheticAgentTrace(entry)) return
    if (this.closed) {
      this.recordDropped("shutdown-discarded", 1)
      return
    }
    if (!this.options.endpoint) return
    if (this.buffer.length >= this.options.maxQueueEntries) {
      this.buffer.shift()
      this.recordDropped("overflow-evicted", 1)
    }
    this.buffer.push(entry)
    if (this.buffer.length >= this.options.bufferSize) void this.flush()
  }

  async flush(): Promise<void> {
    const next = this.flushChain.then(() => this.flushQueuedBatches())
    this.flushChain = next.catch(() => {})
    return next
  }

  discardPending(): void {
    this.recordDropped("shutdown-discarded", this.buffer.length + this.inFlightCount)
    this.buffer = []
    this.inFlightCount = 0
    this.discardEpoch += 1
  }

  getPendingCount(): number {
    return this.buffer.length + this.inFlightCount
  }

  getHealth(): TransportHealthSnapshot {
    return {
      transport: this.name,
      status: !this.options.endpoint || this.lastError ? "degraded" : "healthy",
      queueDepth: this.getPendingCount(),
      retryCount: this.retryCount,
      droppedEntries: this.droppedEntries,
      droppedByReason: { ...this.droppedByReason },
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    await this.flush()
  }

  private async flushQueuedBatches(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.options.bufferSize)
      const batchEpoch = this.discardEpoch
      this.inFlightCount = batch.length
      try {
        await this.exportBatch(batch, batchEpoch)
      } finally {
        if (batchEpoch === this.discardEpoch) this.inFlightCount = 0
      }
    }
  }

  /**
   * ONE serialization and ONE privacy scan for the batch, which is what every
   * flush costs while nothing is leaking. Per-entry scanning cost N+1 full OTLP
   * serializations per flush on the renderer's log path; the offender is only
   * worth isolating once the batch has actually failed the gate, and halving
   * does that in log(N) passes while still shipping the clean entries beside it.
   */
  private async exportBatch(batch: StructuredLogEntry[], batchEpoch: number): Promise<void> {
    if (batchEpoch !== this.discardEpoch || batch.length === 0) return

    const body = JSON.stringify(structuredLogEntriesToOtlpLogs(batch, this.options.resource))
    if (!hasNoLeakingPii(body)) {
      if (batch.length === 1) {
        this.recordDropped("entry-rejected", 1)
        this.lastFailureAt = new Date().toISOString()
        this.lastError = "OTLP log payload rejected by privacy gate"
        return
      }
      await this.splitBatch(batch, batchEpoch)
      return
    }

    if (utf8ByteLength(body) > this.options.maxRequestBytes) {
      if (batch.length > 1) {
        await this.splitBatch(batch, batchEpoch)
        return
      }
      this.recordDropped("entry-rejected", 1)
      this.lastFailureAt = new Date().toISOString()
      this.lastError = `OTLP log payload exceeds ${this.options.maxRequestBytes} byte limit`
      return
    }
    await this.exportPayload(batch.length, body, batchEpoch)
  }

  private async splitBatch(batch: StructuredLogEntry[], batchEpoch: number): Promise<void> {
    const midpoint = Math.ceil(batch.length / 2)
    await this.exportBatch(batch.slice(0, midpoint), batchEpoch)
    await this.exportBatch(batch.slice(midpoint), batchEpoch)
  }

  private async exportPayload(entryCount: number, body: string, batchEpoch: number): Promise<void> {
    let lastError: Error | undefined
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      // Re-checked per attempt: the whole point is that a discard during a
      // multi-second backoff stops the next POST.
      if (batchEpoch !== this.discardEpoch) return
      const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined
      const timeout =
        controller && this.options.requestTimeoutMs > 0
          ? setTimeout(() => controller.abort(), this.options.requestTimeoutMs)
          : undefined
      try {
        const response = await this.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller?.signal,
        })
        if (response.ok) {
          this.lastSuccessAt = new Date().toISOString()
          this.lastError = undefined
          return
        }
        lastError = new Error(`OTLP Logs rejected with ${response.status}`)
        if (!isRetryableStatus(response.status)) break
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      if (attempt < this.options.maxRetries) {
        this.retryCount += 1
        await this.sleepImpl(jitteredBackoffMs(attempt, this.options.retryBaseMs, this.randomImpl))
      }
    }

    this.recordDropped("ship-failed", entryCount)
    this.lastFailureAt = new Date().toISOString()
    this.lastError = lastError?.message ?? "OTLP Logs export failed"
  }

  private recordDropped(reason: LogDropReason, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.droppedEntries += count
    recordDrop(this.droppedByReason, reason, count)
  }

  private startFlushTimer(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer =
      this.options.flushInterval > 0
        ? setInterval(() => void this.flush(), this.options.flushInterval)
        : null
  }
}

function isSyntheticAgentTrace(entry: StructuredLogEntry): boolean {
  return entry.data?.kind === AGENT_TRACE_SPAN_KIND
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504
}

function jitteredBackoffMs(attempt: number, baseMs: number, random: () => number): number {
  const ceiling = Math.min(30_000, baseMs * 2 ** attempt)
  return Math.max(1, Math.ceil(ceiling * (0.5 + Math.min(1, Math.max(0, random())) * 0.5)))
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function createOtlpLogTransport(options: OtlpLogTransportOptions): OtlpLogTransport {
  return new OtlpLogTransport(options)
}
