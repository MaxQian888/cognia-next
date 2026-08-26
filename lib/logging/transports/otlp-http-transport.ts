/**
 * OTLP/HTTP JSON exporter for agent-trace spans.
 *
 * POSTs batches of spans to a configurable endpoint at `/v1/traces` using
 * the OpenTelemetry OTLP/HTTP wire format (Content-Type: application/json).
 * Compatible with Grafana Cloud OTLP, Grafana Tempo, the OpenTelemetry
 * Collector, Honeycomb's OTLP endpoint, Datadog's OTLP intake, etc.
 *
 * Failure model — best-effort: retry OTLP transient failures and network errors
 * with exponential backoff up to `maxRetries` then drop the batch. Trace
 * data is observability telemetry, not user-authored content, so dropping
 * on persistent failure is preferable to back-pressuring the renderer.
 *
 * Privacy: respects the same `captureContent` switch as the Dexie
 * transport. When off, strips `inputPreview` / `outputPreview` from each
 * span before serialisation so prompts / tool I/O never leave the process.
 */

import type { StructuredLogEntry, Transport, TransportHealthSnapshot } from "@/types/logging"
import { emitLoggerDiagnostic } from "@cognia/logging/core"
import { recordDrop, type LogDropCounts, type LogDropReason } from "@cognia/logging/types/transport"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import { hasNoLeakingPii } from "@cognia/redact"
import { type OtlpResourceMetadata, spansToOtlp } from "@cognia/agent-trace/span-to-otlp"

const OTLP_STRUCTURAL_STRING_FIELDS = new Set([
  "id",
  "traceId",
  "spanId",
  "parentSpanId",
  "startTimeUnixNano",
  "endTimeUnixNano",
  "timeUnixNano",
  "intValue",
])

/** Scan the final OTLP object while excluding protobuf strings that encode numbers or IDs. */
function hasNoLeakingPiiInOtlp(value: unknown, field = ""): boolean {
  if (typeof value === "string") {
    return OTLP_STRUCTURAL_STRING_FIELDS.has(field) || hasNoLeakingPii(value)
  }
  if (Array.isArray(value)) return value.every((item) => hasNoLeakingPiiInOtlp(item))
  if (value && typeof value === "object") {
    return Object.entries(value).every(
      ([key, item]) => hasNoLeakingPii(key) && hasNoLeakingPiiInOtlp(item, key)
    )
  }
  return true
}

export interface OtlpHttpTransportOptions {
  /** Registry name when multiple independent OTLP destinations are active. */
  transportName?: string
  /** Opaque key for detecting a host or credential change on a reused transport. */
  destinationFingerprint?: string
  /** Full OTLP traces endpoint. e.g. `https://otlp-gateway-prod-us-central-0.grafana.net/otlp/v1/traces`
   * or `http://localhost:4318/v1/traces`. Empty string disables the
   * transport (`getHealth().status === "degraded"`). */
  endpoint: string
  /** Extra headers — Authorization is the typical one. Grafana Cloud uses
   * `Authorization: Basic base64("<instanceId>:<token>")`; self-hosted
   * collectors often want `Authorization: Bearer <token>` or no auth. */
  headers?: Record<string, string>
  /** OTLP resource metadata stamped on every batch. */
  resource?: OtlpResourceMetadata
  /** Buffer threshold before auto-flush. */
  bufferSize?: number
  /** Hard in-memory queue bound; oldest spans are evicted under pressure. */
  maxQueueEntries?: number
  /** Background flush interval in ms. */
  flushInterval?: number
  /** Retry attempts on transient failure before dropping a batch. */
  maxRetries?: number
  /** Base backoff in ms (doubled each retry up to 30s). */
  retryBaseMs?: number
  /** Capture prompt/tool content. Default false (mirrors Dexie transport). */
  captureContent?: boolean
  /** Destination policy for independently consenting to content by span role. */
  spanContentPolicy?: (span: AgentTraceSpan) => boolean
  /** Destination-owned semantic filter, evaluated before buffering or dedupe. */
  spanFilter?: (span: AgentTraceSpan) => boolean
  /** Destination serializer; defaults to the backend-neutral OTLP mapping. */
  serializeBatch?: (spans: AgentTraceSpan[], resource: OtlpResourceMetadata) => unknown
  /** Drop repeated immutable span IDs before they can be exported twice. */
  deduplicateSpanIds?: boolean
  /** Per-field byte cap when content capture is on. */
  maxPreviewBytes?: number
  /** Network timeout per request. */
  requestTimeoutMs?: number
  /** Hard UTF-8 byte limit for one serialized request body. */
  maxRequestBytes?: number
  /** Injection seam for tests — swap `fetch` for a mock. */
  fetchImpl?: typeof fetch
  /** Injection seam for tests — control backoff sleep. */
  sleepImpl?: (ms: number) => Promise<void>
  /** Injection seam for retry jitter. */
  randomImpl?: () => number
}

