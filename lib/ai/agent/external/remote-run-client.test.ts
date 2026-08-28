import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"

const calls: Array<{ command: string; payload: unknown }> = []
let subscriber: ((frame: unknown) => void) | undefined
let subscribedTopic: string | undefined
const unsubscribe = jest.fn()
let reply: unknown = {}

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: async (command: string, payload: unknown) => {
      calls.push({ command, payload })
      return reply
    },
    subscribe: (topic: string, handler: (frame: unknown) => void) => {
      subscribedTopic = topic
      subscriber = handler
      return unsubscribe
    },
  },
}))

import {
  HostConfigsUnsupportedError,
  __setRemoteHostConfigDepsForTests,
} from "./remote-host-configs"
import {
  EXTERNAL_RUN_EVENT_TOPIC,
  REMOTE_RUN_COMMANDS,
  cancelRemoteExternalTurn,
  resolveRemoteElicitation,
  resolveRemotePermission,
  startRemoteExternalTurn,
  subscribeRemoteExternalRun,
  type RemoteRunFrame,
} from "./remote-run-client"

function frame(over: Partial<RemoteRunFrame> = {}): RemoteRunFrame {
  return {
    runId: "run-1",
    chatSessionId: "chat-1",
    seq: 1,
    event: { type: "message_delta", timestamp: new Date(0) } as ExternalAgentEvent,
    ...over,
  }
}

function watch() {
  const events: RemoteRunFrame[] = []
  const terminals: Array<[string, string | undefined]> = []
  const gaps: Array<[number, number]> = []
  const stop = subscribeRemoteExternalRun("run-1", {
    onEvent: (_e, f) => events.push(f),
    onTerminal: (t, e) => terminals.push([t, e]),
    onGap: (expected, received) => gaps.push([expected, received]),
  })
  return { events, terminals, gaps, stop }
}

// Every run command rides the `external-agent.host-configs` handshake, so a
// test that does not declare a host is testing the refusal, not the call.
let restoreDeps: (() => void) | undefined

beforeEach(() => {
  calls.length = 0
  subscriber = undefined
  subscribedTopic = undefined
  reply = {}
  unsubscribe.mockClear()
  restoreDeps = __setRemoteHostConfigDepsForTests({
    hasLocalAuthority: () => true,
    isRemoteHostActive: () => false,
  })
})

afterEach(() => {
  restoreDeps?.()
  restoreDeps = undefined
})

describe("host support", () => {
  // Without the gate this surfaced as a raw "unknown command" from the
  // transport, which tells a user nothing about which side is out of date.
  it("refuses a run on a host that does not advertise the run plane", async () => {
    restoreDeps?.()
    restoreDeps = __setRemoteHostConfigDepsForTests({
      hasLocalAuthority: () => false,
      isRemoteHostActive: () => true,
      // Only the fields the gate reads; the rest of the manifest is
      // irrelevant here and would be noise.
      activeHostFeatureManifest: () =>
        ({
          schemaVersion: 1,
          features: {
            "external-agent.host-configs": {
              version: 1,
              operations: ["external_agent_config_list"],
            },
          },
        }) as unknown as HostFeatureManifest,
    })

    await expect(
      startRemoteExternalTurn({
        runId: "run-1",
        chatSessionId: "chat-1",
        stamp: { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 1 },
        prompt: "hi",
      })
    ).rejects.toBeInstanceOf(HostConfigsUnsupportedError)
    expect(calls).toEqual([])
  })
})

