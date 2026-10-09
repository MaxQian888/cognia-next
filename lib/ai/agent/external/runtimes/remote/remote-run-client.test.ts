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

const uploads: Array<{ scope: string; name: string; mediaType: string; bytes: number[] }> = []
let uploadFails = false
jest.mock("@/lib/companion/attachment-upload-client", () => ({
  uploadSessionAttachment: async (
    scope: string,
    file: { name: string; mediaType: string; bytes: Uint8Array }
  ) => {
    if (uploadFails) throw new Error("attachment_too_many")
    uploads.push({ scope, name: file.name, mediaType: file.mediaType, bytes: [...file.bytes] })
    return {
      ref: `cognia-upload:${uploads.length}`,
      name: file.name,
      mediaType: file.mediaType,
      size: file.bytes.length,
      hash: "h",
    }
  },
}))

import {
  HostConfigsUnsupportedError,
  __setRemoteHostConfigDepsForTests,
} from "./remote-host-configs"
import {
  createRemoteSessionOperationsClient,
  watchRemoteSession,
  EXTERNAL_RUN_EVENT_TOPIC,
  REMOTE_RUN_COMMANDS,
  cancelRemoteExternalTurn,
  resolveRemoteElicitation,
  resolveRemotePermission,
  stageRemoteRunAttachments,
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

  // The defect: the run plane was declared `signed-policy`, a gate no client
  // can satisfy, and the call carried nothing. Picking a host-owned agent in
  // the composer answered 428 "an active host policy is required" for as long
  // as the feature had existed. It is `interactive` now, like every sibling
  // write, and the lease has to ride along or the host refuses it again.
  it("carries an approval lease when a paired client starts the turn", async () => {
    const leaseOperations: string[][] = []
    restoreDeps?.()
    restoreDeps = __setRemoteHostConfigDepsForTests({
      hasLocalAuthority: () => false,
      isRemoteHostActive: () => false,
      getRuntimeSnapshot: (() => ({
        host: { compatible: true, operations: Object.values(REMOTE_RUN_COMMANDS) },
      })) as never,
      issueAdminLease: async (operations) => {
        leaseOperations.push(operations)
        return { token: "lease-run", operations, expiresAt: Date.now() + 60_000 }
      },
    })
    reply = { started: true, runId: "run-1", agentId: "pi" }

    await expect(
      startRemoteExternalTurn({
        runId: "run-1",
        chatSessionId: "chat-1",
        stamp: { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 1 },
        prompt: "hi",
      })
    ).resolves.toEqual({ started: true, runId: "run-1", agentId: "pi" })

    expect(leaseOperations).toEqual([[REMOTE_RUN_COMMANDS.run]])
    expect(calls[0].payload).toMatchObject({ adminLease: "lease-run" })
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

  // The two axes the host lane had no way to carry. A conversation bound to a
  // host configuration ran on the agent's own default model however loudly the
  // composer chip promised otherwise.
  it("sends the model and the thinking level the composer picked", async () => {
    reply = { started: true, runId: "run-1" }
    await startRemoteExternalTurn({
      runId: "run-1",
      chatSessionId: "c",
      stamp,
      prompt: "hi",
      model: "z-ai/glm-5.3-flash",
      reasoningEffort: "high",
      systemPrompt: "Selected skill: verify results",
      allowedTools: ["read"],
    })
    expect(calls[0].payload).toMatchObject({
      model: "z-ai/glm-5.3-flash",
      reasoningEffort: "high",
      systemPrompt: "Selected skill: verify results",
      allowedTools: ["read"],
    })
  })

  // Omitted, not null. The request schema is `additionalProperties: false` and
  // the host reads a missing key as "inherit whatever the configuration says",
  // so a null would be both a 422 and a lie about what was chosen.
  it("omits the model axes when nothing was picked", async () => {
    reply = { started: true, runId: "run-1" }
    await startRemoteExternalTurn({ runId: "run-1", chatSessionId: "c", stamp, prompt: "hi" })
    expect(calls[0].payload).not.toHaveProperty("model")
    expect(calls[0].payload).not.toHaveProperty("reasoningEffort")
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

  // Host-lane Cognia models. Unlike the model axes above, `null` IS sent: it is
  // the explicit "native models" instruction and the Host must not read it as
  // "inherit the configuration's binding".
  describe("the Cognia model binding", () => {
    const binding = { providerId: "kimi-sub", modelId: "kimi-k2", accountId: null }

    it("sends a binding by its three fields only", async () => {
      reply = { started: true, runId: "run-1" }
      await startRemoteExternalTurn({
        runId: "run-1",
        chatSessionId: "c",
        stamp,
        prompt: "hi",
        cogniaModel: { ...binding, apiKey: "sk-should-not-travel" } as never,
      })
      expect((calls[0].payload as Record<string, unknown>).cogniaModel).toEqual(binding)
    })

    it("keeps an omitted account omitted", async () => {
      reply = { started: true, runId: "run-1" }
      await startRemoteExternalTurn({
        runId: "run-1",
        chatSessionId: "c",
        stamp,
        prompt: "hi",
        cogniaModel: { providerId: "p", modelId: "m" },
      })
      expect((calls[0].payload as Record<string, unknown>).cogniaModel).toEqual({
        providerId: "p",
        modelId: "m",
      })
    })

    it("sends an explicit null and omits an absent binding", async () => {
      reply = { started: true, runId: "run-1" }
      await startRemoteExternalTurn({
        runId: "run-1",
        chatSessionId: "c",
        stamp,
        prompt: "hi",
        cogniaModel: null,
      })
      expect(calls[0].payload).toHaveProperty("cogniaModel", null)
      await startRemoteExternalTurn({ runId: "run-2", chatSessionId: "c", stamp, prompt: "hi" })
      expect(calls[1].payload).not.toHaveProperty("cogniaModel")
    })
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

describe("the turn's images", () => {
  const stamp = { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 2 }
  const image = (data: string, mediaType = "image/png") =>
    ({ type: "image", source: { type: "base64", data, mediaType } }) as const

  beforeEach(() => {
    uploads.length = 0
    uploadFails = false
  })

  it("stages each image under its own run-scoped upload, in order", async () => {
    await expect(
      stageRemoteRunAttachments("rer_1", [image("AQID"), image("BAUG", "image/jpeg")])
    ).resolves.toEqual([
      { ref: "cognia-upload:1", name: "image-1.png", mediaType: "image/png" },
      { ref: "cognia-upload:2", name: "image-2.jpg", mediaType: "image/jpeg" },
    ])
    expect(uploads).toEqual([
      {
        scope: "external-run:rer_1:0",
        name: "image-1.png",
        mediaType: "image/png",
        bytes: [1, 2, 3],
      },
      {
        scope: "external-run:rer_1:1",
        name: "image-2.jpg",
        mediaType: "image/jpeg",
        bytes: [4, 5, 6],
      },
    ])
  })

  it("fails the whole staging on the first upload that fails", async () => {
    uploadFails = true
    await expect(stageRemoteRunAttachments("rer_1", [image("AQID")])).rejects.toThrow(
      "attachment_too_many"
    )
  })

  it("refuses more images than a run takes, and an image with no inline bytes", async () => {
    await expect(
      stageRemoteRunAttachments(
        "rer_1",
        Array.from({ length: 97 }, () => image("AQID"))
      )
    ).rejects.toThrow(/at most 96/)
    await expect(
      stageRemoteRunAttachments("rer_1", [
        { type: "image", source: { type: "url", url: "https://x/y.png", mediaType: "image/png" } },
      ])
    ).rejects.toThrow(/inline image bytes/)
    expect(uploads).toEqual([])
  })

  it("names the staged refs on the start, three fields each", async () => {
    reply = { started: true, runId: "run-1" }
    await startRemoteExternalTurn({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp,
      prompt: "hi",
      attachments: [
        { ref: "cognia-upload:1", name: "image-1.png", mediaType: "image/png", extra: 1 } as never,
      ],
    })
    expect((calls[0].payload as { attachments: unknown }).attachments).toEqual([
      { ref: "cognia-upload:1", name: "image-1.png", mediaType: "image/png" },
    ])
    calls.length = 0
    await startRemoteExternalTurn({ runId: "run-2", chatSessionId: "c", stamp, prompt: "hi" })
    expect(calls[0].payload).not.toHaveProperty("attachments")
  })

  it("hands the Host's withheld report to its own handler, not to onEvent", () => {
    const events: unknown[] = []
    const withheld: unknown[] = []
    subscribeRemoteExternalRun("run-1", {
      onEvent: (event) => events.push(event),
      onAttachmentsWithheld: (report) => withheld.push(report),
      onTerminal: () => {},
    })
    subscriber?.(frame({ attachmentsWithheld: { reason: "agent", count: 2 } }))
    expect(withheld).toEqual([{ reason: "agent", count: 2 }])
    expect(events).toEqual([])
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

describe("whenRemoteRunChannelSubscribed", () => {
  it("resolves immediately on a transport without subscription acknowledgements", async () => {
    const { transport } = jest.requireMock("@/lib/tauri") as { transport: Record<string, unknown> }
    delete transport.whenSubscribed
    const { whenRemoteRunChannelSubscribed, EXTERNAL_RUN_EVENT_TOPIC } =
      await import("./remote-run-client")
    await expect(whenRemoteRunChannelSubscribed()).resolves.toBeUndefined()
    expect(EXTERNAL_RUN_EVENT_TOPIC).toBe("external-agent://session-event")
  })

  it("waits on the companion transport's acknowledgement for the run topic", async () => {
    const { transport } = jest.requireMock("@/lib/tauri") as { transport: Record<string, unknown> }
    const whenSubscribed = jest.fn(async (_channels: readonly string[]) => undefined)
    transport.whenSubscribed = whenSubscribed
    try {
      const { whenRemoteRunChannelSubscribed } = await import("./remote-run-client")
      await whenRemoteRunChannelSubscribed()
      expect(whenSubscribed).toHaveBeenCalledWith(["external-agent://session-event"])
    } finally {
      delete transport.whenSubscribed
    }
  })
})

describe("remote native session facade", () => {
  const target = {
    stamp: { configId: "host", revision: "r1", lifecycleGeneration: 1 },
    chatSessionId: "chat",
    externalSessionId: "native",
  }
  it("uses the same exact session and preserves turn fork boundaries through the mutation command", async () => {
    reply = { value: { id: "fork" } }
    const client = createRemoteSessionOperationsClient(target)
    expect(
      await client.forkSession("host", "native", {
        forkAt: { kind: "turn", id: "turn-1", boundary: "before" },
      })
    ).toEqual({ id: "fork" })
    expect(calls.at(-1)).toMatchObject({
      command: "external_agent_session_mutate",
      payload: {
        ...target,
        action: { operation: "fork", forkAt: { kind: "turn", id: "turn-1", boundary: "before" } },
      },
    })
    await expect(client.steerSession("host", undefined, "hello")).rejects.toThrow("required")
    await expect(client.renameSession("host", "another-chat", "name")).rejects.toThrow(
      "target changed"
    )
    expect(calls).toHaveLength(1)
  })
  it("queries capabilities through the read channel", async () => {
    reply = { value: { steering: "supported" } }
    await expect(
      createRemoteSessionOperationsClient(target).getSessionOperationCapabilities("host", "native")
    ).resolves.toEqual({ steering: "supported" })
    expect(calls.at(-1)?.command).toBe("external_agent_session_query")
  })
})

it("reports watch renewal failure before unsubscribing so pending operations settle", async () => {
  jest.useFakeTimers()
  const terminal = jest.fn()
  reply = { value: { session: { id: "native" } } }
  const target = {
    stamp: { configId: "host", revision: "r1", lifecycleGeneration: 1 },
    chatSessionId: "chat",
    externalSessionId: "native",
  }
  const watcher = await watchRemoteSession(
    target,
    { onEvent: jest.fn(), onTerminal: terminal },
    "shell"
  )
  restoreDeps?.()
  restoreDeps = __setRemoteHostConfigDepsForTests({
    hasLocalAuthority: () => false,
    isRemoteHostActive: () => true,
    activeHostFeatureManifest: () => null,
  })
  await jest.advanceTimersByTimeAsync(60_000)
  expect(terminal).toHaveBeenCalledWith("failed", expect.any(String))
  expect(unsubscribe).toHaveBeenCalled()
  await watcher.close()
  jest.useRealTimers()
})

it("rejects unsupported image MIME types before sending a queued host input", async () => {
  const target = {
    stamp: { configId: "host", revision: "r1", lifecycleGeneration: 1 },
    chatSessionId: "chat",
    externalSessionId: "native",
  }
  const client = createRemoteSessionOperationsClient(target)
  await expect(
    client.enqueueSessionInput(
      "host",
      "native",
      { text: "image", images: [{ data: "AAAA", mimeType: "text/html" }] },
      "follow_up"
    )
  ).rejects.toThrow("MIME")
  expect(calls).toHaveLength(0)
})
