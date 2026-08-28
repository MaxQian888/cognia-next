import type { ExternalAgentEvent } from "@/types/agent/external-agent"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import {
  DECISION_TIMEOUT_MS,
  EXTERNAL_RUN_EVENT_TOPIC,
  activeRemoteExternalRuns,
  cancelRemoteExternalRun,
  remoteDecisionId,
  resolveRemoteDecision,
  startRemoteExternalRun,
  __resetRemoteRunStateForTests,
  __setRemoteRunDepsForTests,
  type ExternalRunManager,
  type RemoteRunFrame,
} from "./remote-run-service"

function record(over: Partial<ExternalAgentConfigRecord> = {}): ExternalAgentConfigRecord {
  return {
    configId: "eac_1",
    revision: "eacr_1",
    lifecycleGeneration: 1,
    seq: 1,
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 1,
    updatedAt: 1,
    config: { id: "ignored", name: "Pi", protocol: "pi-rpc", transport: "stdio", enabled: true },
    ...over,
  } as ExternalAgentConfigRecord
}

const STAMP = { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 1 }

interface Harness {
  frames: RemoteRunFrame[]
  released: string[]
  manager: ExternalRunManager & {
    agents: Set<string>
    added: Array<{ id: string; name: string }>
    removed: string[]
    permissions: Array<{ agentId: string; sessionId: string; response: unknown }>
    elicitations: Array<{ agentId: string; response: unknown }>
  }
  /** Drives the turn the manager is "running". */
  emit: (event: ExternalAgentEvent) => void
  finish: () => void
  fail: (message: string) => void
}

let restore: (() => void) | undefined
let h: Harness

function evt(over: Partial<ExternalAgentEvent> & { type: string }): ExternalAgentEvent {
  return { timestamp: new Date(0), ...over } as ExternalAgentEvent
}

function setup(
  over: {
    admitRefusal?: unknown
    mountThrows?: boolean
  } = {}
) {
  const frames: RemoteRunFrame[] = []
  const released: string[] = []
  let onEvent: ((event: ExternalAgentEvent) => void) | undefined
  let resolveTurn: (() => void) | undefined
  let rejectTurn: ((error: Error) => void) | undefined

  const manager = {
    agents: new Set<string>(),
    added: [] as Array<{ id: string; name: string }>,
    removed: [] as string[],
    permissions: [] as Array<{ agentId: string; sessionId: string; response: unknown }>,
    elicitations: [] as Array<{ agentId: string; response: unknown }>,
    getAgent(id: string) {
      return manager.agents.has(id) ? {} : undefined
    },
    async addAgent(config: { id: string; name: string }) {
      if (over.mountThrows) throw new Error("no adapter registered for pi-rpc")
      manager.agents.add(config.id)
      manager.added.push({ id: config.id, name: config.name })
      return {}
    },
    async removeAgent(id: string) {
      manager.agents.delete(id)
      manager.removed.push(id)
    },
    async execute(
      _agentId: string,
      _prompt: string,
      options?: { onEvent?: (e: ExternalAgentEvent) => void }
    ) {
      onEvent = options?.onEvent
      return new Promise<void>((res, rej) => {
        resolveTurn = res
        rejectTurn = rej
      })
    },
    async respondToPermission(agentId: string, sessionId: string, response: unknown) {
      manager.permissions.push({ agentId, sessionId, response })
    },
    async respondToElicitation(agentId: string, response: unknown) {
      manager.elicitations.push({ agentId, response })
    },
  } as unknown as Harness["manager"]

  restore?.()
  __resetRemoteRunStateForTests()
  restore = __setRemoteRunDepsForTests({
    admit: async (runId, stamp) =>
      over.admitRefusal
        ? ({ ok: false, refusal: over.admitRefusal } as never)
        : ({
            ok: true,
            run: { runId, record: record({ revision: stamp.revision }), config: record().config },
          } as never),
    release: async (runId) => {
      released.push(runId)
    },
    publish: async (topic, payload) => {
      if (topic === EXTERNAL_RUN_EVENT_TOPIC) frames.push(payload as RemoteRunFrame)
    },
    getManager: async () => manager,
    now: () => 1_700_000_000_000,
  })

  h = {
    frames,
    released,
    manager,
    emit: (event) => onEvent?.(event),
    finish: () => resolveTurn?.(),
    fail: (message) => rejectTurn?.(new Error(message)),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  jest.useRealTimers()
  setup()
})

afterEach(() => {
  restore?.()
  restore = undefined
  __resetRemoteRunStateForTests()
})

