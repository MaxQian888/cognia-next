import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { __resetBackgroundAgentManagerForTesting } from "@/lib/ai/agent/background-agent-manager"
import { runPluginAgent, runPluginAgentStreamed } from "./run"
import type { PluginAgentStreamEvent } from "@/types/plugin/plugin-agent-sdk"

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  __esModule: true,
  executeAgent: jest.fn(),
}))

const mockExecute = executeAgent as jest.MockedFunction<typeof executeAgent>

const baseResult = {
  text: "ok",
  channel: "text" as const,
  toolsAvailable: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetBackgroundAgentManagerForTesting()
  mockExecute.mockResolvedValue({ ...baseResult } as never)
})

describe("runPluginAgent", () => {
  it("maps options onto ExecuteAgentConfig and returns result + agentId", async () => {
    const res = await runPluginAgent("hi", {
      system: "S",
      appendSystem: "A",
      model: "m",
      provider: "openai",
      toolsEnabled: true,
      allowedTools: ["web_fetch"],
      temperature: 0.3,
      outputFormat: { type: "json_schema", schema: { ok: "boolean" } },
    })
    expect(res.text).toBe("ok")
    expect(typeof res.agentId).toBe("string")
    const cfg = mockExecute.mock.calls[0][1]!
    expect(cfg).toMatchObject({
      systemPrompt: "S",
      appendSystem: "A",
      model: "m",
      defaultProvider: "openai",
      toolsEnabled: true,
      allowedTools: ["web_fetch"],
      temperature: 0.3,
    })
    expect(cfg.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("honours a caller-supplied agentId", async () => {
    const res = await runPluginAgent("hi", {}, { agentId: "fixed-id" })
    expect(res.agentId).toBe("fixed-id")
  })

  it("maps every optional field (tools/characterId/cwd/maxSteps/timeoutMs) onto the config", async () => {
    await runPluginAgent(
      "hi",
      {
        characterId: "char-1",
        cwd: "/repo",
        maxSteps: 5,
        timeoutMs: 9000,
        tools: [
          {
            name: "t1",
            description: "d",
            parameters: { type: "object" },
            schema: { type: "object" },
            execute: async () => "r",
            canUseTool: async () => ({ behavior: "allow" as const }),
          },
        ],
      },
      { pluginId: "p", label: "L" }
    )
    const cfg = mockExecute.mock.calls[0][1]!
    expect(cfg).toMatchObject({
      characterId: "char-1",
      cwd: "/repo",
      maxSteps: 5,
      timeoutMs: 9000,
    })
    expect(cfg.tools).toHaveLength(1)
    expect(cfg.tools![0]).toMatchObject({ name: "t1", description: "d" })
    // The mapped tool's execute always resolves to a Promise.
    await expect(cfg.tools![0].execute({})).resolves.toBe("r")
  })

  it("passes a run-level-only gate that allows unchanged input through untouched", async () => {
    await runPluginAgent("hi", {
      canUseTool: async () => ({ behavior: "allow" as const }),
    })
    const gate = mockExecute.mock.calls[0][1]!.canUseTool!
    await expect(gate("t", { a: 1 }, {})).resolves.toEqual({ behavior: "allow" })
  })

  it("short-circuits when the run-level gate denies", async () => {
    await runPluginAgent("hi", {
      canUseTool: async () => ({ behavior: "deny" as const, message: "no" }),
    })
    const gate = mockExecute.mock.calls[0][1]!.canUseTool!
    await expect(gate("t", { a: 1 }, {})).resolves.toEqual({ behavior: "deny", message: "no" })
  })

  it("combines the caller abortSignal with the managed signal", async () => {
    const controller = new AbortController()
    await runPluginAgent("hi", { abortSignal: controller.signal })
    const cfg = mockExecute.mock.calls[0][1]!
    expect(cfg.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("does not pass a canUseTool when neither run- nor tool-level gate is set", async () => {
    await runPluginAgent("hi", {})
    expect(mockExecute.mock.calls[0][1]!.canUseTool).toBeUndefined()
  })

  it("composes tool-level then run-level gates (rewrite chains through)", async () => {
    const runGate = jest.fn(async (_n: string, input: Record<string, unknown>) => ({
      behavior: "allow" as const,
      updatedInput: { ...input, run: true },
    }))
    await runPluginAgent("hi", {
      canUseTool: runGate,
      tools: [
        {
          name: "t",
          execute: async () => null,
          canUseTool: async (_n, input) => ({
            behavior: "allow" as const,
            updatedInput: { ...input, tool: true },
          }),
        },
      ],
    })
    const gate = mockExecute.mock.calls[0][1]!.canUseTool!
    const decision = await gate("t", { a: 1 }, {})
    expect(decision).toEqual({ behavior: "allow", updatedInput: { a: 1, tool: true, run: true } })
    expect(runGate).toHaveBeenCalledWith("t", { a: 1, tool: true }, {})
  })

  it("short-circuits when the tool-level gate denies", async () => {
    const runGate = jest.fn()
    await runPluginAgent("hi", {
      canUseTool: runGate as never,
      tools: [
        {
          name: "t",
          execute: async () => null,
          canUseTool: async () => ({ behavior: "deny" as const, message: "no" }),
        },
      ],
    })
    const gate = mockExecute.mock.calls[0][1]!.canUseTool!
    const decision = await gate("t", { a: 1 }, {})
    expect(decision).toEqual({ behavior: "deny", message: "no" })
    expect(runGate).not.toHaveBeenCalled()
  })
})

describe("runPluginAgentStreamed", () => {
  it("forwards executor events to the stream and resolves the result", async () => {
    mockExecute.mockImplementation(async (_p, cfg) => {
      cfg?.onEvent?.({ type: "text-delta", delta: "he" })
      cfg?.onEvent?.({ type: "tool-call", toolName: "t", input: {} })
      return { ...baseResult, text: "hello" } as never
    })
    const run = runPluginAgentStreamed("hi", {})
    const events: PluginAgentStreamEvent[] = []
    for await (const ev of run) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["text-delta", "tool-call", "result"])
    await expect(run.result).resolves.toMatchObject({ text: "hello" })
  })

  it("fails the stream when the executor throws", async () => {
    mockExecute.mockRejectedValue(new Error("kaput") as never)
    const run = runPluginAgentStreamed("hi", {})
    await expect(run.result).rejects.toThrow("kaput")
  })

  it("combines a caller abortSignal in the streamed path and threads run meta", async () => {
    let seenSignal: AbortSignal | undefined
    mockExecute.mockImplementation(async (_p, cfg) => {
      seenSignal = cfg?.abortSignal
      return { ...baseResult } as never
    })
    const controller = new AbortController()
    const run = runPluginAgentStreamed(
      "hi",
      { abortSignal: controller.signal },
      { pluginId: "p", label: "L", agentId: "stream-1" }
    )
    expect(run.agentId).toBe("stream-1")
    await run.result
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it("cancel() aborts the underlying run signal", async () => {
    let seenSignal: AbortSignal | undefined
    mockExecute.mockImplementation(async (_p, cfg) => {
      seenSignal = cfg?.abortSignal
      return { ...baseResult } as never
    })
    const run = runPluginAgentStreamed("hi", {})
    run.cancel()
    await run.result.catch(() => undefined)
    expect(seenSignal?.aborted).toBe(true)
  })
})
