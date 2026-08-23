import {
  endSpan,
  getAgentTraceWriter,
  setAgentTraceWriter,
  spansToOtlp,
  startSpan,
  type AgentTraceSpan,
  type AgentTraceWriter,
  type StartSpanInput,
} from "@cognia/agent-trace"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

/** How many finished spans stay available for `trace/export`. */
export const DEFAULT_SPAN_BUFFER = 2_048

export interface TraceBridge {
  /** Open a span. Returns the span id, or undefined when tracing is off. */
  begin(input: StartSpanInput): string | undefined
  /** Close a span. `content` is dropped unless the subscriber opted in. */
  finish(
    spanId: string | undefined,
    outcome: {
      errorType?: string
      errorMessage?: string
      outputPreview?: string
      metadata?: Record<string, unknown>
    }
  ): void
  /** Finished spans, newest last, optionally narrowed to one session. */
  export(options: { sessionId?: string; format?: string }): Record<string, unknown>
  onSpan(listener: (span: AgentTraceSpan) => void): () => void
  close(): void
}

/**
 * Redacted by default.
 *
 * Spans are the one substrate that would naturally carry prompt and tool text,
 * and `trace/subscribe` hands them to a client process. So previews are dropped
 * unless a subscriber explicitly asked for content, and even then they go
 * through the same PII gate every other outbound path uses — an explicit opt-in
 * buys visibility, not an exemption.
 */
export function redactSpan(span: AgentTraceSpan, includeContent: boolean): AgentTraceSpan {
  const safe: AgentTraceSpan = { ...span }

  if (!includeContent) {
    delete safe.inputPreview
    delete safe.outputPreview
    safe.metadata = { ...safe.metadata, redacted: true }
  } else {
    if (safe.inputPreview !== undefined && !hasNoLeakingPiiDeep(safe.inputPreview)) {
      delete safe.inputPreview
      safe.metadata = { ...safe.metadata, inputPreviewBlocked: "pii-gate" }
    }
    if (safe.outputPreview !== undefined && !hasNoLeakingPiiDeep(safe.outputPreview)) {
      delete safe.outputPreview
      safe.metadata = { ...safe.metadata, outputPreviewBlocked: "pii-gate" }
    }
  }

  // An error message is not a "preview", but a provider routinely echoes the
  // offending input back inside one, so it goes through the same gate — and
  // unconditionally, because a span is redacted by default precisely so that a
  // subscriber who asked for nothing receives nothing.
  if (safe.errorMessage !== undefined && !hasNoLeakingPiiDeep(safe.errorMessage)) {
    delete safe.errorMessage
    safe.metadata = { ...safe.metadata, errorMessageBlocked: "pii-gate" }
  }
  return safe
}

/**
 * Bridges `@cognia/agent-trace` into the RPC host.
 *
 * The host used to publish audit rows on `trace/event`, which are records of
 * which method ran, not spans: no trace id, no parent, no duration tree, and
 * nothing OTLP could consume. This installs a real writer, keeps a bounded ring
 * of finished spans for export, and hands both JSON and OTLP JSON to callers.
 */
export function createTraceBridge(options: { bufferSize?: number } = {}): TraceBridge {
  const bufferSize = options.bufferSize ?? DEFAULT_SPAN_BUFFER
  const finished: AgentTraceSpan[] = []
  const listeners = new Set<(span: AgentTraceSpan) => void>()
  const previous = getAgentTraceWriter()
  let closed = false

  const writer: AgentTraceWriter = (span) => {
    if (closed) return
    finished.push(span)
    while (finished.length > bufferSize) finished.shift()
    for (const listener of [...listeners]) listener(span)
    previous?.(span)
  }
  setAgentTraceWriter(writer)

  return {
    begin(input) {
      if (closed) return undefined
      return startSpan(input).spanId
    },
    finish(spanId, outcome) {
      if (closed || spanId === undefined) return
      endSpan(spanId, outcome)
    },
    export({ sessionId, format = "json" }) {
      const spans = sessionId
        ? finished.filter((span) => span.sessionId === sessionId)
        : [...finished]
      // Never leak content through export; a subscriber opts in per stream, and
      // an export has no subscriber to have opted in.
      const redacted = spans.map((span) => redactSpan(span, false))
      if (format === "otlp-json") {
        return { format, ...spansToOtlp(redacted) } as unknown as Record<string, unknown>
      }
      return { format: "json", spans: redacted, redacted: true }
    },
    onSpan(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      if (closed) return
      closed = true
      listeners.clear()
      finished.length = 0
      setAgentTraceWriter(previous)
    },
  }
}
