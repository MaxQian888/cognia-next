/**
 * OpenTelemetry Transport
 *
 * Transport that integrates logs with OpenTelemetry spans for distributed tracing.
 * Automatically attaches trace and span IDs to log entries when available.
 */

import type { Transport, StructuredLogEntry } from "../types"

// Lazy import to avoid bundling issues in browser
let otelApi: typeof import("@opentelemetry/api") | null = null

async function loadOtelApi() {
  if (otelApi) return otelApi
  try {
    otelApi = await import("@opentelemetry/api")
    return otelApi
  } catch {
    return null
  }
}

export interface OtelTransportOptions {
  /** OTLP endpoint associated with this transport */
  endpoint?: string
  /** Service name associated with the transport */
  serviceName?: string
  /** Whether to add logs as span events */
  addAsSpanEvents?: boolean
  /** Minimum log level to add as span events */
  minLevelForSpanEvents?: "trace" | "debug" | "info" | "warn" | "error" | "fatal"
  /** Include log data as span event attributes */
  includeDataInEvents?: boolean
}

const LEVEL_PRIORITY: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

/**
 * Get current OpenTelemetry trace context
 */
export async function getOtelContext(): Promise<{
  traceId?: string
  spanId?: string
} | null> {
  const api = await loadOtelApi()
  if (!api) return null

  const span = api.trace.getActiveSpan()
  if (!span) return null

  const context = span.spanContext()
  return {
    traceId: context.traceId,
    spanId: context.spanId,
  }
}

/**
 * OpenTelemetry Transport implementation
 */
export class OtelTransport implements Transport {
  name = "opentelemetry"
  private options: OtelTransportOptions
  private initialized = false

  constructor(options: OtelTransportOptions = {}) {
    this.options = {
      addAsSpanEvents: true,
      minLevelForSpanEvents: "info",
      includeDataInEvents: true,
      ...options,
    }
  }

  private async ensureInitialized() {
    if (this.initialized) return
    await loadOtelApi()
    this.initialized = true
  }

  log(entry: StructuredLogEntry): void {
    // Fire and forget - don't block on async initialization
    this.logAsync(entry).catch(() => {
      // Silently ignore errors
    })
  }

  private async logAsync(entry: StructuredLogEntry): Promise<void> {
    await this.ensureInitialized()

    const api = otelApi
    if (!api) return

    const span = api.trace.getActiveSpan()
    if (!span) return

    // Check if we should add this log level as a span event
    const minLevel = this.options.minLevelForSpanEvents || "info"
    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[minLevel]) {
      return
    }

    if (this.options.addAsSpanEvents) {
      // Build attributes for the span event
      const attributes: Record<string, string | number | boolean> = {
        "log.level": entry.level,
        "log.module": entry.module,
      }

      if (entry.traceId) {
        attributes["log.traceId"] = entry.traceId
      }

      if (entry.sessionId) {
        attributes["log.sessionId"] = entry.sessionId
      }

      if (this.options.includeDataInEvents && entry.data) {
        try {
          attributes["log.data"] = JSON.stringify(entry.data)
        } catch {
          // Ignore serialization errors
        }
      }

      // Add as span event
      span.addEvent(entry.message, attributes)

      // For errors and fatals, also record as exception
      if (entry.level === "error" || entry.level === "fatal") {
        if (entry.stack) {
          span.recordException({
            name: entry.level.toUpperCase(),
            message: entry.message,
            stack: entry.stack,
          })
        }

        // Set span status to error
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: entry.message,
        })
      }
    }
  }

  async flush(): Promise<void> {
    // No buffering, nothing to flush
  }

  async close(): Promise<void> {
    // Nothing to close
  }
}

/**
 * Create an OpenTelemetry transport with default options
 */
export function createOtelTransport(options?: OtelTransportOptions): OtelTransport {
  return new OtelTransport(options)
}

/**
 * Helper to wrap a function with OpenTelemetry span and logging
 */
export async function withOtelSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const api = await loadOtelApi()
  if (!api) {
    return fn()
  }

  const tracer = api.trace.getTracer("cognia-logger")

  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attributes) {
        span.setAttributes(attributes)
      }
      const result = await fn()
      span.setStatus({ code: api.SpanStatusCode.OK })
      return result
    } catch (error) {
      span.setStatus({
        code: api.SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      if (error instanceof Error) {
        span.recordException(error)
      }
      throw error
    } finally {
      span.end()
    }
  })
}
