import type { ExternalAgentEvent } from "@/types/agent/external-agent"

const started: Array<Record<string, unknown>> = []
const cancelled: string[] = []
const stop = jest.fn()
let handlers:
  | {
      onEvent: (e: ExternalAgentEvent, f: unknown) => void
      onTerminal: (t: string, e?: string) => void
      onGap?: (expected: number, received: number) => void
    }
  | undefined
let startReply: unknown = { started: true, runId: "run-1" }
let subscribedRunId: string | undefined

const channelReady: string[] = []
jest.mock("./remote-run-client", () => ({
  subscribeRemoteExternalRun: (runId: string, h: never) => {
    subscribedRunId = runId
    handlers = h
    return stop
  },
  whenRemoteRunChannelSubscribed: async () => {
    channelReady.push(`ready:${started.length}`)
  },
  startRemoteExternalTurn: async (input: Record<string, unknown>) => {
    started.push(input)
    return startReply
  },
  cancelRemoteExternalTurn: async (runId: string) => {
    cancelled.push(runId)
    return true
  },
}))

const recordReportedAgentModelSurface = jest.fn()
jest.mock("../../capability/model-surface-cache", () => ({
  recordReportedAgentModelSurface: (...args: unknown[]) => recordReportedAgentModelSurface(...args),
}))
let mountIsLocal = false
jest.mock("../../config/host-config-mount", () => ({
  hostConfigCatalogMountIsLocal: () => mountIsLocal,
}))
let hostTakesCogniaModel = true
jest.mock("./remote-host-configs", () => {
  class HostCogniaModelUpdateRequiredError extends Error {
    readonly code = "host-update-required"
    readonly i18nKey = "externalAgent.cogniaModel.hostUpdateRequired"
  }
  return {
    HostCogniaModelUpdateRequiredError,
    hostSupportsCogniaModelTurns: () => hostTakesCogniaModel,
  }
})

import { executeOnRemoteHostAgent, interruptRemoteHostAgent } from "./remote-execute"

const STAMP = { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 1 }

function evt(over: Partial<ExternalAgentEvent> & { type: string }): ExternalAgentEvent {
  return { timestamp: new Date(0), ...over } as ExternalAgentEvent
}

beforeEach(() => {
  started.length = 0
  cancelled.length = 0
  handlers = undefined
  subscribedRunId = undefined
  startReply = { started: true, runId: "run-1" }
  stop.mockClear()
  recordReportedAgentModelSurface.mockClear()
  mountIsLocal = false
  hostTakesCogniaModel = true
})

// The Host reports the session's options at the end of each turn. This client
// cannot write to that session, so what it keeps is a SEEDED surface: a pick is
// persisted and the Host applies it at the start of the next turn.
describe("the Host's report of the session's models", () => {
  const KIMI_OPTIONS = [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "kimi-code/kimi-for-coding",
      options: [
        { value: "kimi-code/kimi-for-coding", name: "K2.8 Preview" },
        { value: "kimi-code/k3", name: "K3" },
      ],
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: "max",
      options: [
        { value: "low", name: "Thinking Low" },
        { value: "max", name: "Thinking Max" },
      ],
    },
  ]

  it("records it for the conversation, seeded, and still forwards the event", async () => {
    const onEvent = jest.fn()
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "chat-1",
      newRunId: () => "run-1",
      onEvent,
    })
    const report = evt({
      type: "config_options_update",
      sessionId: "kimi-session",
      configOptions: KIMI_OPTIONS,
    } as never)
    handlers?.onEvent(report, {})
    handlers?.onTerminal("completed")
    await run
    expect(recordReportedAgentModelSurface).toHaveBeenCalledWith(
      "eac_1",
      "chat-1",
      "kimi-session",
      {
        models: {
          choices: [
            { modelId: "kimi-code/kimi-for-coding", name: "K2.8 Preview" },
            { modelId: "kimi-code/k3", name: "K3" },
          ],
          currentModelId: "kimi-code/kimi-for-coding",
          write: { kind: "session-seed" },
        },
        thinking: {
          levels: ["low", "max"],
          currentLevel: "max",
          write: { kind: "config-option", optionId: "thinking" },
        },
      }
    )
    expect(onEvent).toHaveBeenCalledWith(report)
  })

  it("leaves a configuration mounted in this process to its live surface", async () => {
    mountIsLocal = true
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "chat-1",
      newRunId: () => "run-1",
    })
    handlers?.onEvent(
      evt({
        type: "config_options_update",
        sessionId: "kimi-session",
        configOptions: KIMI_OPTIONS,
      } as never),
      {}
    )
    handlers?.onTerminal("completed")
    await run
    expect(recordReportedAgentModelSurface).not.toHaveBeenCalled()
  })

  it("ignores every other event", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "chat-1",
      newRunId: () => "run-1",
    })
    handlers?.onEvent(evt({ type: "message_delta", sessionId: "s", delta: "x" } as never), {})
    handlers?.onTerminal("completed")
    await run
    expect(recordReportedAgentModelSurface).not.toHaveBeenCalled()
  })
})

