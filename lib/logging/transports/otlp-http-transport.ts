/**
 * OTLP/HTTP JSON exporter for agent-trace spans.
 *
 * POSTs batches of spans to a configurable endpoint at `/v1/traces` using
 * the OpenTelemetry OTLP/HTTP wire format (Content-Type: application/json).
 * Compatible with Grafana Cloud OTLP, Grafana Tempo, the OpenTelemetry
 * Collector, Honeycomb's OTLP endpoint, Datadog's OTLP intake, etc.
 *
 * Failure model — best-effort: retry transient failures (5xx, network)
 * with exponential backoff up to `maxRetries` then drop the batch. Trace
 * data is observability telemetry, not user-authored content, so dropping
 * on persistent failure is preferable to back-pressuring the renderer.
 *
 * Privacy: respects the same `captureContent` switch as the Dexie
 * transport. When off, strips `inputPreview` / `outputPreview` from each
 * span before serialisation so prompts / tool I/O never leave the process.
 */

import type { StructuredLogEntry, Transport, TransportHealthSnapshot } from "@/types/logging"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import { hasNoLeakingPii } from "@cognia/redact"
import { type OtlpResourceMetadata, spansToOtlp } from "@cognia/agent-trace/span-to-otlp"

const consoleApi = globalThis.console

export interface OtlpHttpTransportOptions {
  /** Registry name when multiple independent OTLP destinations are active. */
  transportName?: string
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
  /** Background flush interval in ms. */
  flushInterval?: number
  /** Retry attempts on transient failure before dropping a batch. */
  maxRetries?: number
  /** Base backoff in ms (doubled each retry up to 30s). */
  retryBaseMs?: number
  /** Capture prompt/tool content. Default false (mirrors Dexie transport). */
  captureContent?: boolean
  /** Per-field byte cap when content capture is on. */
  maxPreviewBytes?: number
  /** Network timeout per request. */
  requestTimeoutMs?: number
  /** Injection seam for tests — swap `fetch` for a mock. */
  fetchImpl?: typeof fetch
  /** Injection seam for tests — control backoff sleep. */
  sleepImpl?: (ms: number) => Promise<void>
}

const DEFAULT_OPTIONS = {
  bufferSize: 32,
  flushInterval: 5_000,
  maxRetries: 3,
  retryBaseMs: 500,
  captureContent: false,
  maxPreviewBytes: 4096,
  requestTimeoutMs: 10_000,
} as const

export class OtlpHttpTransport implements Transport {
  readonly name: string
  private options: Required<
    Omit<
      OtlpHttpTransportOptions,
      "fetchImpl" | "sleepImpl" | "headers" | "resource" | "transportName"
    >
  > & {
    headers: Record<string, string>
    resource: OtlpResourceMetadata
  }
  private buffer: AgentTraceSpan[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private fetchImpl: typeof fetch
  private sleepImpl: (ms: number) => Promise<void>
  private lastSuccessAt: string | undefined
  private lastFailureAt: string | undefined
  private lastError: string | undefined
  private droppedEntries = 0
  private retryCount = 0

  constructor(options: OtlpHttpTransportOptions) {
    this.name = options.transportName ?? "agent-trace-otlp"
    this.options = {
      endpoint: options.endpoint ?? "",
      headers: { ...(options.headers ?? {}) },
      resource: options.resource ?? { serviceName: "cognia-ai" },
      bufferSize: options.bufferSize ?? DEFAULT_OPTIONS.bufferSize,
      flushInterval: options.flushInterval ?? DEFAULT_OPTIONS.flushInterval,
      maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
      retryBaseMs: options.retryBaseMs ?? DEFAULT_OPTIONS.retryBaseMs,
      captureContent: options.captureContent ?? DEFAULT_OPTIONS.captureContent,
      maxPreviewBytes: options.maxPreviewBytes ?? DEFAULT_OPTIONS.maxPreviewBytes,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_OPTIONS.requestTimeoutMs,
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.sleepImpl = options.sleepImpl ?? defaultSleep
    this.startFlushTimer()
  }

  updateOptions(patch: Partial<OtlpHttpTransportOptions>): void {
    if (typeof patch.endpoint === "string") this.options.endpoint = patch.endpoint
    if (patch.headers) this.options.headers = { ...patch.headers }
    if (patch.resource) this.options.resource = patch.resource
    if (typeof patch.bufferSize === "number") this.options.bufferSize = patch.bufferSize
    if (typeof patch.flushInterval === "number") {
      this.options.flushInterval = patch.flushInterval
      this.startFlushTimer()
    }
    if (typeof patch.maxRetries === "number") this.options.maxRetries = patch.maxRetries
    if (typeof patch.retryBaseMs === "number") this.options.retryBaseMs = patch.retryBaseMs
    if (typeof patch.captureContent === "boolean")
      this.options.captureContent = patch.captureContent
    if (typeof patch.maxPreviewBytes === "number")
      this.options.maxPreviewBytes = patch.maxPreviewBytes
    if (typeof patch.requestTimeoutMs === "number")
      this.options.requestTimeoutMs = patch.requestTimeoutMs
    if (patch.fetchImpl) this.fetchImpl = patch.fetchImpl
    if (patch.sleepImpl) this.sleepImpl = patch.sleepImpl
  }

  log(entry: StructuredLogEntry): void {
    const span = extractSpanFromEntry(entry)
    if (!span) return
    if (!this.options.endpoint) return // exporter unconfigured — silently drop
    const sanitized = this.sanitizeSpan(span)
    this.buffer.push(sanitized)
    if (this.buffer.length >= this.options.bufferSize) {
      void this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    if (!this.options.endpoint) {
      this.droppedEntries += this.buffer.length
      this.buffer = []
      return
    }
    const batch = this.buffer
    this.buffer = []
    await this.exportBatch(batch)
  }

  getPendingCount(): number {
    return this.buffer.length
  }

  /** Consent withdrawal path: drop buffered spans without invoking the exporter. */
  discardPending(): void {
    this.droppedEntries += this.buffer.length
    this.buffer = []
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
      queueDepth: this.buffer.length,
      retryCount: this.retryCount,
      droppedEntries: this.droppedEntries,
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

  private async exportBatch(batch: AgentTraceSpan[]): Promise<void> {
    const payload = spansToOtlp(batch, this.options.resource)
    const body = JSON.stringify(payload)
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null
        const timeout =
          controller && this.options.requestTimeoutMs > 0
            ? setTimeout(() => controller.abort(), this.options.requestTimeoutMs)
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
        if (timeout) clearTimeout(timeout)
        if (response.ok) {
          this.lastSuccessAt = new Date().toISOString()
          this.lastError = undefined
          return
        }
        // 4xx (excl. 408 / 429) is non-retryable; drop and surface.
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          lastError = new Error(`OTLP rejected with ${response.status}`)
          break
        }
        lastError = new Error(`OTLP transient ${response.status}`)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
      if (attempt < this.options.maxRetries) {
        this.retryCount += 1
        const delay = Math.min(30_000, this.options.retryBaseMs * 2 ** attempt)
        await this.sleepImpl(delay)
      }
    }

    this.droppedEntries += batch.length
    this.lastFailureAt = new Date().toISOString()
    this.lastError = lastError?.message ?? "OTLP export failed"
    consoleApi.warn("agent-trace OTLP export failed", lastError)
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

export function createOtlpHttpTransport(options: OtlpHttpTransportOptions): OtlpHttpTransport {
  return new OtlpHttpTransport(options)
}