describe("starting a run", () => {
  it("admits, mounts and accepts", async () => {
    const result = await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    expect(result).toEqual({ started: true, runId: "run-1", agentId: "eac_1" })
    expect(h.manager.added).toEqual([{ id: "eac_1", name: "Pi" }])
  })

  it("refuses without mounting when admission refuses", async () => {
    setup({ admitRefusal: { kind: "config", reason: "stale-revision" } })
    const result = await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    expect(result.started).toBe(false)
    expect(h.manager.added).toEqual([])
  })

  // A lease taken by admission has no settle path when the mount fails, so it
  // has to be dropped right here or the revision is pinned forever.
  it("releases the lease when mounting fails", async () => {
    setup({ mountThrows: true })
    const result = await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    expect(result.started).toBe(false)
    if (result.started) return
    expect(result.refusal).toMatchObject({ kind: "readiness", status: "blocked" })
    expect(h.released).toEqual(["run-1"])
  })

  it("reuses a mounted agent for a second run on the same revision", async () => {
    await startRemoteExternalRun({ runId: "a", chatSessionId: "c", stamp: STAMP, prompt: "1" })
    await startRemoteExternalRun({ runId: "b", chatSessionId: "c", stamp: STAMP, prompt: "2" })
    expect(h.manager.added).toHaveLength(1)
    expect(h.manager.removed).toEqual([])
  })

  // Leaving the old agent mounted would run the previous command line under
  // the new revision's name — exactly what the revision check exists to stop.
  it("remounts when the revision moved", async () => {
    await startRemoteExternalRun({ runId: "a", chatSessionId: "c", stamp: STAMP, prompt: "1" })
    await startRemoteExternalRun({
      runId: "b",
      chatSessionId: "c",
      stamp: { ...STAMP, revision: "eacr_2" },
      prompt: "2",
    })
    expect(h.manager.removed).toEqual(["eac_1"])
    expect(h.manager.added).toHaveLength(2)
  })
})

describe("streaming", () => {
  beforeEach(async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
  })

  it("publishes each event with a per-run sequence", async () => {
    h.emit(evt({ type: "message_delta" }))
    h.emit(evt({ type: "message_delta" }))
    await flush()
    expect(h.frames.map((f) => f.seq)).toEqual([1, 2])
    expect(h.frames[0]).toMatchObject({ runId: "run-1", chatSessionId: "chat-1" })
  })

  it("addresses frames to the chat session, not the agent's", async () => {
    h.emit(evt({ type: "session_start", sessionId: "agent-session-9" }))
    await flush()
    expect(h.frames[0].chatSessionId).toBe("chat-1")
  })

  it("ends with exactly one terminal frame and releases the lease", async () => {
    h.emit(evt({ type: "message_delta" }))
    h.finish()
    await flush()
    const terminal = h.frames.filter((f) => f.terminal)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ terminal: "completed" })
    expect(terminal[0].event.type).toBe("session_end")
    expect(h.released).toEqual(["run-1"])
  })

  it("reports a thrown turn as failed, once", async () => {
    h.fail("spawn failed")
    await flush()
    const terminal = h.frames.filter((f) => f.terminal)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ terminal: "failed", error: "spawn failed" })
  })

  it("drops events emitted after the run settled", async () => {
    h.finish()
    await flush()
    const after = h.frames.length
    h.emit(evt({ type: "message_delta" }))
    await flush()
    expect(h.frames).toHaveLength(after)
  })

  it("stops listing the run once it settles", async () => {
    expect(activeRemoteExternalRuns()).toHaveLength(1)
    h.finish()
    await flush()
    expect(activeRemoteExternalRuns()).toEqual([])
  })
})

describe("cancelling", () => {
  it("settles a live run as cancelled", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    await expect(cancelRemoteExternalRun("run-1")).resolves.toBe(true)
    expect(h.frames.filter((f) => f.terminal)).toMatchObject([{ terminal: "cancelled" }])
  })

  // "I cancelled it" and "it had already finished" are different answers: the
  // first means a terminal frame is coming because of this call.
  it("answers false for a run that already finished", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    h.finish()
    await flush()
    await expect(cancelRemoteExternalRun("run-1")).resolves.toBe(false)
  })

  it("refuses a device that did not start the run", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
      callerDeviceId: "device-a",
    })
    await expect(cancelRemoteExternalRun("run-1", "device-b")).resolves.toBe(false)
    expect(activeRemoteExternalRuns()).toHaveLength(1)
  })
})