const DEFAULT_OPTIONS = {
  bufferSize: 32,
  maxQueueEntries: 2048,
  flushInterval: 5_000,
  maxRetries: 3,
  retryBaseMs: 500,
  captureContent: false,
  maxPreviewBytes: 4096,
  requestTimeoutMs: 10_000,
  maxRequestBytes: Number.POSITIVE_INFINITY,
} as const

export class OtlpHttpTransport implements Transport {
  readonly name: string
  private options: Required<
    Omit<
      OtlpHttpTransportOptions,
      | "fetchImpl"
      | "sleepImpl"
      | "randomImpl"
      | "headers"
      | "resource"
      | "transportName"
      | "spanContentPolicy"
      | "spanFilter"
      | "serializeBatch"
    >
  > & {
    headers: Record<string, string>
    resource: OtlpResourceMetadata
  }
  private buffer: AgentTraceSpan[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private fetchImpl: typeof fetch
  private sleepImpl: (ms: number) => Promise<void>
  private randomImpl: () => number
  private spanContentPolicy: ((span: AgentTraceSpan) => boolean) | undefined
  private spanFilter: ((span: AgentTraceSpan) => boolean) | undefined
  private serializeBatch: (spans: AgentTraceSpan[], resource: OtlpResourceMetadata) => unknown
  private readonly seenSpanIds = new Map<string, true>()
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
  private retryCount = 0
  private flushChain: Promise<void> = Promise.resolve()
  private readonly activeControllers = new Set<AbortController>()
  private discardEpoch = 0
  private inFlightCount = 0
  private closed = false

  constructor(options: OtlpHttpTransportOptions) {
    this.name = options.transportName ?? "agent-trace-otlp"
    this.options = {
      endpoint: options.endpoint ?? "",
      destinationFingerprint: options.destinationFingerprint ?? "",
      headers: { ...(options.headers ?? {}) },
      resource: options.resource ?? { serviceName: "cognia-ai" },
      bufferSize: options.bufferSize ?? DEFAULT_OPTIONS.bufferSize,
      maxQueueEntries: Math.max(
        1,
        Math.floor(options.maxQueueEntries ?? DEFAULT_OPTIONS.maxQueueEntries)
      ),
      flushInterval: options.flushInterval ?? DEFAULT_OPTIONS.flushInterval,
      maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_OPTIONS.retryBaseMs,
      captureContent: options.captureContent ?? DEFAULT_OPTIONS.captureContent,
      deduplicateSpanIds: options.deduplicateSpanIds ?? false,
      maxPreviewBytes: options.maxPreviewBytes ?? DEFAULT_OPTIONS.maxPreviewBytes,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_OPTIONS.requestTimeoutMs,
      maxRequestBytes: options.maxRequestBytes ?? DEFAULT_OPTIONS.maxRequestBytes,
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.sleepImpl = options.sleepImpl ?? defaultSleep
    this.randomImpl = options.randomImpl ?? Math.random
    this.spanContentPolicy = options.spanContentPolicy
    this.spanFilter = options.spanFilter
    this.serializeBatch = options.serializeBatch ?? spansToOtlp
    this.startFlushTimer()
  }

  updateOptions(patch: Partial<OtlpHttpTransportOptions>): void {
    if (
      typeof patch.destinationFingerprint === "string" &&
      patch.destinationFingerprint !== this.options.destinationFingerprint
    ) {
      this.discardPending()
      this.options.destinationFingerprint = patch.destinationFingerprint
    }
    if (typeof patch.endpoint === "string") this.options.endpoint = patch.endpoint
    if (patch.headers) this.options.headers = { ...patch.headers }
    if (patch.resource) this.options.resource = patch.resource
    if (typeof patch.bufferSize === "number") this.options.bufferSize = patch.bufferSize
    if (typeof patch.maxQueueEntries === "number")
      this.options.maxQueueEntries = Math.max(1, Math.floor(patch.maxQueueEntries))
    if (typeof patch.flushInterval === "number") {
      this.options.flushInterval = patch.flushInterval
      this.startFlushTimer()
    }
    if (typeof patch.maxRetries === "number") this.options.maxRetries = patch.maxRetries
    if (typeof patch.retryBaseMs === "number") this.options.retryBaseMs = patch.retryBaseMs
    if (typeof patch.captureContent === "boolean")
      this.options.captureContent = patch.captureContent
    if (typeof patch.deduplicateSpanIds === "boolean") {
      this.options.deduplicateSpanIds = patch.deduplicateSpanIds
      if (!patch.deduplicateSpanIds) this.seenSpanIds.clear()
    }
    if (typeof patch.maxPreviewBytes === "number")
      this.options.maxPreviewBytes = patch.maxPreviewBytes
    if (typeof patch.requestTimeoutMs === "number")
      this.options.requestTimeoutMs = patch.requestTimeoutMs
    if (typeof patch.maxRequestBytes === "number")
      this.options.maxRequestBytes = patch.maxRequestBytes
    if (patch.fetchImpl) this.fetchImpl = patch.fetchImpl
    if (patch.sleepImpl) this.sleepImpl = patch.sleepImpl
    if (patch.randomImpl) this.randomImpl = patch.randomImpl
    // PRESENCE, not truthiness. These three are the only options whose absence
    // is itself a setting: `bootstrap.ts` re-applies `spanFilter: hasAiExecutionHost
    // ? isNotSidecarAutoObservation : undefined` on every settings change, so a
    // truthiness guard could install a filter but never take it off again — the
    // destination then dropped every `chat` / `execute_tool` span for the rest
    // of the session.
    if ("spanContentPolicy" in patch) this.spanContentPolicy = patch.spanContentPolicy
    if ("spanFilter" in patch) this.spanFilter = patch.spanFilter
    if ("serializeBatch" in patch) this.serializeBatch = patch.serializeBatch ?? spansToOtlp
  }

  log(entry: StructuredLogEntry): void {
    const span = extractSpanFromEntry(entry)
    if (!span) return
    if (this.spanFilter && !this.spanFilter(span)) return
    if (this.closed) {
      this.recordDropped("shutdown-discarded", 1)
      return
    }
    if (!this.options.endpoint) return // exporter unconfigured — silently drop
    if (this.options.deduplicateSpanIds) {
      const dedupeKey = `${span.traceId}:${span.spanId}`
      if (this.seenSpanIds.has(dedupeKey)) {
        this.recordDropped("entry-rejected", 1)
        return
      }
      this.seenSpanIds.set(dedupeKey, true)
      if (this.seenSpanIds.size > 50_000) {
        const oldest = this.seenSpanIds.keys().next().value
        if (oldest) this.seenSpanIds.delete(oldest)
      }
    }
    const sanitized = this.sanitizeSpan(span)
    if (this.buffer.length >= this.options.maxQueueEntries) {
      this.buffer.shift()
      this.recordDropped("overflow-evicted", 1)
    }
    this.buffer.push(sanitized)
    if (this.buffer.length >= this.options.bufferSize) {
      void this.flush()
    }
  }

  async flush(): Promise<void> {
    const next = this.flushChain.then(() => this.flushQueuedBatches())
    this.flushChain = next.catch(() => {})
    return next
  }

  private async flushQueuedBatches(): Promise<void> {
    if (this.buffer.length === 0) return
    if (!this.options.endpoint) {
      this.recordDropped("ship-failed", this.buffer.length)
      this.buffer = []
      return
    }
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

  getPendingCount(): number {
    return this.buffer.length + this.inFlightCount
  }

  /** Consent withdrawal path: drop buffered spans without invoking the exporter. */
  discardPending(): void {
    this.discardEpoch += 1
    this.recordDropped("shutdown-discarded", this.buffer.length + this.inFlightCount)
    this.buffer = []
    this.inFlightCount = 0
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
  }

  getHealth(): TransportHealthSnapshot {
    const status: TransportHealthSnapshot["status"] = !this.options.endpoint
      ? "degraded"
      : this.lastError
        ? "degraded"
        : "healthy"
    return {
      transport: this.name,
      status,
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
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  private async exportBatch(batch: AgentTraceSpan[], batchEpoch: number): Promise<void> {
    if (batchEpoch !== this.discardEpoch) return
    const payload = this.serializeBatch(batch, this.options.resource)
    const body = JSON.stringify(payload)
    if (!hasNoLeakingPiiInOtlp(payload)) {
      this.recordDropped("entry-rejected", batch.length)
      this.lastFailureAt = new Date().toISOString()
      this.lastError = "OTLP payload rejected by privacy gate"
      return
    }
    if (utf8ByteLength(body) > this.options.maxRequestBytes) {
      if (batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2)
        await this.exportBatch(batch.slice(0, midpoint), batchEpoch)
        await this.exportBatch(batch.slice(midpoint), batchEpoch)
        return
      }
      this.recordDropped("entry-rejected", 1)
      this.lastFailureAt = new Date().toISOString()
      this.lastError = `OTLP payload exceeds ${this.options.maxRequestBytes} byte limit`
      return
    }
    await this.exportPayload(batch, body, batchEpoch)
  }

  private async exportPayload(
    batch: AgentTraceSpan[],
    body: string,
    batchEpoch: number
  ): Promise<void> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (batchEpoch !== this.discardEpoch) return
      let controller: AbortController | null = null
      let timeout: ReturnType<typeof setTimeout> | null = null
      try {
        const requestController =
          typeof AbortController !== "undefined" ? new AbortController() : null
        controller = requestController
        if (controller) this.activeControllers.add(controller)
        timeout =
          requestController && this.options.requestTimeoutMs > 0
            ? setTimeout(() => requestController.abort(), this.options.requestTimeoutMs)
            : null
        const response = await this.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.options.headers,
          },
          body,
          ...(controller ? { signal: controller.signal } : {}),
        })
        if (batchEpoch !== this.discardEpoch) return
        if (response.ok) {
          this.lastSuccessAt = new Date().toISOString()
          this.lastError = undefined
          return
        }
        if (!isRetryableOtlpStatus(response.status)) {
          lastError = new Error(`OTLP rejected with ${response.status}`)
          break
        }
        lastError = new Error(`OTLP transient ${response.status}`)
        if (attempt < this.options.maxRetries) {
          this.retryCount += 1
          await this.sleepImpl(
            retryDelayMs(
              response.headers.get("Retry-After"),
              attempt,
              this.options,
              this.randomImpl
            )
          )
        }
      } catch (err) {
        if (batchEpoch !== this.discardEpoch) return
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < this.options.maxRetries) {
          this.retryCount += 1
          await this.sleepImpl(
            jitteredBackoffMs(attempt, this.options.retryBaseMs, this.randomImpl)
          )
        }
      } finally {
        if (timeout) clearTimeout(timeout)
        if (controller) this.activeControllers.delete(controller)
      }
    }

    if (batchEpoch !== this.discardEpoch) return
    this.recordDropped("ship-failed", batch.length)
    this.lastFailureAt = new Date().toISOString()
    this.lastError = lastError?.message ?? "OTLP export failed"
    emitLoggerDiagnostic({
      code: "otlp.trace.export.failed",
      message: "Agent Trace OTLP export failed.",
      level: "warn",
      sourceTransport: this.name,
      data: {
        error: this.lastError,
        droppedSpans: batch.length,
      },
    })
  }

  private sanitizeSpan(span: AgentTraceSpan): AgentTraceSpan {
    const out: AgentTraceSpan = { ...span }
    delete out.errorMessage
    delete out.metadata
    delete out.events
    delete out.agentName
    if (out.handoff) {
      out.handoff = { fromAgent: out.handoff.fromAgent, toAgent: out.handoff.toAgent }
    }
    const captureContent = this.spanContentPolicy
      ? this.spanContentPolicy(span)
      : this.options.captureContent
    if (!captureContent) {
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
}

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isRetryableOtlpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

function jitteredBackoffMs(attempt: number, baseMs: number, random: () => number): number {
  const ceiling = Math.min(30_000, baseMs * 2 ** attempt)
  return Math.max(1, Math.ceil(ceiling * (0.5 + Math.min(1, Math.max(0, random())) * 0.5)))
}

function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  options: { retryBaseMs: number },
  random: () => number
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    const parsed = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(30_000, Math.ceil(parsed))
  }
  return jitteredBackoffMs(attempt, options.retryBaseMs, random)
}

export function createOtlpHttpTransport(options: OtlpHttpTransportOptions): OtlpHttpTransport {
  return new OtlpHttpTransport(options)
}
