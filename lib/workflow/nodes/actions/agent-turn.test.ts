import { runAgentTurn } from "./agent-turn"
import type { StepExecutionContext } from "@/types/workflow/visual"

const mockStartSpan = jest.fn(() => ({ spanId: "span1", traceId: "trace1" }))
const mockEndSpan = jest.fn()
jest.mock("@cognia/agent-trace/emitter", () => ({
  startSpan: (...args: unknown[]) => mockStartSpan(...(args as [])),
  endSpan: (...args: unknown[]) => mockEndSpan(...(args as [])),
}))

// ADR-0090: `runAgentTurn` dispatches through the unified service, which
// consumes these rails directly. There is no `executeAgent` hop to mock any
// more — asserting on the rail is asserting on what the turn actually ran.
const mockRunAgentRail = jest.fn()
const mockRunCompletionRail = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  runAgentRail: (...args: unknown[]) => mockRunAgentRail(...(args as [])),
  runCompletionRail: (...args: unknown[]) => mockRunCompletionRail(...(args as [])),
}))

const mockIsTauri = jest.fn(() => false)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

const mockIsHeadlessHost = jest.fn(() => false)
jest.mock("@/lib/platform/detect", () => ({
  isHeadlessHost: () => mockIsHeadlessHost(),
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn().mockResolvedValue({
    defaultProvider: "openai",
    providerSettings: { openai: { apiKey: "k" } },
    customProviders: [],
    modelMappings: [],
    routingConfig: { strategy: "reliability", maxFallbackAttempts: 2 },
    autoRouting: { enabled: true, defaultSelection: "auto" },
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
  mockIsTauri.mockReturnValue(false)
  mockIsHeadlessHost.mockReturnValue(false)
  const reply = {
    text: "agent reply",
    finishReason: "stop",
    channel: "text",
    toolsAvailable: false,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  }
  mockRunCompletionRail.mockResolvedValue(reply)
  mockRunAgentRail.mockResolvedValue(reply)
})

describe("runAgentTurn", () => {
  it("forces connector-origin prompts through the block/redact policy", async () => {
    const extra = {
      securityContext: {
        piiEgressRequired: true,
        sourceTriggerKind: "trigger.connector.inbound" as const,
      },
    }
    await expect(
      runAgentTurn(makeCtx({ prompt: "email alice@example.com", piiGate: "off" }, extra))
    ).rejects.toMatchObject({ code: "pii_blocked", retryable: false })
    expect(mockRunCompletionRail).not.toHaveBeenCalled()

    const result = await runAgentTurn(
      makeCtx({ prompt: "email alice@example.com", piiGate: "redact" }, extra)
    )
    expect(mockRunCompletionRail).toHaveBeenCalledWith(
      expect.not.stringContaining("alice@example.com"),
      expect.any(Object)
    )
    expect(result.output).toMatchObject({ piiRedacted: true })
  })

  it("rejects an empty prompt with a non-retryable error", async () => {
    await expect(runAgentTurn(makeCtx({ prompt: "  " }))).rejects.toThrow(/non-empty 'prompt'/)
    try {
      await runAgentTurn(makeCtx({}))
    } catch (err) {
      expect((err as Error & { retryable?: boolean }).retryable).toBe(false)
    }
    expect(mockRunCompletionRail).not.toHaveBeenCalled()
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
    expect(mockRunCompletionRail).toHaveBeenCalledWith(
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
        modelMappings: [],
        routingConfig: expect.objectContaining({ strategy: "reliability" }),
        autoRouting: expect.objectContaining({ defaultSelection: "auto" }),
      })
    )
  })

  it("applies the parent IM ceiling only to the dynamic agent turn", async () => {
    const permissionCeiling = { allowedTools: ["Read"], disallowedTools: ["Bash"] }
    await runAgentTurn(
      makeCtx(
        { prompt: "go" },
        {
          securityContext: {
            piiEgressRequired: true,
            sourceTriggerKind: "trigger.manual",
            permissionCeiling,
          },
        }
      )
    )

    expect(mockRunCompletionRail).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ permissionCeiling })
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
    expect(mockRunCompletionRail).not.toHaveBeenCalled()
  })

  it("proceeds with requireTools on desktop", async () => {
    mockIsTauri.mockReturnValue(true)
    mockRunAgentRail.mockResolvedValue({
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
    mockRunCompletionRail.mockResolvedValue({
      text: "x",
      channel: "sidecar",
      toolsAvailable: true,
    })
    const reportUsage = jest.fn()
    await runAgentTurn(makeCtx({ prompt: "go" }, { reportUsage }))
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it("ends the span with error info and rethrows on failure", async () => {
    mockRunCompletionRail.mockRejectedValue(new Error("agent exploded"))
    await expect(runAgentTurn(makeCtx({ prompt: "go" }))).rejects.toThrow("agent exploded")
    expect(mockEndSpan).toHaveBeenCalledWith(
      "span1",
      expect.objectContaining({ errorMessage: "agent exploded" })
    )
  })

  it("forwards ctx.emitStream as the delta sink", async () => {
    const emitStream = jest.fn()
    await runAgentTurn(makeCtx({ prompt: "go" }, { emitStream }))
    expect(mockRunCompletionRail).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ onDelta: emitStream })
    )
  })

  it("projects commentary events through the dedicated workflow progress sink", async () => {
    const emitCommentary = jest.fn()
    mockRunCompletionRail.mockImplementation(async (_prompt, config) => {
      config.onEvent?.({
        type: "commentary-delta",
        delta: "Checking the repository",
        messageId: "c1",
        done: false,
      })
      return { text: "done", channel: "sidecar", toolsAvailable: true }
    })

    await runAgentTurn(makeCtx({ prompt: "go" }, { emitCommentary }))

    expect(emitCommentary).toHaveBeenCalledWith("Checking the repository")
  })

  describe("typed output (D3)", () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" }, score: { type: "number" } },
      required: ["verdict", "score"],
    }

    it("requests outputFormat and surfaces a validated object", async () => {
      mockRunCompletionRail.mockResolvedValue({
        text: '{"verdict":"ok","score":1}',
        channel: "text",
        toolsAvailable: false,
        object: { verdict: "ok", score: 1 },
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      })
      const result = await runAgentTurn(makeCtx({ prompt: "judge", outputSchema: schema }))
      const output = result.output as Record<string, unknown>
      expect(output.object).toEqual({ verdict: "ok", score: 1 })
      expect(output.schemaValid).toBe(true)
      expect(mockRunCompletionRail).toHaveBeenCalledWith(
        "judge",
        expect.objectContaining({ outputFormat: { type: "json_schema", schema } })
      )
    })

    it("auto-fixes once, accumulating usage across the retry", async () => {
      mockRunCompletionRail
        .mockResolvedValueOnce({
          text: "{}",
          channel: "text",
          toolsAvailable: false,
          object: { verdict: "ok" },
          usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
        })
        .mockResolvedValueOnce({
          text: "{}",
          channel: "text",
          toolsAvailable: false,
          object: { verdict: "ok", score: 3 },
          usage: { inputTokens: 6, outputTokens: 6, totalTokens: 12 },
        })
      const result = await runAgentTurn(makeCtx({ prompt: "judge", outputSchema: schema }))
      const output = result.output as Record<string, unknown>
      expect(output.schemaValid).toBe(true)
      expect(output.usage).toEqual({ inputTokens: 10, outputTokens: 10, totalTokens: 20 })
      // Second call carries the corrective re-prompt.
      expect(mockRunCompletionRail.mock.calls[1][0]).toMatch(/score/)
    })

    it("throws into the errorPolicy when the schema is unmet (fail default)", async () => {
      mockRunCompletionRail.mockResolvedValue({
        text: "{}",
        channel: "text",
        toolsAvailable: false,
        object: { verdict: "ok" },
      })
      await expect(
        runAgentTurn(makeCtx({ prompt: "judge", outputSchema: schema }))
      ).rejects.toThrow(/did not satisfy/)
      expect(mockRunCompletionRail).toHaveBeenCalledTimes(2)
    })

    it("returns the unvalidated object in soft mode", async () => {
      mockRunCompletionRail.mockResolvedValue({
        text: "{}",
        channel: "text",
        toolsAvailable: false,
        object: { verdict: "ok" },
      })
      const result = await runAgentTurn(
        makeCtx({ prompt: "judge", outputSchema: schema, onSchemaViolation: "soft" })
      )
      const output = result.output as Record<string, unknown>
      expect(output.schemaValid).toBe(false)
      expect(output.object).toEqual({ verdict: "ok" })
      expect((output.schemaErrors as string[]).join("\n")).toMatch(/score/)
    })

    it("ignores an empty schema (no typed-output path)", async () => {
      await runAgentTurn(makeCtx({ prompt: "go", outputSchema: {} }))
      expect(mockRunCompletionRail).toHaveBeenCalledWith(
        "go",
        expect.not.objectContaining({ outputFormat: expect.anything() })
      )
    })
  })

  describe("ADR-0090 unified service path", () => {
    beforeEach(() => {
      mockRunCompletionRail.mockResolvedValue({
        text: "completion rail",
        finishReason: "stop",
        channel: "text",
        toolsAvailable: false,
      })
      mockRunAgentRail.mockResolvedValue({
        text: "agent rail",
        finishReason: "stop",
        channel: "sidecar",
        toolsAvailable: true,
      })
    })
    it("requireTools with no host fails closed with the PINNED legacy copy, before any spend", async () => {
      mockIsTauri.mockReturnValue(false)
      await expect(runAgentTurn(makeCtx({ prompt: "go", requireTools: true }))).rejects.toThrow(
        "action.agent.turn: tools required but the desktop sidecar is unavailable " +
          "(web/mobile run). Unset 'requireTools' to allow the text-only fallback."
      )
      expect(mockRunAgentRail).not.toHaveBeenCalled()
      expect(mockRunCompletionRail).not.toHaveBeenCalled()
    })

    it("legacy tool degradation surfaces degradedReason on the node output", async () => {
      mockIsTauri.mockReturnValue(false)
      const result = await runAgentTurn(makeCtx({ prompt: "go" }))
      const output = result.output as Record<string, unknown>
      expect(output.text).toBe("completion rail")
      expect(output.channel).toBe("text")
      expect(output.degradedReason).toBe("legacy-completion-fallback")
      expect(mockRunAgentRail).not.toHaveBeenCalled()
    })

    it("routes through the agent rail on a desktop host", async () => {
      mockIsTauri.mockReturnValue(true)
      const result = await runAgentTurn(makeCtx({ prompt: "go", requireTools: true }))
      const output = result.output as Record<string, unknown>
      expect(output.text).toBe("agent rail")
      expect(output.channel).toBe("sidecar")
      expect(output.degradedReason).toBeUndefined()
      expect(mockRunAgentRail).toHaveBeenCalledTimes(1)
    })

    it("routes through the agent rail on a headless host", async () => {
      mockIsHeadlessHost.mockReturnValue(true)
      const result = await runAgentTurn(makeCtx({ prompt: "go", requireTools: true }))
      const output = result.output as Record<string, unknown>
      expect(output.text).toBe("agent rail")
      expect(output.channel).toBe("sidecar")
      expect(mockRunAgentRail).toHaveBeenCalledTimes(1)
      expect(mockRunCompletionRail).not.toHaveBeenCalled()
    })
  })
})