describe("decisions", () => {
  const permission = evt({
    type: "permission_request",
    sessionId: "agent-1",
    request: {
      requestId: "req-1",
      options: [
        { optionId: "yes", kind: "allow_once" },
        { optionId: "no", kind: "reject_once" },
      ],
    },
  } as never)

  async function startWithDevice(deviceId?: string) {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
      callerDeviceId: deviceId,
    })
    h.emit(permission)
    await flush()
  }

  it("publishes the question and accepts an answer", async () => {
    await startWithDevice()
    expect(h.frames[0].event.type).toBe("permission_request")
    await expect(
      resolveRemoteDecision({
        decisionId: remoteDecisionId("run-1", "req-1"),
        decision: "allow",
      })
    ).resolves.toEqual({ resolved: true })
    expect(h.manager.permissions[0]).toMatchObject({
      agentId: "eac_1",
      sessionId: "agent-1",
      response: { requestId: "req-1", granted: true, optionId: "yes" },
    })
  })

  it("sends the agent's own reject option on a deny", async () => {
    await startWithDevice()
    await resolveRemoteDecision({
      decisionId: remoteDecisionId("run-1", "req-1"),
      decision: "deny",
    })
    expect(h.manager.permissions[0].response).toMatchObject({ granted: false, optionId: "no" })
  })

  it("expresses allow_always in the agent's protocol", async () => {
    await startWithDevice()
    await resolveRemoteDecision({
      decisionId: remoteDecisionId("run-1", "req-1"),
      decision: "allow_always",
    })
    expect(h.manager.permissions[0].response).toMatchObject({
      granted: true,
      rememberChoice: true,
      scope: "session",
    })
  })

  it("is one-time — a replay is refused", async () => {
    await startWithDevice()
    const id = remoteDecisionId("run-1", "req-1")
    await resolveRemoteDecision({ decisionId: id, decision: "allow" })
    await expect(resolveRemoteDecision({ decisionId: id, decision: "allow" })).resolves.toEqual({
      resolved: false,
      reason: "unknown",
    })
    expect(h.manager.permissions).toHaveLength(1)
  })

  it("refuses an unknown id", async () => {
    await expect(resolveRemoteDecision({ decisionId: "nope" })).resolves.toEqual({
      resolved: false,
      reason: "unknown",
    })
  })

  // Consuming it would let any paired device cancel someone else's turn.
  it("refuses another device and leaves the question answerable", async () => {
    await startWithDevice("device-a")
    const id = remoteDecisionId("run-1", "req-1")
    await expect(
      resolveRemoteDecision({ decisionId: id, callerDeviceId: "device-b" })
    ).resolves.toEqual({ resolved: false, reason: "wrong-device" })
    await expect(
      resolveRemoteDecision({ decisionId: id, callerDeviceId: "device-a", decision: "allow" })
    ).resolves.toEqual({ resolved: true })
  })

  it("scopes ids per run so two runs cannot collide", async () => {
    expect(remoteDecisionId("run-1", "req-1")).not.toBe(remoteDecisionId("run-2", "req-1"))
  })

  it("routes an elicitation answer to the agent, stamping the request id", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    h.emit(
      evt({ type: "elicitation_request", sessionId: "agent-1", request: { id: "el-1" } } as never)
    )
    await flush()
    await resolveRemoteDecision({
      decisionId: remoteDecisionId("run-1", "el-1"),
      elicitation: { requestId: "ignored", action: "accept", content: { ok: true } } as never,
    })
    expect(h.manager.elicitations[0].response).toMatchObject({
      requestId: "el-1",
      action: "accept",
    })
  })

  it("forgets a run's questions when it settles", async () => {
    await startWithDevice()
    h.finish()
    await flush()
    await expect(
      resolveRemoteDecision({ decisionId: remoteDecisionId("run-1", "req-1") })
    ).resolves.toEqual({ resolved: false, reason: "unknown" })
  })

  it("ignores a duplicate question id from an adapter that re-emits", async () => {
    await startWithDevice()
    h.emit(permission)
    await flush()
    await resolveRemoteDecision({
      decisionId: remoteDecisionId("run-1", "req-1"),
      decision: "allow",
    })
    expect(h.manager.permissions).toHaveLength(1)
  })

  it("ignores a question with no id to answer", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    h.emit(evt({ type: "permission_request", request: {} } as never))
    await flush()
    // Still published — the user should see it — but not answerable, so it must
    // not occupy a registry slot a real question could have used.
    expect(h.frames[0].event.type).toBe("permission_request")
    await expect(
      resolveRemoteDecision({ decisionId: remoteDecisionId("run-1", "") })
    ).resolves.toEqual({ resolved: false, reason: "unknown" })
  })
})

describe("the decision timeout", () => {
  it("denies rather than allows when nobody answers", async () => {
    jest.useFakeTimers()
    setup()
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    h.emit(
      evt({
        type: "permission_request",
        sessionId: "agent-1",
        request: { requestId: "req-1", options: [{ optionId: "no", kind: "reject_once" }] },
      } as never)
    )
    await jest.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS + 1)
    expect(h.manager.permissions[0].response).toMatchObject({ granted: false, optionId: "no" })
    jest.useRealTimers()
  })

  it("cancels an unanswered elicitation instead of declining it", async () => {
    jest.useFakeTimers()
    setup()
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    h.emit(evt({ type: "elicitation_request", sessionId: "a", request: { id: "el-1" } } as never))
    await jest.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS + 1)
    expect(h.manager.elicitations[0].response).toMatchObject({ action: "cancel" })
    jest.useRealTimers()
  })

  it("does not fire for a question that was answered", async () => {
    jest.useFakeTimers()
    setup()
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    h.emit(
      evt({ type: "permission_request", sessionId: "a", request: { requestId: "req-1" } } as never)
    )
    await resolveRemoteDecision({
      decisionId: remoteDecisionId("run-1", "req-1"),
      decision: "allow",
    })
    await jest.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS + 1)
    expect(h.manager.permissions).toHaveLength(1)
    jest.useRealTimers()
  })
})
