import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { hexToBase64, msToNanoString, spanToOtlp, spansToOtlp } from "./span-to-otlp"

function makeSpan(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "1111222233334444",
    spanId: "1111222233334444",
    traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_250,
    durationMs: 250,
    operationName: "invoke_agent",
    providerName: "anthropic",
    sessionId: "session-1",
    surface: "chat",
    requestModel: "claude-opus-4-7",
    responseModel: "claude-opus-4-7",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
    },
    costUsdEstimate: 0.005,
    finishReasons: ["stop"],
    ...over,
  }
}

describe("hexToBase64", () => {
  it("encodes 16-byte traceId to a base64 string", () => {
    const out = hexToBase64("deadbeefdeadbeefdeadbeefdeadbeef", 16)
    // 16 raw bytes → 24-char base64 string (with two '=' padding).
    expect(out).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(out.length).toBe(24)
    // Sanity: decode back and compare.
    const decoded = globalThis.atob(out)
    let hexBack = ""
    for (let i = 0; i < decoded.length; i++) {
      hexBack += decoded.charCodeAt(i).toString(16).padStart(2, "0")
    }
    expect(hexBack).toBe("deadbeefdeadbeefdeadbeefdeadbeef")
  })

  it("encodes 8-byte spanId to 12-char base64", () => {
    const out = hexToBase64("1111222233334444", 8)
    expect(out.length).toBe(12)
  })

  it("pads short hex inputs with leading zeros", () => {
    const out = hexToBase64("ab", 8)
    expect(out.length).toBe(12)
    const decoded = globalThis.atob(out)
    expect(decoded.charCodeAt(7)).toBe(0xab)
    expect(decoded.charCodeAt(0)).toBe(0x00)
  })

  it("truncates oversize hex inputs to the expected length", () => {
    const out = hexToBase64("0".repeat(100), 8)
    expect(out.length).toBe(12)
  })
})

describe("msToNanoString", () => {
  it("multiplies ms by 1e6 and returns a string", () => {
    expect(msToNanoString(1700)).toBe("1700000000")
  })

  it("returns '0' for non-finite or negative input", () => {
    expect(msToNanoString(-1)).toBe("0")
    expect(msToNanoString(Number.NaN)).toBe("0")
    expect(msToNanoString(Number.POSITIVE_INFINITY)).toBe("0")
  })
})

