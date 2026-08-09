/**
 * Langfuse log transport.
 *
 * Web and Tauri share one ingestion serializer. Tauri injects credentials in
 * Rust; Web resolves the secret just-in-time and posts the same batch shape.
 */

import type { Transport, StructuredLogEntry, LogLevel } from "@cognia/logging/types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

export interface LangfuseIngestionEvent {
  id: string
  timestamp: string
  type: "trace-create" | "event-create"
  body: Record<string, unknown>
}

export interface LangfuseIngestionBatch {
  batch: LangfuseIngestionEvent[]
}

export interface LangfuseTransportOptions {
  publicKey?: string
  resolveSecretKey?: () => Promise<string | null>
  /** Native path: the caller owns credential injection and HTTP transport. */
  exportBatch?: (batch: LangfuseIngestionBatch) => Promise<void>
  host?: string
  minLevel?: LogLevel
  includeData?: boolean
  includeStack?: boolean
  eventPrefix?: string
  batchSize?: number
  flushInterval?: number
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

const DEFAULT_OPTIONS = {
  minLevel: "warn" as LogLevel,
  includeData: true,
  includeStack: true,
  eventPrefix: "log",
  batchSize: 10,
  flushInterval: 5000,
  requestTimeoutMs: 10_000,
}

function langfuseLevel(level: LogLevel): "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" {
  switch (level) {
    case "trace":
    case "debug":
      return "DEBUG"
    case "info":
      return "DEFAULT"
    case "warn":
      return "WARNING"
    case "error":
    case "fatal":
      return "ERROR"
  }
}

export function buildLangfuseIngestionBatch(
  entries: readonly StructuredLogEntry[],
  options: Pick<LangfuseTransportOptions, "includeData" | "includeStack" | "eventPrefix"> = {}
): LangfuseIngestionBatch {
  const includeData = options.includeData ?? DEFAULT_OPTIONS.includeData
  const includeStack = options.includeStack ?? DEFAULT_OPTIONS.includeStack
  const eventPrefix = options.eventPrefix ?? DEFAULT_OPTIONS.eventPrefix
  const batch: LangfuseIngestionEvent[] = []
  const traces = new Set<string>()

  for (const entry of entries) {
    const traceId = entry.traceId || entry.sessionId || "default"
    if (!traces.has(traceId)) {
      traces.add(traceId)
      batch.push({
        id: `trace:${traceId}`,
        timestamp: entry.timestamp,
        type: "trace-create",
        body: {
          id: traceId,
          timestamp: entry.timestamp,
          name: "cognia.logger",
          ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
          metadata: { source: "logger" },
          tags: ["log"],
        },
      })
    }

    const metadata: Record<string, unknown> = {
      module: entry.module,
      level: entry.level,
      timestamp: entry.timestamp,
    }
    if (includeData && entry.data) metadata.data = entry.data
    if (includeStack && entry.stack) metadata.stack = entry.stack
    if (entry.source) metadata.source = entry.source

    const eventId = entry.id
    batch.push({
      id: eventId,
      timestamp: entry.timestamp,
      type: "event-create",
      body: {
        id: eventId,
        traceId,
        timestamp: entry.timestamp,
        name: `${eventPrefix}.${entry.level}.${entry.module}`,
        input: entry.message,
        metadata,
        level: langfuseLevel(entry.level),
      },
    })
  }

  return { batch }
}

export class LangfuseTransport implements Transport {
  name = "langfuse"
  private readonly options: LangfuseTransportOptions
  private buffer: StructuredLogEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: LangfuseTransportOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, this.options.flushInterval)
  }

  log(entry: StructuredLogEntry): void {
    const minLevel = this.options.minLevel ?? DEFAULT_OPTIONS.minLevel
    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[minLevel]) return
    this.buffer.push(entry)
    if (this.buffer.length >= (this.options.batchSize ?? DEFAULT_OPTIONS.batchSize)) {
      void this.flush()
    }
  }

  private rebuffer(entries: StructuredLogEntry[]): void {
    const capacity = Math.max(0, 100 - this.buffer.length)
    if (capacity > 0) this.buffer.unshift(...entries.slice(0, capacity))
  }

  private async postWebBatch(batch: LangfuseIngestionBatch): Promise<"sent" | "unconfigured"> {
    const publicKey = this.options.publicKey?.trim()
    if (!publicKey) return "unconfigured"
    const secretKey = (await this.options.resolveSecretKey?.())?.trim()
    if (!secretKey) return "unconfigured"

    const host = (this.options.host || "https://cloud.langfuse.com").replace(/\/$/, "")
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? DEFAULT_OPTIONS.requestTimeoutMs
    )
    try {
      const response = await (this.options.fetchFn ?? fetch)(`${host}/api/public/ingestion`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Langfuse ingestion failed with HTTP ${response.status}`)
      return "sent"
    } finally {
      clearTimeout(timeout)
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const entries = this.buffer
    this.buffer = []
    if (!this.options.publicKey?.trim()) return
    const batch = buildLangfuseIngestionBatch(entries, this.options)
    if (!hasNoLeakingPiiDeep(batch)) return

    try {
      if (this.options.exportBatch) {
        await this.options.exportBatch(batch)
      } else {
        await this.postWebBatch(batch)
      }
    } catch {
      this.rebuffer(entries)
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }
}

export function createLangfuseTransport(options?: LangfuseTransportOptions): LangfuseTransport {
  return new LangfuseTransport(options)
}
