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

jest.mock("./remote-run-client", () => ({
  subscribeRemoteExternalRun: (runId: string, h: never) => {
    subscribedRunId = runId
    handlers = h
    return stop
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
    })
    handlers?.onTerminal("completed")
    await run
    expect(started[0]).toMatchObject({
      model: "z-ai/glm-5.3-flash",
      reasoningEffort: "high",
    })
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

describe("interruptRemoteHostAgent", () => {
  it("cancels the run", async () => {
    await interruptRemoteHostAgent("run-1")
    expect(cancelled).toEqual(["run-1"])
  })
})