describe("spanToOtlp", () => {
  it("emits one ResourceSpans block with the configured service name", () => {
    const out = spanToOtlp(makeSpan(), { serviceName: "cognia-test", environment: "dev" })
    expect(out.resourceSpans).toHaveLength(1)
    const resAttrs = out.resourceSpans[0].resource.attributes
    expect(resAttrs).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "cognia-test" } },
        { key: "deployment.environment.name", value: { stringValue: "dev" } },
      ])
    )
  })

  it("converts trace/span ids to base64 and uses ns timestamps", () => {
    const out = spanToOtlp(makeSpan())
    const span = out.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.traceId).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(span.spanId.length).toBe(12)
    expect(span.startTimeUnixNano).toBe("1700000000000000000")
    expect(span.endTimeUnixNano).toBe("1700000000250000000")
  })

  it("emits gen_ai.* attribute names with correct value types", () => {
    const out = spanToOtlp(makeSpan())
    const attrs = out.resourceSpans[0].scopeSpans[0].spans[0].attributes
    const find = (k: string) => attrs.find((a) => a.key === k)
    expect(find("gen_ai.operation.name")).toEqual({
      key: "gen_ai.operation.name",
      value: { stringValue: "invoke_agent" },
    })
    expect(find("gen_ai.provider.name")?.value).toEqual({ stringValue: "anthropic" })
    expect(find("gen_ai.request.model")?.value).toEqual({ stringValue: "claude-opus-4-7" })
    expect(find("gen_ai.usage.input_tokens")?.value).toEqual({ intValue: "100" })
    expect(find("gen_ai.usage.output_tokens")?.value).toEqual({ intValue: "50" })
    expect(find("gen_ai.usage.cache_read.input_tokens")?.value).toEqual({ intValue: "20" })
    expect(find("gen_ai.usage.cache_creation.input_tokens")).toBeUndefined()
    expect(find("gen_ai.response.finish_reasons")?.value).toEqual({
      arrayValue: { values: [{ stringValue: "stop" }] },
    })
    expect(find("cognia.cost.usd_estimate")?.value).toEqual({ doubleValue: 0.005 })
    expect(find("cognia.surface")?.value).toEqual({ stringValue: "chat" })
    expect(find("gen_ai.conversation.id")?.value).toEqual({ stringValue: "session-1" })
  })

  it("derives span name as `{operation} {subject}`", () => {
    const out = spanToOtlp(makeSpan({ operationName: "execute_tool", toolName: "list_files" }))
    expect(out.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("execute_tool list_files")
  })

  it("falls back to bare operation name when no subject is available", () => {
    const out = spanToOtlp(
      makeSpan({
        toolName: undefined,
        agentName: undefined,
        agentId: undefined,
        responseModel: undefined,
        requestModel: undefined,
      })
    )
    expect(out.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("invoke_agent")
  })

  it("sets ERROR status when error fields are present and propagates errorMessage", () => {
    const out = spanToOtlp(makeSpan({ errorType: "tool_error", errorMessage: "boom" }))
    const span = out.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.status).toEqual({ code: 2, message: "boom" })
    const attrs = span.attributes
    expect(attrs.find((a) => a.key === "error.type")?.value).toEqual({
      stringValue: "tool_error",
    })
  })

  it("emits OK status when no error", () => {
    const out = spanToOtlp(makeSpan())
    expect(out.resourceSpans[0].scopeSpans[0].spans[0].status?.code).toBe(1)
  })

  it("encodes parentSpanId only when present", () => {
    const noParent = spanToOtlp(makeSpan({ parentSpanId: undefined }))
    expect(noParent.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId).toBeUndefined()
    const withParent = spanToOtlp(makeSpan({ parentSpanId: "aabbccddeeff0011" }))
    expect(withParent.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId).toBe(
      hexToBase64("aabbccddeeff0011", 8)
    )
  })

  it("emits cognia.handoff.* and cognia.plugin.id when set", () => {
    const out = spanToOtlp(
      makeSpan({
        pluginId: "lark",
        handoff: { fromAgent: "leader", toAgent: "researcher", reason: "delegate" },
      })
    )
    const attrs = out.resourceSpans[0].scopeSpans[0].spans[0].attributes
    const find = (k: string) => attrs.find((a) => a.key === k)
    expect(find("cognia.plugin.id")?.value).toEqual({ stringValue: "lark" })
    expect(find("cognia.handoff.from_agent")?.value).toEqual({ stringValue: "leader" })
    expect(find("cognia.handoff.to_agent")?.value).toEqual({ stringValue: "researcher" })
    expect(find("cognia.handoff.reason")?.value).toEqual({ stringValue: "delegate" })
  })

  it("serialises events with timestamps + attributes", () => {
    const out = spanToOtlp(
      makeSpan({
        events: [
          { name: "tool_use", at: 1_700_000_000_100, attributes: { id: "toolu_a", retries: 2 } },
          { name: "compaction", at: 1_700_000_000_200 },
        ],
      })
    )
    const events = out.resourceSpans[0].scopeSpans[0].spans[0].events
    expect(events).toHaveLength(2)
    expect(events?.[0].timeUnixNano).toBe("1700000000100000000")
    expect(events?.[0].attributes).toEqual(
      expect.arrayContaining([
        { key: "id", value: { stringValue: "toolu_a" } },
        { key: "retries", value: { intValue: "2" } },
      ])
    )
    expect(events?.[1].attributes).toBeUndefined()
  })

  it("emits input/output previews under the GenAI content attribute keys", () => {
    const out = spanToOtlp(
      makeSpan({ inputPreview: "user prompt", outputPreview: "assistant reply" })
    )
    const attrs = out.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.find((a) => a.key === "gen_ai.input.messages")?.value).toEqual({
      stringValue: "user prompt",
    })
    expect(attrs.find((a) => a.key === "gen_ai.output.messages")?.value).toEqual({
      stringValue: "assistant reply",
    })
  })

  it("includes free-form metadata under cognia.metadata.*", () => {
    const out = spanToOtlp(
      makeSpan({
        metadata: { branch: "main", retries: 3, succeeded: true, ratios: [0.5, 0.7] },
      })
    )
    const attrs = out.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.find((a) => a.key === "cognia.metadata.branch")?.value).toEqual({
      stringValue: "main",
    })
    expect(attrs.find((a) => a.key === "cognia.metadata.retries")?.value).toEqual({
      intValue: "3",
    })
    expect(attrs.find((a) => a.key === "cognia.metadata.succeeded")?.value).toEqual({
      boolValue: true,
    })
    expect(attrs.find((a) => a.key === "cognia.metadata.ratios")?.value).toEqual({
      arrayValue: { values: [{ doubleValue: 0.5 }, { doubleValue: 0.7 }] },
    })
  })

  it("uses startTime for endTimeUnixNano when endTime is missing", () => {
    const out = spanToOtlp(makeSpan({ endTime: undefined, startTime: 1_700_000_000_000 }))
    expect(out.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano).toBe("1700000000000000000")
  })
})

describe("spansToOtlp", () => {
  it("batches multiple spans into one scopeSpans block", () => {
    const a = makeSpan({ id: "aaaa222233334444", spanId: "aaaa222233334444" })
    const b = makeSpan({ id: "bbbb222233334444", spanId: "bbbb222233334444" })
    const out = spansToOtlp([a, b], { serviceName: "svc" })
    expect(out.resourceSpans).toHaveLength(1)
    const scope = out.resourceSpans[0].scopeSpans[0]
    expect(scope.spans).toHaveLength(2)
    expect(scope.scope.name).toBe("cognia.agent-trace")
  })
})
