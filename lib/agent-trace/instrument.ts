/**
 * `instrumentSpan` — wrap one async operation in an agent-trace span.
 *
 * The emitter is a start/end pair, which is right for work whose two ends are
 * far apart (a chat turn spanning many events). For an ordinary awaited call it
 * is a footgun: every `throw` and every early `return` between the two halves
 * leaks an in-flight span, and `reapStaleSpans` only settles those half an hour
 * later. That is why whole subsystems — retrieval, embeddings, MCP round-trips,
 * plugin execution — had no spans at all: the correct wiring was more work than
 * the instrumentation was worth.
 *
 * This makes it one call. The span always settles, the error path records the
 * error type, and the operation's own result and exception pass through
 * untouched.
 */

import { endSpan, startSpan, type StartSpanInput } from "@cognia/agent-trace/emitter"

export interface InstrumentSpanOptions extends StartSpanInput {
  /** Non-PII attributes for the finished span. */
  metadata?: Record<string, unknown>
}

/** What the operation may report back about its own outcome. */
export interface SpanOutcome {
  /** Merged into the span's metadata at end time. */
  metadata?: Record<string, unknown>
  outputPreview?: string
}

/**
 * Run `operation` inside a span.
 *
 * `operation` receives the span id so it can attach mid-span events or nest
 * children under itself, and may return an `outcome` describing what happened
 * (row counts, byte sizes) — facts that are only known once the work is done.
 *
 * Telemetry never changes control flow: the caller's value is returned as-is
 * and the caller's exception is rethrown after the span is settled.
 */
export async function instrumentSpan<T>(
  options: InstrumentSpanOptions,
  operation: (spanId: string) => Promise<T>,
  describe?: (result: T) => SpanOutcome | undefined
): Promise<T> {
  const { spanId } = startSpan(options)
  try {
    const result = await operation(spanId)
    const outcome = describe?.(result)
    endSpan(spanId, {
      ...(outcome?.metadata ? { metadata: outcome.metadata } : {}),
      ...(outcome?.outputPreview ? { outputPreview: outcome.outputPreview } : {}),
    })
    return result
  } catch (error) {
    endSpan(spanId, {
      errorType: errorTypeOf(error),
      errorMessage: errorMessageOf(error),
    })
    throw error
  }
}

/**
 * The error's constructor name, which is what `error.type` means in OTel — not
 * its message, which is free-form and often carries a path or an identifier.
 */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  if (typeof error === "string") return "Error"
  return "UnknownError"
}

/** Bounded message; long provider errors can embed an entire response body. */
export function errorMessageOf(error: unknown, maxChars = 512): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error)
  return raw.length > maxChars ? raw.slice(0, maxChars) : raw
}
