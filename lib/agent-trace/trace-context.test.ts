import {
  __getActiveSpanForTesting,
  __resetAgentTraceEmitterForTesting,
} from "@cognia/agent-trace/emitter"
import type { TraceContext } from "@/types/agent-trace/trace-context"
import { childSpanInput, startRootTrace } from "./trace-context"

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/

describe("startRootTrace", () => {
  afterEach(() => {
    __resetAgentTraceEmitterForTesting()
  })

  it("mints a root span and returns matching ctx + spanId with W3C-shaped ids", () => {
    const { ctx, spanId } = startRootTrace({
      operationName: "invoke_agent",
      providerName: "anthropic",
      sessionId: "session-1",
      surface: "chat",
    })

    expect(ctx.traceId).toMatch(HEX32)
    expect(ctx.rootSpanId).toMatch(HEX16)
    expect(spanId).toBe(ctx.rootSpanId)
  })

  it("forwards span input to the emitter (the active span carries the fields)", () => {
    const { spanId } = startRootTrace({
      operationName: "invoke_workflow",
      providerName: "cognia.workflow",
      sessionId: "session-7",
      surface: "workflow",
      requestModel: "claude-opus-4-8",
      metadata: { providerId: "anthropic" },
    })

    const active = __getActiveSpanForTesting(spanId)
    expect(active).toBeDefined()
    expect(active?.operationName).toBe("invoke_workflow")
    expect(active?.providerName).toBe("cognia.workflow")
    expect(active?.sessionId).toBe("session-7")
    expect(active?.surface).toBe("workflow")
    expect(active?.requestModel).toBe("claude-opus-4-8")
    expect(active?.metadata).toEqual({ providerId: "anthropic" })
    // Root spans have no parent.
    expect(active?.parentSpanId).toBeUndefined()
  })

  it("produces independent traces for concurrent calls (no shared mutable state)", () => {
    const a = startRootTrace({
      operationName: "invoke_agent",
      providerName: "anthropic",
      sessionId: "session-a",
      surface: "chat",
    })
    const b = startRootTrace({
      operationName: "invoke_agent",
      providerName: "anthropic",
      sessionId: "session-b",
      surface: "chat",
    })

    expect(a.ctx.traceId).not.toBe(b.ctx.traceId)
    expect(a.ctx.rootSpanId).not.toBe(b.ctx.rootSpanId)
  })
})

describe("childSpanInput", () => {
  const ctx: TraceContext = { traceId: "a".repeat(32), rootSpanId: "b".repeat(16) }

  it("nests the child under the context's trace and root span", () => {
    const input = childSpanInput(ctx, {
      operationName: "chat",
      providerName: "anthropic",
      sessionId: "session-1",
      surface: "chat",
    })

    expect(input.traceId).toBe(ctx.traceId)
    expect(input.parentSpanId).toBe(ctx.rootSpanId)
    expect(input.operationName).toBe("chat")
  })

  it("ignores any caller-supplied trace/parent ids (Omit strips them at the type level, override wins at runtime)", () => {
    const input = childSpanInput(ctx, {
      operationName: "execute_tool",
      providerName: "cognia.plugin",
      sessionId: "session-1",
      surface: "plugin-hook",
      // @ts-expect-error — traceId is omitted from the accepted input type
      traceId: "deadbeef",
      // parentSpanId is also omitted from the accepted input type; TS only
      // flags the first excess property (traceId above), so no directive here.
      parentSpanId: "feedface",
    })

    expect(input.traceId).toBe(ctx.traceId)
    expect(input.parentSpanId).toBe(ctx.rootSpanId)
  })
})
