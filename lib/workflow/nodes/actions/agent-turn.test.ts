import { runAgentTurn } from "./agent-turn"
import type { StepExecutionContext } from "@/types/workflow/visual"

const mockStartSpan = jest.fn(() => ({ spanId: "span1", traceId: "trace1" }))
const mockEndSpan = jest.fn()
jest.mock("@cognia/agent-trace/emitter", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...(args as [])),
  endSpan: (...args: unknown[]) => mockEndSpan(...(args as [])),
}))

const mockExecuteAgent = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: (...args: unknown[]) => mockExecuteAgent(...(args as [])),
}))

const mockIsTauri = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn().mockResolvedValue({
    defaultProvider: "openai",
    providerSettings: { openai: { apiKey: "k" } },
    customProviders: [],
  }),
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
  mockExecuteAgent.mockResolvedValue({
    text: "agent reply",
    finishReason: "stop",
    channel: "text",
    toolsAvailable: false,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  })
})

describe("runAgentTurn", () => {
  it("rejects an empty prompt with a non-retryable error", async () => {
    await expect(runAgentTurn(makeCtx({ prompt: "  " }))).rejects.toThrow(/non-empty 'prompt'/)
    try {
      await runAgentTurn(makeCtx({}))
    } catch (err) {
      expect((err as Error & { retryable?: boolean }).retryable).toBe(false)
    }
    expect(mockExecuteAgent).not.toHaveBeenCalled()
  })

  it("runs the agent and returns text + channel + usage", async () => {
    const reportUsage = jest.fn()
    const result = await runAgentTurn(makeCtx({ prompt: "do it", model: "m1" }, { reportUsage }))
    const output = result.output as Record<string, unknown>
    expect(output.text).toBe("agent reply")
    expect(output.channel).toBe("text")
    expect(output.toolsAvailable).toBe(false)
    expect(output.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    expect(reportUsage).toHaveBeenCalledWith(
      expect.objectContaining({ totalTokens: 30, modelId: "m1" })
    )
    expect(mockEndSpan).toHaveBeenCalledWith(
      "span1",
      expect.objectContaining({ outputPreview: "agent reply" })
    )
  })

  it("threads params + provider snapshot into executeAgent", async () => {
    await runAgentTurn(
      makeCtx({
        prompt: "go",
        characterId: "char1",
        systemPrompt: "be brief",
        allowedTools: ["Bash"],
        maxTurns: 5,
        temperature: 0.2,
        cwd: "C:/repo",
      })
    )
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({
        characterId: "char1",
        systemPrompt: "be brief",
        allowedTools: ["Bash"],
        maxSteps: 5,
        temperature: 0.2,
        cwd: "C:/repo",
        toolsEnabled: true,
        timeoutMs: 600_000,
        defaultProvider: "openai",
      })
    )
  })

  it("warns when tools were requested but unavailable (honest degradation)", async () => {
    const ctx = makeCtx({ prompt: "go" })
    await runAgentTurn(ctx)
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("text-only completion"))
  })

  it("fails fast (non-retryable) when requireTools is set off-desktop", async () => {
    mockIsTauri.mockReturnValue(false)
    await expect(runAgentTurn(makeCtx({ prompt: "go", requireTools: true }))).rejects.toThrow(
      /tools required/
    )
    expect(mockExecuteAgent).not.toHaveBeenCalled()
  })

  it("proceeds with requireTools on desktop", async () => {
    mockIsTauri.mockReturnValue(true)
    mockExecuteAgent.mockResolvedValue({
      text: "tooled reply",
      channel: "sidecar",
      toolsAvailable: true,
    })
    const ctx = makeCtx({ prompt: "go", requireTools: true })
    const result = await runAgentTurn(ctx)
    expect((result.output as { toolsAvailable: boolean }).toolsAvailable).toBe(true)
    expect(ctx.log).not.toHaveBeenCalled()
  })

  it("skips usage reporting when the channel reports none", async () => {
    mockExecuteAgent.mockResolvedValue({
      text: "x",
      channel: "sidecar",
      toolsAvailable: true,
    })
    const reportUsage = jest.fn()
    await runAgentTurn(makeCtx({ prompt: "go" }, { reportUsage }))
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it("ends the span with error info and rethrows on failure", async () => {
    mockExecuteAgent.mockRejectedValue(new Error("agent exploded"))
    await expect(runAgentTurn(makeCtx({ prompt: "go" }))).rejects.toThrow("agent exploded")
    expect(mockEndSpan).toHaveBeenCalledWith(
      "span1",
      expect.objectContaining({ errorMessage: "agent exploded" })
    )
  })

  it("forwards ctx.emitStream as the delta sink", async () => {
    const emitStream = jest.fn()
    await runAgentTurn(makeCtx({ prompt: "go" }, { emitStream }))
    expect(mockExecuteAgent).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ onDelta: emitStream })
    )
  })
})
