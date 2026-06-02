import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase } from "@/types/eval/eval"
import { assembleSampleFromSpans, createChatTarget } from "./chat"

function span(overrides: Partial<AgentTraceSpan>): AgentTraceSpan {
  return {
    id: overrides.id ?? "sp_" + Math.random().toString(36).slice(2),
    traceId: "tr1",
    spanId: overrides.id ?? "sp1",
    startTime: 0,
    operationName: "chat",
    providerName: "anthropic",
    sessionId: "ses1",
    surface: "chat",
    ...overrides,
  }
}

function makeCase(input = "do x", history?: EvalCase["history"]): EvalCase {
  return {
    id: "c1",
    datasetId: "d1",
    input,
    capability: "chat.tool-use",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...(history ? { history } : {}),
  }
}

describe("assembleSampleFromSpans", () => {
  it("extracts tool calls in start-time order with args parsed from inputPreview", () => {
    const spans = [
      span({
        operationName: "execute_tool",
        toolName: "Edit",
        startTime: 20,
        inputPreview: '{"path":"/b"}',
      }),
      span({
        operationName: "execute_tool",
        toolName: "Read",
        startTime: 10,
        inputPreview: '{"path":"/a"}',
      }),
    ]
    const s = assembleSampleFromSpans(spans, { output: "done" })
    expect(s.toolCalls.map((t) => t.name)).toEqual(["Read", "Edit"])
    expect(s.toolCalls[0].args).toEqual({ path: "/a" })
    expect(s.toolCalls[0].index).toBe(0)
  })

  it("defaults args to an empty bag when inputPreview is absent or not JSON", () => {
    const spans = [
      span({ operationName: "execute_tool", toolName: "Bash", startTime: 1 }),
      span({
        operationName: "execute_tool",
        toolName: "Bash",
        startTime: 2,
        inputPreview: "not json",
      }),
    ]
    const s = assembleSampleFromSpans(spans, { output: "" })
    expect(s.toolCalls[0].args).toEqual({})
    expect(s.toolCalls[1].args).toEqual({})
  })

  it("flags a tool call as errored when the span carries an error", () => {
    const spans = [
      span({
        operationName: "execute_tool",
        toolName: "Bash",
        startTime: 1,
        errorType: "ExecError",
      }),
    ]
    expect(assembleSampleFromSpans(spans, { output: "" }).toolCalls[0].errored).toBe(true)
  })

  it("extracts retrieved chunks from a retrieval span's metadata", () => {
    const spans = [
      span({
        operationName: "retrieval",
        startTime: 5,
        metadata: { retrievedChunks: [{ text: "chunk a", score: 0.9 }, { text: "chunk b" }] },
      }),
    ]
    const s = assembleSampleFromSpans(spans, { output: "" })
    expect(s.retrievedChunks).toHaveLength(2)
    expect(s.retrievedChunks[0]).toMatchObject({ text: "chunk a", score: 0.9 })
  })

  it("sums usage and cost, derives latency window, and counts steps", () => {
    const spans = [
      span({
        operationName: "chat",
        startTime: 100,
        endTime: 300,
        costUsdEstimate: 0.02,
        usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 0 },
      }),
      span({
        operationName: "execute_tool",
        toolName: "Read",
        startTime: 150,
        endTime: 200,
        costUsdEstimate: 0.01,
        usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }),
    ]
    const s = assembleSampleFromSpans(spans, { output: "" })
    expect(s.usage.inputTokens).toBe(60)
    expect(s.costUsd).toBeCloseTo(0.03, 6)
    expect(s.latencyMs).toBe(200) // 300 - 100
    expect(s.stepCount).toBe(2) // one chat turn + one tool call
  })

  it("carries output and degraded through from options", () => {
    const s = assembleSampleFromSpans([], { output: "hello", degraded: true })
    expect(s.output).toBe("hello")
    expect(s.degraded).toBe(true)
  })

  it("prefers structured metadata.args over inputPreview", () => {
    const spans = [
      span({
        operationName: "execute_tool",
        toolName: "Read",
        startTime: 1,
        metadata: { args: { path: "/from-meta" } },
        inputPreview: '{"path":"/from-preview"}',
      }),
    ]
    expect(assembleSampleFromSpans(spans, { output: "" }).toolCalls[0].args).toEqual({
      path: "/from-meta",
    })
  })

  it("keeps chunk id and score when present", () => {
    const spans = [
      span({
        operationName: "retrieval",
        startTime: 1,
        metadata: { retrievedChunks: [{ id: "c1", text: "t", score: 0.42 }] },
      }),
    ]
    expect(assembleSampleFromSpans(spans, { output: "" }).retrievedChunks[0]).toEqual({
      id: "c1",
      text: "t",
      score: 0.42,
    })
  })
})

describe("createChatTarget", () => {
  it("drives the turn, fetches spans, and assembles a sample", async () => {
    const seen: { prompt?: string; sessionId?: string } = {}
    const target = createChatTarget(
      { label: "opus", model: "claude-opus-4-8" },
      {
        runTurn: async ({ prompt }) => {
          seen.prompt = prompt
          return { text: "the answer", sessionId: "ses-xyz" }
        },
        fetchSpans: async (sessionId) => {
          seen.sessionId = sessionId
          return [span({ operationName: "execute_tool", toolName: "Read", startTime: 1 })]
        },
        isToolCapable: () => true,
      }
    )
    const sample = await target.run(makeCase("PROMPT-TEXT"))
    expect(seen.prompt).toContain("PROMPT-TEXT")
    expect(seen.sessionId).toBe("ses-xyz")
    expect(sample.output).toBe("the answer")
    expect(sample.degraded).toBe(false)
    expect(sample.toolCalls).toHaveLength(1)
    expect(target.label).toBe("opus")
  })

  it("marks the sample degraded when the run is not tool-capable", async () => {
    const target = createChatTarget(
      { label: "web", model: "x" },
      {
        runTurn: async () => ({ text: "t", sessionId: "s" }),
        fetchSpans: async () => [],
        isToolCapable: () => false,
      }
    )
    expect((await target.run(makeCase())).degraded).toBe(true)
  })

  it("prepends conversation history to the prompt", async () => {
    const seen: { prompt?: string } = {}
    const target = createChatTarget(
      { label: "t", model: "x" },
      {
        runTurn: async ({ prompt }) => {
          seen.prompt = prompt
          return { text: "t", sessionId: "s" }
        },
        fetchSpans: async () => [],
        isToolCapable: () => true,
      }
    )
    await target.run(makeCase("NOW", [{ role: "user", content: "EARLIER" }]))
    expect(seen.prompt).toContain("EARLIER")
    expect(seen.prompt).toContain("NOW")
  })
})
