import type { ExternalAgentEvent } from "@/types/agent/external-agent"
import type { TranscriptLiveFrame } from "@/lib/chat/transcript/live-frames"
import { createPersonProcessPlane, type PersonPlaneTransport } from "./process-plane"
import {
  createPersonAgentRunner,
  personAgentPrompt,
  PERSON_AGENT_IDLE_MS,
  PERSON_AGENT_WORKSPACE,
  type PersonAgentManager,
  type PersonAgentRunnerDeps,
} from "./runner"

const at = new Date(0)

function event(value: Record<string, unknown>): ExternalAgentEvent {
  return { timestamp: at, ...value } as unknown as ExternalAgentEvent
}

/** A turn's events, released by the test so a turn can be held open. */
function scripted(events: ExternalAgentEvent[]) {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release,
    held: false,
    async *run(hold: boolean) {
      for (const [index, value] of events.entries()) {
        if (hold && index === events.length - 1) await gate
        yield value
      }
    },
  }
}

function harness(options: { holdLast?: boolean } = {}) {
  const transportHandlers = new Map<string, Array<(payload: unknown) => void>>()
  const transport = {
    call: jest.fn(async () => null),
    subscribe: <T>(name: string, handler: (payload: T) => void) => {
      transportHandlers.set(name, [
        ...(transportHandlers.get(name) ?? []),
        handler as (payload: unknown) => void,
      ])
      return () => undefined
    },
    whenSubscribed: async () => undefined,
  }
  const plane = createPersonProcessPlane(transport as unknown as PersonPlaneTransport)
  const turns: Array<ReturnType<typeof scripted>> = []
  const manager = {
    addAgent: jest.fn(async () => undefined),
    removeAgent: jest.fn(async () => undefined),
    executeStreaming: jest.fn(() => {
      const next = turns.shift()
      if (!next) throw new Error("no scripted turn")
      return next.run(options.holdLast ?? false)
    }),
    cancel: jest.fn(async () => undefined),
    respondToPermission: jest.fn(async () => undefined),
    respondToElicitation: jest.fn(async () => undefined),
  } satisfies PersonAgentManager
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  let ids = 0
  const settled: Array<{ actionId: string; outcome: string; errorCode?: string }> = []
  const writes: Array<{ sessionId: string; id: string; parts: unknown[] }> = []
  const envelopes: Array<{ eventId: string; event: Record<string, unknown> }> = []
  const liveFrames: TranscriptLiveFrame[] = []
  /** What reached the member and the store, in order. */
  const order: string[] = []
  const deps: PersonAgentRunnerDeps = {
    plane,
    manager,
    prepareLease: jest.fn(async () => ({ ticketId: "t", secret: "lease-secret", expiresAtMs: 1 })),
    launchFor: (runtimeId) =>
      runtimeId === "claude-agent-acp"
        ? {
            config: {
              id: "preset",
              name: "Claude",
              protocol: "acp",
              transport: "stdio",
              enabled: true,
              process: { command: "claude-agent-acp", args: [] },
            } as never,
            family: "claude",
          }
        : undefined,
    history: jest.fn(async () => "User: earlier\n\nAssistant: reply"),
    writeMessage: jest.fn(async (sessionId, message) => {
      writes.push({ sessionId, id: message.id, parts: message.parts })
      order.push(`write:${message.parts.length}`)
    }),
    settle: jest.fn(async (actionId, input) => {
      settled.push({ actionId, outcome: input.outcome, errorCode: input.errorCode })
      await input.writeTranscript?.()
    }),
    project: jest.fn(async (envelope) => {
      envelopes.push({
        eventId: envelope.eventId,
        event: envelope.event as unknown as Record<string, unknown>,
      })
    }),
    publishLive: jest.fn(async (frame) => {
      liveFrames.push(frame)
      order.push(`live:${frame.state}`)
    }),
    transcriptRevision: jest.fn(async () => 7),
    applyEvent: (parts, value) =>
      value.type === "message_delta"
        ? [...parts, { type: "text", text: value.delta.text } as never]
        : (parts as never),
    pickAllowOption: (choices) =>
      Array.isArray(choices)
        ? (choices as Array<{ optionId: string; kind: string }>).find((option) =>
            option.kind.startsWith("allow")
          )?.optionId
        : undefined,
    newId: () => `id${++ids}`,
    now: () => 0,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    log: () => undefined,
  }
  const runner = createPersonAgentRunner(deps)
  const emit = (name: string, payload: unknown) => {
    for (const handler of transportHandlers.get(name) ?? []) handler(payload)
  }
  return {
    runner,
    deps,
    manager,
    turns,
    timers,
    settled,
    writes,
    envelopes,
    liveFrames,
    order,
    plane,
    emit,
  }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  session: { id: "s1" },
  runtimeId: "claude-agent-acp",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  prompt: "hello",
  actionId: "a1",
  messageId: "m1",
  ...overrides,
})