describe("executeOnRemoteHostAgent", () => {
  // The composer resolves the model and the thinking level once for both
  // lanes, so this executor has to carry them exactly as the local one does.
  it("forwards the model and the thinking level to the host", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "chat-1",
      newRunId: () => "run-1",
      model: "z-ai/glm-5.3-flash",
      reasoningEffort: "high",
      systemPrompt: "Selected skill: verify results",
      allowedTools: ["read"],
    })
    handlers?.onTerminal("completed")
    await run
    expect(started[0]).toMatchObject({
      model: "z-ai/glm-5.3-flash",
      reasoningEffort: "high",
      systemPrompt: "Selected skill: verify results",
      allowedTools: ["read"],
    })
  })

  it("rejects caller-local MCP and unsafe instructions before subscribing", async () => {
    const options = { stamp: STAMP, chatSessionId: "chat-1" }
    await expect(
      executeOnRemoteHostAgent("hi", {
        ...options,
        mcpServers: [{ type: "http", name: "local", url: "http://127.0.0.1:4444", headers: [] }],
      })
    ).rejects.toThrow("configure tools on the target host")
    await expect(
      executeOnRemoteHostAgent("hi", { ...options, systemPrompt: "Contact test@example.com" })
    ).rejects.toThrow("PII gate")
    expect(started).toHaveLength(0)
    expect(subscribedRunId).toBeUndefined()
  })

  // The host streams from the moment it accepts, so a subscription opened
  // after the RPC returned would miss the opening frames.
  it("subscribes before it starts the turn", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "chat-1",
      newRunId: () => "run-1",
    })
    expect(subscribedRunId).toBe("run-1")
    handlers?.onTerminal("completed")
    await run
  })

  it("sends the stamp and the chat session", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "chat-1",
      newRunId: () => "run-1",
    })
    handlers?.onTerminal("completed")
    await run
    expect(started[0]).toMatchObject({ runId: "run-1", chatSessionId: "chat-1", stamp: STAMP })
  })

  it("resolves on the terminal frame with the assembled text", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
    })
    handlers?.onEvent(evt({ type: "message_delta", delta: { text: "Hel" } } as never), {})
    handlers?.onEvent(evt({ type: "content_block_delta", text: "lo" } as never), {})
    handlers?.onTerminal("completed")
    const result = await run
    expect(result).toMatchObject({ success: true, finalResponse: "Hello", runId: "run-1" })
  })

  it("reads a delta given as a bare string", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
    })
    handlers?.onEvent(evt({ type: "message_delta", delta: "raw" } as never), {})
    handlers?.onTerminal("completed")
    expect((await run)?.finalResponse).toBe("raw")
  })

  it("ignores a delta with no text rather than appending undefined", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
    })
    handlers?.onEvent(evt({ type: "message_delta", delta: { blocks: [] } } as never), {})
    handlers?.onTerminal("completed")
    expect((await run)?.finalResponse).toBe("")
  })

  it("captures the agent's own session id for a later resume", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
    })
    handlers?.onEvent(evt({ type: "session_start", sessionId: "agent-9" }), {})
    handlers?.onTerminal("completed")
    expect((await run)?.sessionId).toBe("agent-9")
  })

  it("forwards every event to the caller unchanged", async () => {
    const seen: string[] = []
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
      onEvent: (e) => seen.push(e.type),
    })
    handlers?.onEvent(evt({ type: "permission_request" }), {})
    handlers?.onEvent(evt({ type: "message_delta", delta: { text: "x" } } as never), {})
    handlers?.onTerminal("completed")
    await run
    expect(seen).toEqual(["permission_request", "message_delta"])
  })

  // `null` is the local path's "no external agent available for this request",
  // so the controller's existing refusal handling applies without a new branch.
  it("returns null when the host refuses to start", async () => {
    startReply = { started: false, refusal: { kind: "config", reason: "stale-revision" } }
    await expect(
      executeOnRemoteHostAgent("hi", {
        stamp: STAMP,
        chatSessionId: "c",
        newRunId: () => "run-1",
      })
    ).resolves.toBeNull()
    expect(stop).toHaveBeenCalled()
  })

  it("reports a failed turn as unsuccessful with the host's message", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
    })
    handlers?.onTerminal("failed", "spawn failed")
    const result = await run
    expect(result).toMatchObject({ success: false, error: "spawn failed" })
  })

  it("reports a cancelled turn as unsuccessful", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
    })
    handlers?.onTerminal("cancelled")
    expect(await run).toMatchObject({ success: false, error: "cancelled" })
  })

  it("unsubscribes once the turn ends", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
    })
    handlers?.onTerminal("completed")
    await run
    expect(stop).toHaveBeenCalled()
  })

  it("passes a resume id through", async () => {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      externalSessionId: "agent-7",
      newRunId: () => "run-1",
    })
    handlers?.onTerminal("completed")
    await run
    expect(started[0]).toMatchObject({ externalSessionId: "agent-7" })
  })

  it("forwards a gap to the caller", async () => {
    const gaps: Array<[number, number]> = []
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "c",
      newRunId: () => "run-1",
      onGap: (a, b) => gaps.push([a, b]),
    })
    handlers?.onGap?.(2, 5)
    handlers?.onTerminal("completed")
    await run
    expect(gaps).toEqual([[2, 5]])
  })
})

