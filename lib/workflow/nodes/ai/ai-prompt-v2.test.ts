import { executeAiPromptV2 } from "./ai-prompt-v2"
import type { StepExecutionContext } from "@/types/workflow/visual"

const mockStartSpan = jest.fn(() => ({ spanId: "span1", traceId: "trace1" }))
const mockEndSpan = jest.fn()
jest.mock("@/lib/agent-trace/emitter", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...(args as [])),
  endSpan: (...args: unknown[]) => mockEndSpan(...(args as [])),
}))

const mockRunRoutedPrompt = jest.fn()
jest.mock("./ai-prompt-routed", () => ({
  runRoutedPrompt: (...args: unknown[]) => mockRunRoutedPrompt(...(args as [])),
  defaultRoutedPromptDeps: jest.fn().mockResolvedValue({ marker: "deps" }),
}))

const mockComplete = jest.fn()
const mockStream = jest.fn()
const mockCreateLlmClient = jest.fn(() => ({
  complete: mockComplete,
  stream: mockStream,
  getUsageSnapshot: () => ({ inputTokens: 7, outputTokens: 3, totalTokens: 10 }),
}))
jest.mock("@/lib/twin/distill/llm", () => ({
  // Keep the real extractJson — ./structured's parseStructured depends on it.
  ...jest.requireActual("@/lib/twin/distill/llm"),
  createLlmClient: (...args: unknown[]) => mockCreateLlmClient(...(args as [])),
}))

jest.mock("@/lib/ai/providers/model-pricing", () => ({
  estimateCallCostUsd: jest.fn(() => 0.0042),
}))

function makeCtx(
  params: Record<string, unknown>,
  extra: Partial<StepExecutionContext> = {}
): StepExecutionContext {
  return {
    runId: "run1",
    workflowId: "wf1",
    stepId: "n1",
    params,
    upstream: {},
    trigger: { kind: "trigger.manual", payload: {} } as StepExecutionContext["trigger"],
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn().mockResolvedValue(undefined),
    ...extra,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockComplete.mockResolvedValue("real completion")
})

