import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { AgentTraceSpanEvent, ClaudeEvent } from "@cognia/agent-config-types"

const listeners: Array<(evt: ClaudeEvent) => void> = []
const unlistenMock = jest.fn()

jest.mock("@/lib/claude/ipc", () => ({
  onClaudeMessage: (fn: (evt: ClaudeEvent) => void) => {
    listeners.push(fn)
    return Promise.resolve(unlistenMock)
  },
}))

import {
  __resetAgentTraceEmitterForTesting,
  setAgentTraceWriter,
} from "@cognia/agent-trace/emitter"
import {
  forwardSidecarSpan,
  spanFromSidecarEvent,
  subscribeToSidecarSpans,
} from "./sidecar-span-bridge"

const TRACE_ID = "a".repeat(32)
const ROOT_SPAN_ID = "b".repeat(16)
const TRACEPARENT = `00-${TRACE_ID}-${ROOT_SPAN_ID}-01`

function event(over: Partial<AgentTraceSpanEvent> = {}): AgentTraceSpanEvent {
  return {
    type: "agent_trace_span",
    sessionId: "session-1",
    traceparent: TRACEPARENT,
    spanId: "c".repeat(16),
    name: "gen_ai.invoke_agent",
    operationName: "invoke_agent",
    providerName: "anthropic",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_002_500,
    durationMs: 2_500,
    attributes: { "gen_ai.request.model": "claude-opus-5" },
    ...over,
  }
}

beforeEach(() => {
  listeners.length = 0
  unlistenMock.mockClear()
  __resetAgentTraceEmitterForTesting()
})

describe("spanFromSidecarEvent", () => {
  it("attaches the sidecar span under the renderer's turn", () => {
    const span = spanFromSidecarEvent(event())
    expect(span).toMatchObject({
      traceId: TRACE_ID,
      // The renderer's root span is the parent — this is what closes the gap in
      // the waterfall rather than creating a second, unrelated trace.
      parentSpanId: ROOT_SPAN_ID,
      spanId: "c".repeat(16),
      operationName: "invoke_agent",
      providerName: "anthropic",
      sessionId: "session-1",
      surface: "chat",
      // The sidecar is the receiving side of the renderer → sidecar hop.
      spanKind: "server",
      status: "ok",
      durationMs: 2_500,
    })
  })

  it("drops a span with no parseable traceparent instead of inventing a trace", () => {
    // A phantom second trace for work that already has one is worse than no span.
    expect(spanFromSidecarEvent(event({ traceparent: undefined }))).toBeNull()
    expect(spanFromSidecarEvent(event({ traceparent: "garbage" }))).toBeNull()
    expect(
      spanFromSidecarEvent(event({ traceparent: `00-${"0".repeat(32)}-${ROOT_SPAN_ID}-01` }))
    ).toBeNull()
  })

  it("drops a span with no id or no start time", () => {
    expect(spanFromSidecarEvent(event({ spanId: "" }))).toBeNull()
    expect(spanFromSidecarEvent(event({ startTime: undefined as unknown as number }))).toBeNull()
  })

  it("carries the error through as a failed span", () => {
    const span = spanFromSidecarEvent(
      event({ errorType: "AbortError", errorMessage: "stream aborted" })
    )
    expect(span).toMatchObject({
      status: "error",
      errorType: "AbortError",
      errorMessage: "stream aborted",
    })
  })

  it("keeps the sidecar's attributes and marks the origin", () => {
    const span = spanFromSidecarEvent(event())
    expect(span?.metadata).toMatchObject({
      origin: "sidecar",
      spanName: "gen_ai.invoke_agent",
      "gen_ai.request.model": "claude-opus-5",
    })
  })

  it("falls back to invoke_agent for an operation name we do not model", () => {
    expect(spanFromSidecarEvent(event({ operationName: "nonsense" }))?.operationName).toBe(
      "invoke_agent"
    )
    expect(spanFromSidecarEvent(event({ operationName: "embeddings" }))?.operationName).toBe(
      "embeddings"
    )
  })

  it("resolves an arbitrary provider id to a spec-legal value", () => {
    expect(spanFromSidecarEvent(event({ providerName: "deepseek" }))?.providerName).toBe("deepseek")
  })
})

describe("forwardSidecarSpan", () => {
  it("emits the span through the ordinary writer", () => {
    const spans: AgentTraceSpan[] = []
    setAgentTraceWriter((span) => spans.push(span))
    expect(forwardSidecarSpan(event())).toBe(true)
    expect(spans).toHaveLength(1)
    // Timings are the sidecar's own — re-measuring locally would report IPC
    // latency as part of the model call.
    expect(spans[0].durationMs).toBe(2_500)
    expect(spans[0].startTime).toBe(1_700_000_000_000)
  })

  it("reports failure for an event it cannot attach", () => {
    setAgentTraceWriter(() => {})
    expect(forwardSidecarSpan(event({ traceparent: "nope" }))).toBe(false)
  })
})

describe("subscribeToSidecarSpans", () => {
  it("forwards only agent_trace_span events and returns the unlisten handle", async () => {
    const spans: AgentTraceSpan[] = []
    setAgentTraceWriter((span) => spans.push(span))
    const unlisten = await subscribeToSidecarSpans()
    expect(listeners).toHaveLength(1)

    listeners[0]({ type: "mcp_log", sessionId: "s", ts: 0, level: "info", message: "x" })
    expect(spans).toHaveLength(0)

    listeners[0](event())
    expect(spans).toHaveLength(1)

    unlisten()
    expect(unlistenMock).toHaveBeenCalled()
  })
})