// Host-lane Cognia models (ADR-0090, 2026-10-02). The Host runs the gateway
// with its own credentials; this client only names the binding.
describe("Cognia model selection on the Host lane", () => {
  const BINDING = { providerId: "kimi-sub", modelId: "kimi-k2", accountId: "acct-1" }

  async function runWith(options: Record<string, unknown>) {
    const run = executeOnRemoteHostAgent("hi", {
      stamp: STAMP,
      chatSessionId: "chat-1",
      newRunId: () => "run-1",
      ...options,
    })
    handlers?.onTerminal("completed")
    return run
  }

  it("forwards a binding to a Host that accepts it", async () => {
    await runWith({ cogniaModel: BINDING })
    expect(started[0]).toMatchObject({ cogniaModel: BINDING })
  })

  it("sends an explicit null, which is not the same as omitting it", async () => {
    await runWith({ cogniaModel: null })
    expect(started[0]).toHaveProperty("cogniaModel", null)
    started.length = 0
    await runWith({})
    expect(started[0]).not.toHaveProperty("cogniaModel")
  })

  it("resumes a gateway task session on a Host that accepts it", async () => {
    await runWith({ externalSessionId: "cognia-gateway:task_1:native", cogniaModel: BINDING })
    expect(started[0]).toMatchObject({ externalSessionId: "cognia-gateway:task_1:native" })
  })

  it("asks for a Host update instead of sending a binding an older Host would refuse", async () => {
    hostTakesCogniaModel = false
    await expect(runWith({ cogniaModel: BINDING })).rejects.toMatchObject({
      code: "host-update-required",
      i18nKey: "externalAgent.cogniaModel.hostUpdateRequired",
    })
    await expect(
      runWith({ externalSessionId: "cognia-gateway:task_1:native" })
    ).rejects.toMatchObject({ code: "host-update-required" })
    expect(started).toHaveLength(0)
    expect(subscribedRunId).toBeUndefined()
  })

  it("lets an older Host's own configuration decide a native turn", async () => {
    hostTakesCogniaModel = false
    await runWith({ cogniaModel: null })
    expect(started[0]).not.toHaveProperty("cogniaModel")
  })
})

describe("interruptRemoteHostAgent", () => {
  it("cancels the run", async () => {
    await interruptRemoteHostAgent("run-1")
    expect(cancelled).toEqual(["run-1"])
  })
})

it("waits for the run topic to be acknowledged before starting the turn", async () => {
  channelReady.length = 0
  const run = executeOnRemoteHostAgent("go", { stamp: STAMP, chatSessionId: "chat-1" })
  await Promise.resolve()
  await Promise.resolve()
  // Subscribed first, acknowledged second, started third: `ready:0` records
  // that no turn had been started when the acknowledgement was awaited.
  expect(subscribedRunId).toBeDefined()
  expect(channelReady).toEqual(["ready:0"])
  expect(started).toHaveLength(1)
  handlers?.onTerminal("completed")
  await run
})