describe("executeAiPromptV2 — explicit mode", () => {
  it("falls back to the stub echo when credentials are missing (v1 parity)", async () => {
    const ctx = makeCtx({ userPrompt: "hi" })
    const result = await executeAiPromptV2(ctx)
    const output = result.output as { completion: string; stub: boolean }
    expect(output.stub).toBe(true)
    expect(output.completion).toBe("[ai.prompt stub] hi")
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("stub"))
  })

  it("calls the LLM and reports usage + cost", async () => {
    const reportUsage = jest.fn()
    const ctx = makeCtx(
      { provider: "openai", model: "gpt-x", apiKey: "k", userPrompt: "hi" },
      { reportUsage }
    )
    const result = await executeAiPromptV2(ctx)
    const output = result.output as { completion: string; stub: boolean; costUsd?: number }
    expect(output.completion).toBe("real completion")
    expect(output.stub).toBe(false)
    expect(output.costUsd).toBe(0.0042)
    expect(reportUsage).toHaveBeenCalledWith({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      providerId: "openai",
      modelId: "gpt-x",
      costUsd: 0.0042,
    })
    expect(mockEndSpan).toHaveBeenCalledWith(
      "span1",
      expect.objectContaining({ responseModel: "gpt-x" })
    )
  })

  it("streams through ctx.emitStream when available", async () => {
    mockStream.mockImplementation(async function* () {
      yield "ab"
      yield "cd"
    })
    const emitStream = jest.fn()
    const ctx = makeCtx(
      { provider: "openai", model: "gpt-x", apiKey: "k", userPrompt: "hi" },
      { emitStream }
    )
    const result = await executeAiPromptV2(ctx)
    expect((result.output as { completion: string }).completion).toBe("abcd")
    expect(emitStream.mock.calls.map((c) => c[0])).toEqual(["ab", "cd"])
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it("parses structured output in json mode", async () => {
    mockComplete.mockResolvedValue('{"x": 1}')
    const ctx = makeCtx({
      provider: "openai",
      model: "gpt-x",
      apiKey: "k",
      userPrompt: "hi",
      responseFormat: "json",
    })
    const result = await executeAiPromptV2(ctx)
    expect((result.output as { structured: unknown }).structured).toEqual({ x: 1 })
  })

  it("ends the span with error info when the call fails", async () => {
    mockComplete.mockRejectedValue(new Error("provider down"))
    const ctx = makeCtx({ provider: "openai", model: "gpt-x", apiKey: "k", userPrompt: "hi" })
    await expect(executeAiPromptV2(ctx)).rejects.toThrow("provider down")
    expect(mockEndSpan).toHaveBeenCalledWith(
      "span1",
      expect.objectContaining({ errorMessage: "provider down" })
    )
  })
})

describe("executeAiPromptV2 — PII gate", () => {
  it("blocks PII prompts before any call when piiGate=block", async () => {
    const ctx = makeCtx({
      provider: "openai",
      model: "gpt-x",
      apiKey: "k",
      userPrompt: "email me at bob@example.com",
      piiGate: "block",
    })
    await expect(executeAiPromptV2(ctx)).rejects.toThrow(/PII gate blocked/)
    expect(mockCreateLlmClient).not.toHaveBeenCalled()
    expect(mockRunRoutedPrompt).not.toHaveBeenCalled()
  })

  it("redacts the prompt and flags the output when piiGate=redact", async () => {
    const ctx = makeCtx({
      provider: "openai",
      model: "gpt-x",
      apiKey: "k",
      userPrompt: "email me at bob@example.com",
      piiGate: "redact",
    })
    const result = await executeAiPromptV2(ctx)
    expect((result.output as { piiRedacted?: boolean }).piiRedacted).toBe(true)
    const sentPrompt = mockComplete.mock.calls[0][0] as string
    expect(sentPrompt).not.toContain("bob@example.com")
  })
})

describe("executeAiPromptV2 — routed mode", () => {
  it("delegates to runRoutedPrompt and reports routed usage", async () => {
    mockRunRoutedPrompt.mockResolvedValue({
      provider: "p2",
      model: "m2",
      completion: "routed text",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      costUsd: 0.01,
      attempts: 2,
      routingReason: "alias fast",
    })
    const reportUsage = jest.fn()
    const ctx = makeCtx({ mode: "routed", modelAlias: "fast", userPrompt: "hi" }, { reportUsage })
    const result = await executeAiPromptV2(ctx)
    const output = result.output as Record<string, unknown>
    expect(output.completion).toBe("routed text")
    expect(output.provider).toBe("p2")
    expect(output.attempts).toBe(2)
    expect(output.routingReason).toBe("alias fast")
    expect(reportUsage).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "p2", modelId: "m2", costUsd: 0.01 })
    )
    // The routed call received the gated prompt + delegated logger.
    expect(mockRunRoutedPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ modelAlias: "fast", userPrompt: "hi" }),
      { marker: "deps" }
    )
  })

  it("fails the span and rethrows when routing fails", async () => {
    mockRunRoutedPrompt.mockRejectedValue(new Error("no usable provider"))
    const ctx = makeCtx({ mode: "routed", modelAlias: "fast", userPrompt: "hi" })
    await expect(executeAiPromptV2(ctx)).rejects.toThrow("no usable provider")
    expect(mockEndSpan).toHaveBeenCalledWith(
      "span1",
      expect.objectContaining({ errorMessage: "no usable provider" })
    )
  })

  it("parses routed structured output in json mode", async () => {
    mockRunRoutedPrompt.mockResolvedValue({
      provider: "p1",
      model: "m1",
      completion: '```json\n{"ok":true}\n```',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      attempts: 1,
      routingReason: "r",
    })
    const ctx = makeCtx({
      mode: "routed",
      modelAlias: "fast",
      userPrompt: "hi",
      responseFormat: "json",
    })
    const result = await executeAiPromptV2(ctx)
    expect((result.output as { structured: unknown }).structured).toEqual({ ok: true })
  })
})
