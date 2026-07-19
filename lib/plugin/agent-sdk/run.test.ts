import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { __resetBackgroundAgentManagerForTesting } from "@/lib/ai/agent/background-agent-manager"
import { runPluginAgent, runPluginAgentStreamed } from "./run"
import type { PluginAgentStreamEvent } from "@/types/plugin/plugin-agent-sdk"
import {
  __resetContextProvidersForTesting,
  registerContextProvider,
} from "@/lib/plugin/registries/context-provider-registry"

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
  __resetContextProvidersForTesting()
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

  it("fails closed before execution when a context provider contributes PII", async () => {
    registerContextProvider("contacts", {
      id: "contacts",
      provide: () => "Contact alice@example.com before continuing",
    })

    await expect(runPluginAgent("hi")).rejects.toThrow("outbound PII gate")
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("fails closed before execution when the prompt or system input contains PII", async () => {
    await expect(
      runPluginAgent("Email alice@example.com", { system: "Use local context" })
    ).rejects.toThrow("outbound PII gate")
    await expect(
      runPluginAgent("hello", { system: "Use the account alice@example.com" })
    ).rejects.toThrow("outbound PII gate")
    expect(mockExecute).not.toHaveBeenCalled()
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
  it("fails closed before streamed execution when the outbound input contains PII", async () => {
    const run = runPluginAgentStreamed("Email alice@example.com", {})

    await expect(run.result).rejects.toThrow("outbound PII gate")
    expect(mockExecute).not.toHaveBeenCalled()
  })

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

describe("lifecycle hooks", () => {
  it("runs onPreToolUse last in the gate chain (tool → run → preToolUse)", async () => {
    const order: string[] = []
    await runPluginAgent("hi", {
      canUseTool: async (_n, input) => {
        order.push("run")
        return { behavior: "allow" as const, updatedInput: { ...input, run: true } }
      },
      tools: [
        {
          name: "t",
          execute: async () => null,
          canUseTool: async (_n, input) => {
            order.push("tool")
            return { behavior: "allow" as const, updatedInput: { ...input, tool: true } }
          },
        },
      ],
      hooks: {
        onPreToolUse: async (_n, input) => {
          order.push("pre")
          return { behavior: "allow" as const, updatedInput: { ...input, pre: true } }
        },
      },
    })
    const gate = mockExecute.mock.calls[0][1]!.canUseTool!
    const decision = await gate("t", { a: 1 }, {})
    expect(order).toEqual(["tool", "run", "pre"])
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: { a: 1, tool: true, run: true, pre: true },
    })
  })

  it("onPreToolUse deny short-circuits the chain", async () => {
    await runPluginAgent("hi", {
      hooks: {
        onPreToolUse: async () => ({ behavior: "deny" as const, message: "blocked by hook" }),
      },
    })
    const gate = mockExecute.mock.calls[0][1]!.canUseTool!
    await expect(gate("t", {}, {})).resolves.toEqual({
      behavior: "deny",
      message: "blocked by hook",
    })
  })

  it("forwards onPostToolUse onto the executor config", async () => {
    const onPostToolUse = jest.fn()
    await runPluginAgent("hi", { hooks: { onPostToolUse } })
    expect(mockExecute.mock.calls[0][1]!.onPostToolUse).toBe(onPostToolUse)
  })

  it("fires onStop with the final result on the one-shot path", async () => {
    mockExecute.mockResolvedValue({
      text: "done",
      channel: "sidecar",
      toolsAvailable: true,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    } as never)
    const onStop = jest.fn()
    await runPluginAgent("hi", { hooks: { onStop } })
    await Promise.resolve()
    expect(onStop).toHaveBeenCalledWith(
      {
        text: "done",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        channel: "sidecar",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it("fires onStop on the streamed path too", async () => {
    mockExecute.mockResolvedValue({ ...baseResult, text: "streamed" } as never)
    const onStop = jest.fn()
    const run = runPluginAgentStreamed("hi", { hooks: { onStop } })
    for await (const _ev of run) void _ev
    await Promise.resolve()
    expect(onStop).toHaveBeenCalledWith(
      expect.objectContaining({ text: "streamed", channel: "text" }),
      expect.any(Object)
    )
  })

  it("swallows a throwing onStop (best-effort)", async () => {
    const onStop = jest.fn(() => {
      throw new Error("hook boom")
    })
    await expect(runPluginAgent("hi", { hooks: { onStop } })).resolves.toMatchObject({
      text: "ok",
    })
  })
})

describe("guardrails", () => {
  it("aborts the run before executeAgent when an input guardrail trips", async () => {
    await expect(
      runPluginAgent("hi", {
        guardrails: [
          { id: "block", type: "input", run: () => ({ tripwireTriggered: true, message: "no" }) },
        ],
      })
    ).rejects.toMatchObject({ name: "PluginGuardrailTripwireError", stage: "input" })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it("rejects when an output guardrail trips after the run", async () => {
    mockExecute.mockResolvedValue({ ...baseResult, text: "leaky" } as never)
    await expect(
      runPluginAgent("hi", {
        guardrails: [
          { id: "out", type: "output", run: () => ({ tripwireTriggered: true, message: "bad" }) },
        ],
      })
    ).rejects.toMatchObject({ stage: "output", guardrailId: "out" })
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it("passes the run through when guardrails do not trip", async () => {
    await expect(
      runPluginAgent("hi", {
        guardrails: [{ id: "ok", type: "input", run: () => ({ tripwireTriggered: false }) }],
      })
    ).resolves.toMatchObject({ text: "ok" })
  })

  it("fails the streamed run when an input guardrail trips", async () => {
    const run = runPluginAgentStreamed("hi", {
      guardrails: [{ id: "b", type: "input", run: () => ({ tripwireTriggered: true }) }],
    })
    await expect(run.result).rejects.toBeDefined()
  })
})

describe("robustness (Package F)", () => {
  it("maps maxTurns onto maxSteps when maxSteps is unset", async () => {
    await runPluginAgent("hi", { maxTurns: 7 })
    expect(mockExecute.mock.calls[0][1]!.maxSteps).toBe(7)
  })

  it("maxSteps wins over maxTurns", async () => {
    await runPluginAgent("hi", { maxSteps: 3, maxTurns: 7 })
    expect(mockExecute.mock.calls[0][1]!.maxSteps).toBe(3)
  })

  it("retries once with fallbackModel when the primary run throws", async () => {
    mockExecute
      .mockRejectedValueOnce(new Error("primary down") as never)
      .mockResolvedValueOnce({ ...baseResult, text: "fallback ok" } as never)
    const res = await runPluginAgent("hi", { model: "primary", fallbackModel: "backup" })
    expect(res.text).toBe("fallback ok")
    expect(mockExecute).toHaveBeenCalledTimes(2)
    expect(mockExecute.mock.calls[1][1]!.model).toBe("backup")
  })

  it("does not retry without a fallbackModel", async () => {
    mockExecute.mockRejectedValue(new Error("down") as never)
    await expect(runPluginAgent("hi", {})).rejects.toThrow("down")
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it("does not fallback on the streamed path (single attempt)", async () => {
    mockExecute.mockRejectedValue(new Error("down") as never)
    const run = runPluginAgentStreamed("hi", { fallbackModel: "backup" })
    await expect(run.result).rejects.toThrow("down")
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })
})