const flush = () => new Promise((resolve) => setImmediate(resolve))
/** Settling reads the revision and sends the final live frame first. */
const drain = async () => {
  for (let round = 0; round < 4; round += 1) await flush()
}

const replyTurn = (text = "hi") =>
  scripted([
    event({ type: "session_start", sessionId: "native-1" }),
    event({ type: "message_delta", sessionId: "native-1", delta: { type: "text", text } }),
    event({ type: "done", sessionId: "native-1", success: true, stopReason: "end_turn" }),
  ])

describe("person agent runner", () => {
  it("p6e launches one sandboxed process with only the brokered lease", async () => {
    const h = harness()
    h.turns.push(replyTurn())
    await h.runner.startTurn(request())
    await flush()
    expect(h.deps.prepareLease).toHaveBeenCalledWith({
      runtimeId: "claude-agent-acp",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      sessionId: "person-agent-id1",
    })
    expect(h.manager.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "person-agent-id1",
        process: {
          command: "claude-agent-acp",
          args: [],
          cwd: PERSON_AGENT_WORKSPACE,
          env: {
            COGNIA_GATEWAY_TOKEN: "lease-secret",
            COGNIA_GATEWAY_TASK_CONFIG: JSON.stringify({
              taskId: "person-agent-id1",
              runtime: "claude",
            }),
          },
        },
      })
    )
    // The first turn of a fresh process carries the conversation so far.
    expect(h.deps.history).toHaveBeenCalledWith("s1", ["m1", "assistant-a1"])
    expect(h.manager.executeStreaming).toHaveBeenCalledWith("person-agent-id1", "hello", {
      workingDirectory: PERSON_AGENT_WORKSPACE,
      context: { custom: { conversationHistory: "User: earlier\n\nAssistant: reply" } },
    })
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "completed", errorCode: undefined }])
    expect(h.writes.at(-1)).toEqual({
      sessionId: "s1",
      id: "assistant-a1",
      parts: [{ type: "text", text: "hi" }],
    })
    expect(h.envelopes.map((entry) => entry.event)).toEqual([
      { kind: "queue", phase: "accepted", queueId: "a1", delivery: "after-settle" },
      { kind: "queue", phase: "delivered", queueId: "a1", delivery: "after-settle" },
      { kind: "lifecycle", phase: "started" },
      { kind: "lifecycle", phase: "ended" },
    ])
    expect(new Set(h.envelopes.map((entry) => entry.eventId)).size).toBe(4)
  })

  it("p6e streams the reply live to the member's devices, the final frame before the write", async () => {
    const h = harness({ holdLast: true })
    const turn = scripted([
      event({ type: "session_start", sessionId: "native-1" }),
      event({ type: "message_delta", sessionId: "native-1", delta: { type: "text", text: "hel" } }),
      event({ type: "message_delta", sessionId: "native-1", delta: { type: "text", text: "lo" } }),
      event({ type: "done", sessionId: "native-1", success: true, stopReason: "end_turn" }),
    ])
    h.turns.push(turn)
    await h.runner.startTurn(request())
    await flush()
    // The first change goes out at once, whole; the next waits for its slot.
    expect(h.liveFrames).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        messageId: "assistant-a1",
        replyTo: "m1",
        seq: 1,
        keyframe: true,
        state: "streaming",
        parts: [{ type: "text", text: "hel" }],
      }),
    ])
    const slot = h.timers.find((timer) => timer.ms === 100 && !timer.cleared)
    expect(slot).toBeDefined()
    slot!.callback()
    await flush()
    expect(h.liveFrames[1]).toEqual(
      expect.objectContaining({
        seq: 2,
        base: 1,
        keyframe: false,
        parts: [{ type: "text", text: "lo" }],
      })
    )
    turn.release()
    await flush()
    await flush()
    expect(h.liveFrames[2]).toEqual(
      expect.objectContaining({
        seq: 3,
        base: 0,
        keyframe: true,
        state: "settled",
        parts: [
          { type: "text", text: "hel" },
          { type: "text", text: "lo" },
        ],
        // What was persisted before it: the device waits for a newer timeline.
        afterRevision: 7,
      })
    )
    expect(h.order.indexOf("live:settled")).toBeLessThan(h.order.lastIndexOf("write:2"))
  })

  it("p6e sends no live frame for a turn that never produced a part", async () => {
    const h = harness()
    h.turns.push(
      scripted([
        event({ type: "session_start", sessionId: "native-1" }),
        event({ type: "done", sessionId: "native-1", success: true, stopReason: "end_turn" }),
      ])
    )
    await h.runner.startTurn(request())
    await flush()
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "no_response", errorCode: undefined }])
    expect(h.liveFrames).toEqual([])
  })

  it("p6e keeps the process between turns and reaps it when idle", async () => {
    const h = harness()
    h.turns.push(replyTurn(), replyTurn("again"))
    await h.runner.startTurn(request())
    await drain()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2" }))
    await drain()
    expect(h.manager.addAgent).toHaveBeenCalledTimes(1)
    expect(h.deps.history).toHaveBeenCalledTimes(1)
    expect(h.manager.executeStreaming).toHaveBeenLastCalledWith("person-agent-id1", "hello", {
      sessionId: "native-1",
      workingDirectory: PERSON_AGENT_WORKSPACE,
    })
    const idle = h.timers.filter((timer) => !timer.cleared)
    expect(idle).toHaveLength(1)
    expect(idle[0].ms).toBe(PERSON_AGENT_IDLE_MS)
    idle[0].callback()
    await flush()
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    expect(h.runner.liveAgent("s1")).toBeUndefined()
  })

  it("p6e starts a new process and lease when the model changes", async () => {
    const h = harness()
    h.turns.push(replyTurn(), replyTurn())
    await h.runner.startTurn(request())
    await flush()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2", model: "claude-opus" }))
    await flush()
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    expect(h.deps.prepareLease).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "claude-opus", sessionId: "person-agent-id2" })
    )
    expect(h.runner.liveAgent("s1")).toMatchObject({ agentId: "person-agent-id2" })
  })

  it("p6e grants tool permissions in the sandbox and declines elicitations", async () => {
    const h = harness()
    h.turns.push(
      scripted([
        event({ type: "session_start", sessionId: "native-1" }),
        event({
          type: "permission_request",
          sessionId: "native-1",
          request: {
            id: "p1",
            toolInfo: {},
            options: [
              { optionId: "no", kind: "reject_once", name: "No" },
              { optionId: "yes", kind: "allow_once", name: "Yes" },
            ],
          },
        }),
        event({ type: "elicitation_request", sessionId: "native-1", request: { id: "e1" } }),
        event({ type: "async_questions", sessionId: "native-1", requestId: "q1", questions: [] }),
        event({ type: "done", sessionId: "native-1", success: true }),
      ])
    )
    await h.runner.startTurn(request())
    await flush()
    expect(h.manager.respondToPermission).toHaveBeenCalledWith("person-agent-id1", "native-1", {
      requestId: "p1",
      granted: true,
      optionId: "yes",
      reason: "granted inside the member's sandbox",
    })
    expect(h.manager.respondToElicitation).toHaveBeenCalledWith("person-agent-id1", {
      requestId: "e1",
      action: "decline",
    })
    expect(h.manager.respondToPermission).toHaveBeenCalledWith(
      "person-agent-id1",
      "native-1",
      expect.objectContaining({ requestId: "q1", granted: false })
    )
    // Nothing visible was produced.
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "no_response", errorCode: undefined }])
  })

  it("p6e settles with the Host's stop reason and drops the process", async () => {
    const h = harness({ holdLast: true })
    const turn = scripted([
      event({ type: "session_start", sessionId: "native-1" }),
      event({
        type: "message_delta",
        sessionId: "native-1",
        delta: { type: "text", text: "partial" },
      }),
      event({ type: "error", sessionId: "native-1", error: "process exited" }),
    ])
    h.turns.push(turn)
    await h.plane.watchStops()
    await h.runner.startTurn(request())
    await flush()
    h.emit("external-agent://state-change", {
      agentId: "person-agent-id1",
      state: "Stopping",
      reason: "person_workspace_quota_exceeded",
    })
    turn.release()
    await flush()
    await flush()
    expect(h.settled).toEqual([
      { actionId: "a1", outcome: "failed", errorCode: "person_workspace_quota_exceeded" },
    ])
    expect(h.envelopes.at(-1)?.event).toMatchObject({
      kind: "failure",
      code: "person_workspace_quota_exceeded",
    })
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    expect(h.runner.liveAgent("s1")).toBeUndefined()
    // The partial reply is kept.
    expect(h.writes.at(-1)?.parts).toEqual([{ type: "text", text: "partial" }])
  })

  it("p6e watches the Host's stop channels before any spawn", async () => {
    const h = harness()
    await h.plane.watchStops()
    h.turns.push(replyTurn())
    await h.runner.startTurn(request())
    await flush()
    h.emit("external-agent://exit", { agentId: "person-agent-id1", code: 1 })
    await flush()
    // An idle process that exits is gone; the next turn starts a new one.
    expect(h.runner.liveAgent("s1")).toBeUndefined()
  })

  it("p6e aborts through the agent's own cancel", async () => {
    const h = harness({ holdLast: true })
    const turn = scripted([
      event({ type: "session_start", sessionId: "native-1" }),
      event({ type: "done", sessionId: "native-1", success: true, stopReason: "cancelled" }),
    ])
    h.turns.push(turn)
    await h.runner.startTurn(request())
    await flush()
    await expect(h.runner.abort("s1")).resolves.toBe(true)
    expect(h.manager.cancel).toHaveBeenCalledWith("person-agent-id1", "native-1")
    turn.release()
    await flush()
    expect(h.settled).toEqual([{ actionId: "a1", outcome: "cancelled", errorCode: undefined }])
    expect(h.envelopes.at(-1)?.event).toEqual({ kind: "lifecycle", phase: "interrupted" })
    await expect(h.runner.abort("s1")).resolves.toBe(false)
  })

  it("p6e queues a message behind the running turn and delivers it after", async () => {
    const h = harness({ holdLast: true })
    const first = replyTurn("one")
    const second = replyTurn("two")
    h.turns.push(first, second)
    await h.runner.startTurn(request())
    await flush()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2", prompt: "next" }))
    await flush()
    // Accepted at once, delivered only once the first turn settles.
    expect(h.manager.executeStreaming).toHaveBeenCalledTimes(1)
    expect(h.envelopes.filter((entry) => entry.eventId.startsWith("person-agent:a2:"))).toEqual([
      {
        eventId: "person-agent:a2:0",
        event: { kind: "queue", phase: "accepted", queueId: "a2", delivery: "after-settle" },
      },
    ])
    first.release()
    await drain()
    expect(h.manager.executeStreaming).toHaveBeenCalledTimes(2)
    second.release()
    await drain()
    expect(h.settled.map((entry) => [entry.actionId, entry.outcome])).toEqual([
      ["a1", "completed"],
      ["a2", "completed"],
    ])
    expect(
      h.envelopes
        .filter((entry) => entry.eventId.startsWith("person-agent:a2:"))
        .map((entry) => entry.event.phase ?? entry.event.kind)
    ).toEqual(["accepted", "delivered", "started", "ended"])
  })

  it("p6e drops a queued message whose turn cannot start", async () => {
    const h = harness({ holdLast: true })
    const first = replyTurn()
    h.turns.push(first)
    await h.runner.startTurn(request())
    await flush()
    await h.runner.startTurn(request({ actionId: "a2", messageId: "m2", model: "claude-opus" }))
    jest
      .mocked(h.deps.prepareLease)
      .mockRejectedValueOnce(Object.assign(new Error("no"), { code: "model_access_unavailable" }))
    first.release()
    await flush()
    await flush()
    expect(h.settled).toContainEqual({
      actionId: "a2",
      outcome: "failed",
      errorCode: "model_access_unavailable",
    })
    expect(h.envelopes.at(-1)?.event).toEqual({
      kind: "queue",
      phase: "dropped",
      queueId: "a2",
      delivery: "after-settle",
      reason: "model_access_unavailable",
    })
  })

  it("p6e refuses a turn before launch when the agent is not bundled or the prompt has a document", async () => {
    const h = harness()
    await expect(h.runner.startTurn(request({ runtimeId: "pi" }))).rejects.toMatchObject({
      code: "org_agent_not_allowed",
    })
    await expect(
      h.runner.startTurn(
        request({
          prompt: [
            { type: "text", text: "read" },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "x" },
            },
          ],
        })
      )
    ).rejects.toMatchObject({ code: "person_agent_attachment_unsupported" })
    expect(h.deps.prepareLease).not.toHaveBeenCalled()
  })

  it("p6e cleans up a process whose connect failed", async () => {
    const h = harness()
    h.manager.addAgent.mockRejectedValueOnce(
      Object.assign(new Error("refused"), { code: "execution_isolation_unavailable" })
    )
    await expect(h.runner.startTurn(request())).rejects.toMatchObject({
      code: "execution_isolation_unavailable",
    })
    expect(h.manager.removeAgent).toHaveBeenCalledWith("person-agent-id1")
    await expect(
      h.plane.host.process.invoke("check_command_exists", { command: "claude-agent-acp" })
    ).resolves.toBe(false)
  })
})

describe("personAgentPrompt", () => {
  it("p6e passes text and images, never documents", () => {
    expect(personAgentPrompt("hi")).toEqual({ text: "hi", attachments: [] })
    expect(
      personAgentPrompt([
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "text", text: "here" },
      ])
    ).toEqual({
      text: "look\n\nhere",
      attachments: [
        { type: "image", source: { type: "base64", data: "AAA", mediaType: "image/png" } },
      ],
    })
  })
})
