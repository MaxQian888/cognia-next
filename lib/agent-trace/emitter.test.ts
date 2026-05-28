import type { AgentTraceSpan } from "@/types/agent-trace/span"
import {
  __getActiveSpanForTesting,
  __resetAgentTraceEmitterForTesting,
  emitFinishedSpan,
  endSpan,
  generateHexId,
  generateSpanId,
  generateTraceId,
  getAgentTraceWriter,
  recordEvent,
  setAgentTraceWriter,
  startSpan,
} from "./emitter"

describe("agent-trace emitter", () => {
  beforeEach(() => {
    __resetAgentTraceEmitterForTesting()
  })

  describe("id generation", () => {
    it("traceId is 32 lower-case hex chars", () => {
      const id = generateTraceId()
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    })

    it("spanId is 16 lower-case hex chars", () => {
      const id = generateSpanId()
      expect(id).toMatch(/^[0-9a-f]{16}$/)
    })

    it("generateHexId produces 2*N chars", () => {
      expect(generateHexId(0)).toBe("")
      expect(generateHexId(4)).toMatch(/^[0-9a-f]{8}$/)
    })

    it("falls back when crypto.getRandomValues is unavailable", () => {
      const original = globalThis.crypto
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      })
      try {
        const id = generateHexId(4)
        expect(id).toMatch(/^[0-9a-f]{8}$/)
      } finally {
        Object.defineProperty(globalThis, "crypto", {
          value: original,
          configurable: true,
        })
      }
    })

    it("produces distinct ids on each call", () => {
      const a = generateTraceId()
      const b = generateTraceId()
      expect(a).not.toBe(b)
    })
  })

  describe("setAgentTraceWriter / getAgentTraceWriter", () => {
    it("get returns null by default", () => {
      expect(getAgentTraceWriter()).toBeNull()
    })

    it("registers and clears", () => {
      const fn = jest.fn<void, [AgentTraceSpan]>()
      setAgentTraceWriter(fn)
      expect(getAgentTraceWriter()).toBe(fn)
      setAgentTraceWriter(null)
      expect(getAgentTraceWriter()).toBeNull()
    })
  })

  describe("startSpan", () => {
    it("creates a span with generated trace/span ids", () => {
      const handle = startSpan({
        operationName: "invoke_agent",
        providerName: "anthropic",
        sessionId: "s1",
        surface: "chat",
      })
      expect(handle.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(handle.spanId).toMatch(/^[0-9a-f]{16}$/)
      const active = __getActiveSpanForTesting(handle.spanId)
      expect(active).toBeDefined()
      expect(active?.operationName).toBe("invoke_agent")
      expect(active?.sessionId).toBe("s1")
      expect(active?.surface).toBe("chat")
      expect(typeof active?.startTime).toBe("number")
      expect(active?.endTime).toBeUndefined()
    })

    it("reuses provided traceId and parentSpanId", () => {
      const handle = startSpan({
        operationName: "execute_tool",
        providerName: "cognia.plugin",
        sessionId: "s2",
        surface: "chat",
        traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
        parentSpanId: "1111222233334444",
        toolName: "list_files",
      })
      expect(handle.traceId).toBe("deadbeefdeadbeefdeadbeefdeadbeef")
      const active = __getActiveSpanForTesting(handle.spanId)
      expect(active?.parentSpanId).toBe("1111222233334444")
      expect(active?.toolName).toBe("list_files")
    })

    it("forwards optional identity + metadata fields", () => {
      const handle = startSpan({
        operationName: "invoke_agent",
        providerName: "cognia.team",
        sessionId: "s3",
        surface: "agent-team",
        agentId: "researcher",
        agentName: "Researcher",
        requestModel: "claude-opus-4-7",
        pluginId: "lark",
        handoff: { fromAgent: "leader", toAgent: "researcher", reason: "delegate" },
        inputPreview: "hello",
        metadata: { foo: "bar" },
      })
      const span = __getActiveSpanForTesting(handle.spanId)!
      expect(span.agentId).toBe("researcher")
      expect(span.agentName).toBe("Researcher")
      expect(span.requestModel).toBe("claude-opus-4-7")
      expect(span.pluginId).toBe("lark")
      expect(span.handoff).toEqual({
        fromAgent: "leader",
        toAgent: "researcher",
        reason: "delegate",
      })
      expect(span.inputPreview).toBe("hello")
      expect(span.metadata).toEqual({ foo: "bar" })
    })
  })

  describe("recordEvent", () => {
    it("appends events on a live span", () => {
      const { spanId } = startSpan({
        operationName: "invoke_agent",
        providerName: "anthropic",
        sessionId: "s4",
        surface: "chat",
      })
      recordEvent(spanId, { name: "tool_use", at: 100, attributes: { tool: "x" } })
      recordEvent(spanId, { name: "tool_result", at: 200 })
      const span = __getActiveSpanForTesting(spanId)!
      expect(span.events).toHaveLength(2)
      expect(span.events?.[0]?.name).toBe("tool_use")
      expect(span.events?.[1]?.attributes).toBeUndefined()
    })

    it("is a no-op when the span is not active", () => {
      expect(() => recordEvent("missing", { name: "x", at: 0 })).not.toThrow()
    })
  })

  describe("endSpan", () => {
    it("finalizes the span, fills durationMs, and invokes the writer", () => {
      const captured: AgentTraceSpan[] = []
      setAgentTraceWriter((s) => {
        captured.push(s)
      })
      const realNow = Date.now
      let now = 1_000_000
      Date.now = () => now
      try {
        const { spanId } = startSpan({
          operationName: "invoke_agent",
          providerName: "anthropic",
          sessionId: "s5",
          surface: "chat",
        })
        now = 1_000_250
        const result = endSpan(spanId, {
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationTokens: 0,
            cacheReadTokens: 5,
          },
          costUsdEstimate: 0.0123,
          responseModel: "claude-opus-4-7",
          finishReasons: ["stop"],
          outputPreview: "ok",
          metadata: { branch: "main" },
        })
        expect(result?.endTime).toBe(1_000_250)
        expect(result?.durationMs).toBe(250)
        expect(result?.usage?.inputTokens).toBe(10)
        expect(result?.costUsdEstimate).toBeCloseTo(0.0123)
        expect(result?.responseModel).toBe("claude-opus-4-7")
        expect(result?.finishReasons).toEqual(["stop"])
        expect(result?.outputPreview).toBe("ok")
        expect(result?.metadata).toEqual({ branch: "main" })
        expect(captured).toHaveLength(1)
        expect(captured[0]).toBe(result)
        expect(__getActiveSpanForTesting(spanId)).toBeUndefined()
      } finally {
        Date.now = realNow
      }
    })

    it("merges new metadata into existing metadata", () => {
      const { spanId } = startSpan({
        operationName: "invoke_agent",
        providerName: "anthropic",
        sessionId: "s6",
        surface: "chat",
        metadata: { keep: 1 },
      })
      const finished = endSpan(spanId, { metadata: { add: 2 } })
      expect(finished?.metadata).toEqual({ keep: 1, add: 2 })
    })

    it("records error info and ignores empty finishReasons", () => {
      const { spanId } = startSpan({
        operationName: "execute_tool",
        providerName: "cognia.plugin",
        sessionId: "s7",
        surface: "chat",
      })
      const finished = endSpan(spanId, {
        errorType: "tool_error",
        errorMessage: "boom",
        finishReasons: [],
      })
      expect(finished?.errorType).toBe("tool_error")
      expect(finished?.errorMessage).toBe("boom")
      expect(finished?.finishReasons).toBeUndefined()
    })

    it("uses provided endTime override", () => {
      const { spanId } = startSpan({
        operationName: "chat",
        providerName: "anthropic",
        sessionId: "s8",
        surface: "chat",
      })
      const finished = endSpan(spanId, { endTime: Date.now() + 9999 })
      expect(finished?.durationMs).toBeGreaterThanOrEqual(0)
    })

    it("returns null and skips writer when span is unknown", () => {
      const writer = jest.fn<void, [AgentTraceSpan]>()
      setAgentTraceWriter(writer)
      expect(endSpan("nope")).toBeNull()
      expect(writer).not.toHaveBeenCalled()
    })

    it("is idempotent on repeated calls", () => {
      const writer = jest.fn<void, [AgentTraceSpan]>()
      setAgentTraceWriter(writer)
      const { spanId } = startSpan({
        operationName: "invoke_agent",
        providerName: "anthropic",
        sessionId: "s9",
        surface: "chat",
      })
      const first = endSpan(spanId)
      const second = endSpan(spanId)
      expect(first).not.toBeNull()
      expect(second).toBeNull()
      expect(writer).toHaveBeenCalledTimes(1)
    })

    it("swallows writer exceptions", () => {
      setAgentTraceWriter(() => {
        throw new Error("nope")
      })
      const { spanId } = startSpan({
        operationName: "invoke_agent",
        providerName: "anthropic",
        sessionId: "s10",
        surface: "chat",
      })
      expect(() => endSpan(spanId)).not.toThrow()
    })

    it("clamps negative duration to 0 when clock skews backwards", () => {
      const { spanId } = startSpan({
        operationName: "chat",
        providerName: "anthropic",
        sessionId: "s11",
        surface: "chat",
      })
      const span = __getActiveSpanForTesting(spanId)!
      const finished = endSpan(spanId, { endTime: span.startTime - 100 })
      expect(finished?.durationMs).toBe(0)
    })
  })

  describe("emitFinishedSpan", () => {
    it("emits a one-shot finished span via the writer", () => {
      const captured: AgentTraceSpan[] = []
      setAgentTraceWriter((s) => {
        captured.push(s)
      })
      const result = emitFinishedSpan({
        operationName: "execute_tool",
        providerName: "cognia.plugin",
        sessionId: "s1",
        surface: "plugin-hook",
        toolName: "onTeamStart",
        pluginId: "lark",
        startTime: 1_000,
        durationMs: 50,
      })
      expect(captured).toHaveLength(1)
      expect(result?.endTime).toBe(1_050)
      expect(result?.durationMs).toBe(50)
      expect(result?.spanId).toMatch(/^[0-9a-f]{16}$/)
      expect(result?.traceId).toMatch(/^[0-9a-f]{32}$/)
    })

    it("computes durationMs from startTime/endTime when durationMs is missing", () => {
      const captured: AgentTraceSpan[] = []
      setAgentTraceWriter((s) => {
        captured.push(s)
      })
      emitFinishedSpan({
        operationName: "invoke_agent",
        providerName: "anthropic",
        sessionId: "s1",
        surface: "chat",
        startTime: 100,
        endTime: 450,
      })
      expect(captured[0].durationMs).toBe(350)
    })

    it("returns null when required identity is missing", () => {
      const captured: AgentTraceSpan[] = []
      setAgentTraceWriter((s) => captured.push(s))
      expect(emitFinishedSpan({})).toBeNull()
      expect(
        emitFinishedSpan({
          operationName: "invoke_agent",
          providerName: "anthropic",
          surface: "chat",
        })
      ).toBeNull()
      expect(captured).toHaveLength(0)
    })

    it("swallows writer errors", () => {
      setAgentTraceWriter(() => {
        throw new Error("boom")
      })
      expect(() =>
        emitFinishedSpan({
          operationName: "invoke_agent",
          providerName: "anthropic",
          sessionId: "s1",
          surface: "chat",
          durationMs: 10,
        })
      ).not.toThrow()
    })

    it("reuses provided spanId / traceId / id", () => {
      const captured: AgentTraceSpan[] = []
      setAgentTraceWriter((s) => captured.push(s))
      emitFinishedSpan({
        id: "fixed-id",
        spanId: "1111222233334444",
        traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
        operationName: "execute_tool",
        providerName: "cognia.plugin",
        sessionId: "s1",
        surface: "plugin-hook",
        startTime: 1,
        durationMs: 1,
      })
      expect(captured[0].id).toBe("1111222233334444")
      expect(captured[0].spanId).toBe("1111222233334444")
      expect(captured[0].traceId).toBe("deadbeefdeadbeefdeadbeefdeadbeef")
    })
  })
})
