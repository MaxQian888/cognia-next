/**
 * Langfuse Transport
 *
 * Transport that sends logs to Langfuse for AI observability.
 * Particularly useful for tracking errors and important events in AI workflows.
 */

import type { Transport, StructuredLogEntry, LogLevel } from "../types"

export interface LangfuseTransportOptions {
  /** Langfuse public key */
  publicKey?: string
  /** Langfuse secret key */
  secretKey?: string
  /** Langfuse host URL */
  host?: string
  /** Minimum log level to send to Langfuse */
  minLevel?: LogLevel
  /** Include log data in event metadata */
  includeData?: boolean
  /** Include stack traces in event metadata */
  includeStack?: boolean
  /** Custom event name prefix */
  eventPrefix?: string
  /** Batch size before flushing */
  batchSize?: number
  /** Flush interval in milliseconds */
  flushInterval?: number
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

const DEFAULT_OPTIONS: LangfuseTransportOptions = {
  minLevel: "warn",
  includeData: true,
  includeStack: true,
  eventPrefix: "log",
  batchSize: 10,
  flushInterval: 5000,
}

/**
 * Langfuse Transport implementation
 */
export class LangfuseTransport implements Transport {
  name = "langfuse"
  private options: LangfuseTransportOptions
  private buffer: StructuredLogEntry[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private langfuseModule: typeof import("@/lib/ai/observability/langfuse-client") | null = null
  private initialized = false

  constructor(options: LangfuseTransportOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.startFlushTimer()
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return

    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {
        // Silently ignore flush errors
      })
    }, this.options.flushInterval)
  }

  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return this.langfuseModule !== null

    try {
      this.langfuseModule = await import("@/lib/ai/observability/langfuse-client")
      this.initialized = true
      return true
    } catch {
      this.initialized = true
      return false
    }
  }

  log(entry: StructuredLogEntry): void {
    // Check if we should log this level
    const minLevel = this.options.minLevel || "warn"
    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[minLevel]) {
      return
    }

    // Add to buffer
    this.buffer.push(entry)

    // Flush if buffer is full
    if (this.buffer.length >= (this.options.batchSize || 10)) {
      this.flush().catch(() => {
        // Silently ignore errors
      })
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return

    const entries = [...this.buffer]
    this.buffer = []

    const hasModule = await this.ensureInitialized()
    if (!hasModule || !this.langfuseModule) return

    try {
      const { getLangfuse, createChatTrace, createSpan } = this.langfuseModule
      const langfuse = await getLangfuse({
        publicKey: this.options.publicKey,
        secretKey: this.options.secretKey,
        host: this.options.host,
        enabled: true,
        flushInterval: this.options.flushInterval,
      })

      if (!langfuse) return

      // Group entries by trace ID for better organization
      const entriesByTrace = new Map<string, StructuredLogEntry[]>()
      for (const entry of entries) {
        const traceKey = entry.traceId || entry.sessionId || "default"
        const existing = entriesByTrace.get(traceKey) || []
        existing.push(entry)
        entriesByTrace.set(traceKey, existing)
      }

      // Create a trace for each group
      for (const [traceKey, traceEntries] of entriesByTrace) {
        const trace = await createChatTrace({
          sessionId: traceKey,
          metadata: {
            source: "logger",
            entryCount: traceEntries.length,
          },
          tags: ["log"],
        })

        // Create spans for each log entry
        for (const entry of traceEntries) {
          const metadata: Record<string, unknown> = {
            module: entry.module,
            level: entry.level,
            timestamp: entry.timestamp,
          }

          if (this.options.includeData && entry.data) {
            metadata.data = entry.data
          }

          if (this.options.includeStack && entry.stack) {
            metadata.stack = entry.stack
          }

          if (entry.source) {
            metadata.source = entry.source
          }

          const spanName = `${this.options.eventPrefix || "log"}.${entry.level}.${entry.module}`

          const span = createSpan(trace, {
            name: spanName,
            input: entry.message,
            metadata,
            level: this.mapLogLevelToLangfuse(entry.level),
          })

          span.end()
        }

        trace.end()
      }

      // Flush Langfuse client
      await langfuse.flush()
    } catch {
      // Re-add entries to buffer on failure (with limit to prevent memory issues)
      if (this.buffer.length < 100) {
        this.buffer.unshift(...entries)
      }
    }
  }

  private mapLogLevelToLangfuse(level: LogLevel): "DEBUG" | "DEFAULT" | "WARNING" | "ERROR" {
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
      default:
        return "DEFAULT"
    }
  }

  async close(): Promise<void> {
    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Final flush
    await this.flush()
  }
}

/**
 * Create a Langfuse transport with default options
 */
export function createLangfuseTransport(options?: LangfuseTransportOptions): LangfuseTransport {
  return new LangfuseTransport(options)
}
