import {
  __resetAgentTraceEmitterForTesting,
  getAgentTraceWriter,
  type AgentTraceSpan,
} from "@cognia/agent-trace"

import { createTraceBridge, redactSpan } from "./trace-bridge"

function span(overrides: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "span-1",
    traceId: "t1",
    spanId: "s1",
    startTime: 0,
    operationName: "invoke_agent",
    providerName: "cognia.agent-rpc",
    sessionId: "session-1",
    surface: "agent-rpc",
    inputPreview: "a prompt",
    outputPreview: "an answer",
    ...overrides,
  }
}

describe("redactSpan", () => {
  it("drops both previews by default and says so", () => {
    const out = redactSpan(span(), false)
    expect(out.inputPreview).toBeUndefined()
    expect(out.outputPreview).toBeUndefined()
    expect(out.metadata).toMatchObject({ redacted: true })
  })

  it("keeps previews that pass the PII gate when content was requested", () => {
    const out = redactSpan(span(), true)
    expect(out.inputPreview).toBe("a prompt")
    expect(out.outputPreview).toBe("an answer")
  })

  it("still drops a preview that fails the PII gate", () => {
    const out = redactSpan(span({ inputPreview: "reach me at alice@example.com" }), true)
    expect(out.inputPreview).toBeUndefined()
    expect(out.metadata).toMatchObject({ inputPreviewBlocked: "pii-gate" })
    // The clean half survives; opting in is not all-or-nothing.
    expect(out.outputPreview).toBe("an answer")
  })

  it("leaves everything but the previews intact", () => {
    const out = redactSpan(span(), false)
    expect(out).toMatchObject({
      traceId: "t1",
      spanId: "s1",
      sessionId: "session-1",
      operationName: "invoke_agent",
    })
  })
})

describe("createTraceBridge", () => {
  afterEach(() => __resetAgentTraceEmitterForTesting())

  it("installs a writer and restores the previous one on close", () => {
    const before = getAgentTraceWriter()
    const bridge = createTraceBridge()
    expect(getAgentTraceWriter()).not.toBe(before)
    bridge.close()
    expect(getAgentTraceWriter()).toBe(before)
  })

  it("delivers each finished span to its listeners", () => {
    const bridge = createTraceBridge()
    const seen: AgentTraceSpan[] = []
    bridge.onSpan((value) => seen.push(value))
    const id = bridge.begin({
      operationName: "invoke_agent",
      providerName: "cognia.agent-rpc",
      sessionId: "session-1",
      surface: "agent-rpc",
    })
    bridge.finish(id, { outputPreview: "done" })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sessionId: "session-1", operationName: "invoke_agent" })
    bridge.close()
  })

  it("stops delivering to a detached listener", () => {
    const bridge = createTraceBridge()
    const seen: AgentTraceSpan[] = []
    const detach = bridge.onSpan((value) => seen.push(value))
    detach()
    bridge.finish(
      bridge.begin({
        operationName: "invoke_agent",
        providerName: "cognia.agent-rpc",
        sessionId: "s",
        surface: "agent-rpc",
      }),
      {}
    )
    expect(seen).toEqual([])
    bridge.close()
  })

  it("bounds the export buffer instead of growing forever", () => {
    const bridge = createTraceBridge({ bufferSize: 2 })
    for (let index = 0; index < 5; index += 1) {
      bridge.finish(
        bridge.begin({
          operationName: "invoke_agent",
          providerName: "cognia.agent-rpc",
          sessionId: "session-1",
          surface: "agent-rpc",
        }),
        {}
      )
    }
    const exported = bridge.export({}) as { spans: unknown[] }
    expect(exported.spans).toHaveLength(2)
    bridge.close()
  })

  it("narrows an export to one session", () => {
    const bridge = createTraceBridge()
    for (const sessionId of ["a", "b", "a"]) {
      bridge.finish(
        bridge.begin({
          operationName: "invoke_agent",
          providerName: "cognia.agent-rpc",
          sessionId,
          surface: "agent-rpc",
        }),
        {}
      )
    }
    expect((bridge.export({ sessionId: "a" }) as { spans: unknown[] }).spans).toHaveLength(2)
    expect((bridge.export({}) as { spans: unknown[] }).spans).toHaveLength(3)
    bridge.close()
  })

  it("never exports content, even for a caller that asked a subscription for it", () => {
    const bridge = createTraceBridge()
    bridge.finish(
      bridge.begin({
        operationName: "invoke_agent",
        providerName: "cognia.agent-rpc",
        sessionId: "session-1",
        surface: "agent-rpc",
        inputPreview: "a prompt",
      }),
      { outputPreview: "an answer" }
    )
    const exported = JSON.stringify(bridge.export({}))
    expect(exported).not.toContain("a prompt")
    expect(exported).not.toContain("an answer")
    bridge.close()
  })

  it("emits OTLP JSON on request", () => {
    const bridge = createTraceBridge()
    bridge.finish(
      bridge.begin({
        operationName: "invoke_agent",
        providerName: "cognia.agent-rpc",
        sessionId: "session-1",
        surface: "agent-rpc",
      }),
      {}
    )
    const otlp = bridge.export({ format: "otlp-json" }) as { resourceSpans?: unknown[] }
    expect(Array.isArray(otlp.resourceSpans)).toBe(true)
    bridge.close()
  })

  it("becomes inert after close", () => {
    const bridge = createTraceBridge()
    bridge.close()
    expect(
      bridge.begin({
        operationName: "invoke_agent",
        providerName: "cognia.agent-rpc",
        sessionId: "s",
        surface: "agent-rpc",
      })
    ).toBeUndefined()
    expect((bridge.export({}) as { spans: unknown[] }).spans).toEqual([])
  })

  it("ignores a finish for a span that was never begun", () => {
    const bridge = createTraceBridge()
    expect(() => bridge.finish(undefined, {})).not.toThrow()
    bridge.close()
  })
})
