// Spans repatriated to the renderer instead of exported.
//
// The sidecar's spans used to exist ONLY as OTLP, so a default install —
// which configures no collector — recorded nothing at all for the half of
// every turn that runs out-of-process. The renderer's waterfall showed a
// `chat` span with a multi-second gap in the middle and no way to see inside
// it.

import { randomBytes } from "node:crypto"

import { overlay } from "../../shared/overlay.ts"

/** The `agent_trace_span` frame fields, minus `type`. */
export interface LocalSpan {
  sessionId: unknown
  traceparent: unknown
  spanId: string
  name: string
  operationName: string
  providerName: string
  startTime: number
  endTime: number
  durationMs: number
  attributes: unknown
  errorType?: string
  errorMessage?: string
}

export interface TraceIterableOptions {
  /** Sends one frame to the renderer; without it nothing is measured. */
  emit?: (event: { type: "agent_trace_span" } & LocalSpan) => void
  sessionId?: unknown
  operationName?: string
  providerName?: string
}

/**
 * Random lower-case hex, for a locally-minted span id. `randomUUID` is not
 * usable here: OTLP span ids are 8 bytes, not 16.
 */
export function randomSpanId(): string {
  const bytes = randomBytes(8)
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

/**
 * Emit one finished sidecar span back to the renderer.
 *
 * The `traceparent` is echoed back verbatim rather than parsed here: the
 * renderer minted it and already owns a parser (`lib/agent-trace/trace-context`),
 * so echoing keeps exactly one implementation of the W3C wire format.
 */
function emitLocalSpan(emit: TraceIterableOptions["emit"], span: LocalSpan): void {
  if (typeof emit !== "function") return
  try {
    emit({ type: "agent_trace_span", ...span })
  } catch {
    // A span must never break the stream it was measuring.
  }
}

function errorFields(error: unknown): { errorType: string; errorMessage: string } {
  const failure = error as { name?: unknown; message?: unknown }
  return {
    errorType: failure?.name ? String(failure.name) : "sidecar_error",
    errorMessage: String(failure?.message ?? error),
  }
}

/**
 * Wrap an async iterable so the work it drives is measured and repatriated
 * through `options.emit`. AI SDK spans are exported by the sidecar; manually
 * wrapped Anthropic spans are owned by the renderer so they are never
 * exported twice. With no emitter the iterable is returned untouched, so
 * there is no proxy on the hot path.
 */
export function traceAsyncIterable<I extends AsyncIterable<unknown>>(
  name: string,
  traceparent: unknown,
  attributes: unknown,
  iterable: I,
  options: TraceIterableOptions = {}
): I {
  const localEmit = options.emit
  if (typeof localEmit !== "function") return iterable
  const startTime = Date.now()
  const spanId = randomSpanId()
  let ended = false
  const finish = (error?: unknown): void => {
    if (ended) return
    ended = true
    const endTime = Date.now()
    emitLocalSpan(localEmit, {
      sessionId: options.sessionId,
      traceparent,
      spanId,
      name,
      operationName: options.operationName ?? "invoke_agent",
      providerName: options.providerName ?? "anthropic",
      startTime,
      endTime,
      durationMs: Math.max(0, endTime - startTime),
      attributes,
      ...(error ? errorFields(error) : {}),
    })
  }
  return overlay(iterable, {
    [Symbol.asyncIterator]: async function* () {
      try {
        yield* iterable
        finish()
      } catch (error) {
        finish(error)
        throw error
      } finally {
        finish()
      }
    },
  })
}
