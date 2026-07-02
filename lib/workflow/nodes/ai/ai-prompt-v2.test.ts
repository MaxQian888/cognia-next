import { executeAiPromptV2 } from "./ai-prompt-v2"
import type { StepExecutionContext } from "@/types/workflow/visual"

const mockStartSpan = jest.fn(() => ({ spanId: "span1", traceId: "trace1" }))
const mockEndSpan = jest.fn()
jest.mock("@cognia/agent-trace/emitter", () => ({
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

jest.mock("@cognia/provider-core/providers/model-pricing", () => ({
  estimateCallCostUsd: jest.fn(() => 0.0042),
}))

const injectTwinContextMock = jest.fn()
jest.mock("../shared/twin-injector", () => ({
  injectTwinContext: (...args: unknown[]) => injectTwinContextMock(...(args as [])),
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
  injectTwinContextMock.mockResolvedValue({ systemPrompt: "", applied: false })
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

  it("injects twin context into the system prompt for a twin-bound character", async () => {
    injectTwinContextMock.mockResolvedValue({ systemPrompt: "TWIN-WRAPPED", applied: true })
    const ctx = makeCtx({
      provider: "openai",
      model: "gpt-x",
      apiKey: "k",
      systemPrompt: "base",
      userPrompt: "hi",
      characterId: "char_1",
    })

    await executeAiPromptV2(ctx)

    expect(injectTwinContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: "char_1",
        userPrompt: "hi",
        baseSystemPrompt: "base",
        source: "workflow:ai.prompt",
      })
    )
    // The twin context is MERGED with the node base (not replacing it), twin
    // context first and the node prompt last.
    expect(mockComplete).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ system: "TWIN-WRAPPED\n\nbase" })
    )
  })

  it("preserves the node systemPrompt + JSON instruction when twin context applies in json mode", async () => {
    injectTwinContextMock.mockResolvedValue({ systemPrompt: "TWIN-WRAPPED", applied: true })
    mockComplete.mockResolvedValue('{"x": 1}')
    const ctx = makeCtx({
      provider: "openai",
      model: "gpt-x",
      apiKey: "k",
      systemPrompt: "node-base",
      userPrompt: "hi",
      characterId: "char_1",
      responseFormat: "json",
    })

    await executeAiPromptV2(ctx)

    const sentSystem = mockComplete.mock.calls[0][1].system as string
    expect(sentSystem).toContain("TWIN-WRAPPED")
    expect(sentSystem).toContain("node-base")
    // The JSON-mode instruction survives the twin merge.
    expect(sentSystem).toContain("Respond with ONLY a single valid JSON value")
  })

  it("keeps the original system prompt when the injector does not apply", async () => {
    injectTwinContextMock.mockResolvedValue({ systemPrompt: "IGNORED", applied: false })
    const ctx = makeCtx({
      provider: "openai",
      model: "gpt-x",
      apiKey: "k",
      systemPrompt: "base",
      userPrompt: "hi",
      characterId: "char_1",
    })

    await executeAiPromptV2(ctx)

    expect(mockComplete).toHaveBeenCalledWith("hi", expect.objectContaining({ system: "base" }))
  })

  it("does not consult the twin injector when no characterId is set", async () => {
    const ctx = makeCtx({ provider: "openai", model: "gpt-x", apiKey: "k", userPrompt: "hi" })
    await executeAiPromptV2(ctx)
    expect(injectTwinContextMock).not.toHaveBeenCalled()
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