describe("subscribing", () => {
  it("listens on the run event topic", () => {
    watch()
    expect(subscribedTopic).toBe(EXTERNAL_RUN_EVENT_TOPIC)
  })

  it("delivers frames for its own run", () => {
    const w = watch()
    subscriber?.(frame())
    expect(w.events).toHaveLength(1)
  })

  it("ignores another run's frames on the shared topic", () => {
    const w = watch()
    subscriber?.(frame({ runId: "run-2" }))
    expect(w.events).toEqual([])
  })

  it("ignores a malformed frame", () => {
    const w = watch()
    subscriber?.(undefined)
    subscriber?.(null)
    expect(w.events).toEqual([])
  })

  // The bus replays from a cursor that spans every topic, so a client will see
  // frames it has already applied.
  it("drops a replayed frame", () => {
    const w = watch()
    subscriber?.(frame({ seq: 1 }))
    subscriber?.(frame({ seq: 2 }))
    subscriber?.(frame({ seq: 1 }))
    subscriber?.(frame({ seq: 2 }))
    expect(w.events.map((f) => f.seq)).toEqual([1, 2])
  })

  it("reports a gap instead of rendering a hole", () => {
    const w = watch()
    subscriber?.(frame({ seq: 1 }))
    subscriber?.(frame({ seq: 4 }))
    expect(w.gaps).toEqual([[2, 4]])
    // Still delivered — the frame is real, the client just knows it is late.
    expect(w.events.map((f) => f.seq)).toEqual([1, 4])
  })

  it("does not report a gap on the first frame it sees", () => {
    const w = watch()
    subscriber?.(frame({ seq: 1 }))
    expect(w.gaps).toEqual([])
  })

  it("calls onTerminal once and then goes quiet", () => {
    const w = watch()
    subscriber?.(frame({ seq: 1 }))
    subscriber?.(frame({ seq: 2, terminal: "completed" }))
    subscriber?.(frame({ seq: 3 }))
    subscriber?.(frame({ seq: 4, terminal: "failed", error: "late" }))
    expect(w.terminals).toEqual([["completed", undefined]])
    expect(w.events.map((f) => f.seq)).toEqual([1, 2])
  })

  it("carries the failure message on a failed terminal", () => {
    const w = watch()
    subscriber?.(frame({ seq: 1, terminal: "failed", error: "spawn failed" }))
    expect(w.terminals).toEqual([["failed", "spawn failed"]])
  })

  it("hands back the transport's unsubscribe", () => {
    const w = watch()
    w.stop()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe("starting a turn", () => {
  const stamp = { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 2 }

  it("sends the stamp and the chat session", async () => {
    reply = { started: true, runId: "run-1", agentId: "eac_1" }
    await expect(
      startRemoteExternalTurn({ runId: "run-1", chatSessionId: "chat-1", stamp, prompt: "hi" })
    ).resolves.toEqual({ started: true, runId: "run-1", agentId: "eac_1" })
    expect(calls[0]).toEqual({
      command: REMOTE_RUN_COMMANDS.run,
      payload: { runId: "run-1", chatSessionId: "chat-1", prompt: "hi", stamp },
    })
  })

  it("omits externalSessionId when there is nothing to resume", async () => {
    reply = { started: true, runId: "run-1" }
    await startRemoteExternalTurn({ runId: "run-1", chatSessionId: "c", stamp, prompt: "hi" })
    expect(calls[0].payload).not.toHaveProperty("externalSessionId")
  })

  it("passes a resume id through", async () => {
    reply = { started: true, runId: "run-1" }
    await startRemoteExternalTurn({
      runId: "run-1",
      chatSessionId: "c",
      stamp,
      prompt: "hi",
      externalSessionId: "agent-9",
    })
    expect(calls[0].payload).toMatchObject({ externalSessionId: "agent-9" })
  })

  it("surfaces the host's refusal", async () => {
    reply = { started: false, refusal: { kind: "readiness", status: "needs-credentials" } }
    await expect(
      startRemoteExternalTurn({ runId: "run-1", chatSessionId: "c", stamp, prompt: "hi" })
    ).resolves.toMatchObject({ started: false, refusal: { kind: "readiness" } })
  })

  // A host that says started with no run id has told the client nothing it can
  // subscribe to or cancel, so it is treated as a refusal.
  it("refuses a start that carries no run id", async () => {
    reply = { started: true }
    const result = await startRemoteExternalTurn({
      runId: "run-1",
      chatSessionId: "c",
      stamp,
      prompt: "hi",
    })
    expect(result.started).toBe(false)
  })
})

describe("control", () => {
  it("reports whether the cancel is what ended the run", async () => {
    reply = { cancelled: true }
    await expect(cancelRemoteExternalTurn("run-1")).resolves.toBe(true)
    reply = { cancelled: false }
    await expect(cancelRemoteExternalTurn("run-1")).resolves.toBe(false)
  })

  it("answers a permission", async () => {
    reply = { resolved: true }
    await expect(resolveRemotePermission("run-1:req-1", "allow")).resolves.toEqual({
      resolved: true,
    })
    expect(calls[0]).toEqual({
      command: REMOTE_RUN_COMMANDS.resolve,
      payload: { decisionId: "run-1:req-1", decision: "allow" },
    })
  })

  it("answers an elicitation without sending a request id", async () => {
    reply = { resolved: true }
    await resolveRemoteElicitation("run-1:el-1", { requestId: "x", action: "cancel" })
    expect(calls[0].payload).toMatchObject({
      decisionId: "run-1:el-1",
      elicitation: { action: "cancel" },
    })
  })

  it("distinguishes an expired question from someone else's", async () => {
    reply = { resolved: false, reason: "wrong-device" }
    await expect(resolveRemotePermission("d", "deny")).resolves.toEqual({
      resolved: false,
      reason: "wrong-device",
    })
    reply = { resolved: false }
    await expect(resolveRemotePermission("d", "deny")).resolves.toEqual({
      resolved: false,
      reason: "unknown",
    })
  })
})
