import type { ExternalAgentEvent, ExternalAgentSession } from "@/types/agent/external-agent"
import type { ExternalAgentSessionEntry } from "@cognia/agent-contracts/session-operations"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

import {
  executeRemoteSessionOperation,
  DECISION_TIMEOUT_MS,
  parseRemoteRunAttachments,
  remoteRunAttachmentScope,
  REMOTE_RUN_MAX_ATTACHMENTS,
  EXTERNAL_RUN_EVENT_TOPIC,
  MODEL_REPORT_TIMEOUT_MS,
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
import { resolveExternalAgentModels } from "../../session/session-models"

const mockResolveAttachmentRef = jest.fn()
const mockConsumeAttachmentRefs = jest.fn(async (_refs: readonly string[]) => {})
jest.mock("@/lib/db/session-attachment-uploads", () => ({
  resolveAttachmentRef: (...args: unknown[]) => mockResolveAttachmentRef(...args),
  consumeAttachmentRefs: (refs: readonly string[]) => mockConsumeAttachmentRefs(refs),
}))

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
    /** The options each `execute` was called with, in order. */
    executed: Array<Record<string, unknown>>
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
    executed: [] as Array<Record<string, unknown>>,
    async execute(
      _agentId: string,
      _prompt: string,
      options?: { onEvent?: (e: ExternalAgentEvent) => void }
    ) {
      onEvent = options?.onEvent
      manager.executed.push({ ...(options as Record<string, unknown>) })
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

  // The host lane had no model axis at all, so a conversation bound to a host
  // configuration ran on the agent's own default however loudly the composer
  // chip promised otherwise.
  it("runs the turn on the model the client picked", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
      model: "z-ai/glm-5.3-flash",
      reasoningEffort: "high",
      systemPrompt: "Selected skill: verify results",
      allowedTools: ["read"],
    })
    expect(h.manager.executed[0]).toMatchObject({
      model: "z-ai/glm-5.3-flash",
      reasoningEffort: "high",
      systemPrompt: "Selected skill: verify results",
      allowedTools: ["read"],
      context: { custom: { chatSessionId: "chat-1" } },
    })
  })

  // Absent means "inherit whatever the configuration selects". Passing an
  // empty value through would switch the agent's session onto nothing, and the
  // manager's own gate reads a missing key, not a falsy one.
  it("leaves the agent's own selection alone when no model was picked", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    expect(h.manager.executed[0]).not.toHaveProperty("model")
    expect(h.manager.executed[0]).not.toHaveProperty("reasoningEffort")
  })

  // Host-lane Cognia models (ADR-0090, 2026-10-02). Three distinct states
  // reach the manager: absent inherits the Host configuration, `null` is the
  // explicit native choice, a binding runs a gateway task.
  describe("the Cognia model binding", () => {
    const binding = { providerId: "kimi-sub", modelId: "kimi-k2", accountId: "acct-1" }

    it("passes a binding through to the manager", async () => {
      await startRemoteExternalRun({
        runId: "run-1",
        chatSessionId: "chat-1",
        stamp: STAMP,
        prompt: "hi",
        cogniaModel: binding,
      })
      expect(h.manager.executed[0]).toMatchObject({ cogniaModel: binding })
    })

    it("passes an explicit null, and omits an absent binding", async () => {
      await startRemoteExternalRun({
        runId: "run-1",
        chatSessionId: "chat-1",
        stamp: STAMP,
        prompt: "hi",
        cogniaModel: null,
      })
      expect(h.manager.executed[0]).toHaveProperty("cogniaModel", null)
      h.finish()
      await flush()
      await startRemoteExternalRun({
        runId: "run-2",
        chatSessionId: "chat-1",
        stamp: STAMP,
        prompt: "hi",
      })
      expect(h.manager.executed[1]).not.toHaveProperty("cogniaModel")
    })

    // The device that asked rides into the task context, where the gateway
    // task binds itself to it.
    it("carries the calling device in the task context", async () => {
      await startRemoteExternalRun({
        runId: "run-1",
        chatSessionId: "chat-1",
        stamp: STAMP,
        prompt: "hi",
        cogniaModel: binding,
        callerDeviceId: "device-phone",
      })
      expect(h.manager.executed[0]).toMatchObject({
        context: { custom: { chatSessionId: "chat-1", callerDeviceId: "device-phone" } },
      })
    })

    it("leaves the context without a device when the Host itself started the run", async () => {
      await startRemoteExternalRun({
        runId: "run-1",
        chatSessionId: "chat-1",
        stamp: STAMP,
        prompt: "hi",
      })
      expect(
        (h.manager.executed[0].context as { custom: Record<string, unknown> }).custom
      ).not.toHaveProperty("callerDeviceId")
    })
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

describe("the run's images", () => {
  const png = (data: string) =>
    ({ type: "image", source: { type: "base64", data, mediaType: "image/png" } }) as const
  const staged = [
    { ref: "cognia-upload:u1", name: "image-1.png", mediaType: "image/png" },
    { ref: "cognia-upload:u2", name: "image-2.png", mediaType: "image/png" },
  ]
  let restoreImages: (() => void) | undefined
  let loaded: Array<{ runId: string; refs: string[]; deviceId: string | undefined }>
  let consumed: string[][]

  function images(
    load: (() => ReturnType<typeof png>[] | null) | null,
    verdict?: Awaited<ReturnType<NonNullable<ExternalRunManager["resolvePromptAttachments"]>>>
  ) {
    loaded = []
    consumed = []
    restoreImages = __setRemoteRunDepsForTests({
      loadAttachments: async (runId, attachments, deviceId) => {
        loaded.push({ runId, refs: attachments.map((a) => a.ref), deviceId })
        return load ? load() : null
      },
      consumeAttachments: async (refs) => {
        consumed.push([...refs])
      },
    })
    if (verdict) {
      ;(h.manager as ExternalRunManager).resolvePromptAttachments = jest.fn(
        async () => verdict
      ) as never
    }
  }

  afterEach(() => {
    restoreImages?.()
    restoreImages = undefined
  })

  const start = () =>
    startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "what is this?",
      model: "flash",
      callerDeviceId: "phone-1",
      attachments: staged,
    })

  it("hands the agent the images it can see, then spends their refs", async () => {
    images(() => [png("a"), png("b")], { delivered: [png("a"), png("b")], withheld: null })
    await start()
    await flush()
    expect(loaded).toEqual([
      { runId: "run-1", refs: ["cognia-upload:u1", "cognia-upload:u2"], deviceId: "phone-1" },
    ])
    expect(h.manager.resolvePromptAttachments).toHaveBeenCalledWith("eac_1", [png("a"), png("b")], {
      model: "flash",
    })
    expect(h.manager.executed[0]).toMatchObject({ attachments: [png("a"), png("b")] })
    expect(h.frames.some((frame) => frame.attachmentsWithheld)).toBe(false)
    h.finish()
    await flush()
    expect(consumed).toEqual([["cognia-upload:u1", "cognia-upload:u2"]])
  })

  it("reports what the agent's verdict held back, and runs the turn on its text", async () => {
    images(() => [png("a"), png("b")], {
      delivered: [],
      withheld: { reason: "model", count: 2, model: "DeepSeek V4 Pro" },
    })
    await start()
    await flush()
    const report = h.frames.find((frame) => frame.attachmentsWithheld)
    expect(report?.attachmentsWithheld).toEqual({
      reason: "model",
      count: 2,
      model: "DeepSeek V4 Pro",
    })
    expect(report?.seq).toBe(1)
    expect(h.manager.executed[0]).not.toHaveProperty("attachments")
  })

  it("reports an upload that no longer resolves, and still spends the refs on failure", async () => {
    images(null)
    await start()
    await flush()
    expect(h.frames.find((frame) => frame.attachmentsWithheld)?.attachmentsWithheld).toEqual({
      reason: "upload",
      count: 2,
    })
    expect(h.manager.executed[0]).not.toHaveProperty("attachments")
    h.fail("agent crashed")
    await flush()
    expect(consumed).toEqual([["cognia-upload:u1", "cognia-upload:u2"]])
  })

  it("loads nothing for a turn without images", async () => {
    images(() => [])
    await startRemoteExternalRun({
      runId: "run-2",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    await flush()
    h.finish()
    await flush()
    expect(loaded).toEqual([])
    expect(consumed).toEqual([])
  })

  it("resolves refs against this run's scopes and the caller, using the sniffed type", async () => {
    mockResolveAttachmentRef.mockReset()
    mockConsumeAttachmentRefs.mockClear()
    mockResolveAttachmentRef.mockImplementation(async (ref: string) =>
      ref === "cognia-upload:u1"
        ? { mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }
        : { mediaType: "image/jpeg", bytes: new Uint8Array([4, 5, 6]) }
    )
    ;(h.manager as ExternalRunManager).resolvePromptAttachments = jest.fn(
      async (_id: string, images: unknown[]) => ({ delivered: images, withheld: null })
    ) as never
    await start()
    await flush()
    expect(mockResolveAttachmentRef.mock.calls).toEqual([
      ["cognia-upload:u1", { sessionId: "external-run:run-1:0", deviceId: "phone-1" }],
      ["cognia-upload:u2", { sessionId: "external-run:run-1:1", deviceId: "phone-1" }],
    ])
    expect(h.manager.executed[0]).toMatchObject({
      attachments: [
        { type: "image", source: { type: "base64", data: "AQID", mediaType: "image/png" } },
        { type: "image", source: { type: "base64", data: "BAUG", mediaType: "image/jpeg" } },
      ],
    })
    h.finish()
    await flush()
    expect(mockConsumeAttachmentRefs).toHaveBeenCalledWith(["cognia-upload:u1", "cognia-upload:u2"])
  })

  it("treats a ref that resolves to something other than a portable image as not staged", async () => {
    mockResolveAttachmentRef.mockReset()
    mockResolveAttachmentRef.mockResolvedValue({
      mediaType: "application/pdf",
      bytes: new Uint8Array([1]),
    })
    await start()
    await flush()
    expect(h.frames.find((frame) => frame.attachmentsWithheld)?.attachmentsWithheld).toEqual({
      reason: "upload",
      count: 2,
    })
  })

  it("scopes each staged image to its run and position", () => {
    expect(remoteRunAttachmentScope("rer_1", 0)).toBe("external-run:rer_1:0")
    expect(remoteRunAttachmentScope("rer_1", 11)).toBe("external-run:rer_1:11")
  })

  it("parses refs off the wire and refuses anything else riding along", () => {
    expect(parseRemoteRunAttachments(undefined)).toBeUndefined()
    expect(parseRemoteRunAttachments(staged)).toEqual(staged)
    expect(() => parseRemoteRunAttachments("x")).toThrow(/must be an array/)
    expect(() =>
      parseRemoteRunAttachments(
        Array.from({ length: REMOTE_RUN_MAX_ATTACHMENTS + 1 }, () => staged[0])
      )
    ).toThrow(/at most 96/)
    expect(() => parseRemoteRunAttachments([{ ...staged[0], bytes: "AAAA" }])).toThrow(
      /attachments\[0\] must be \{ ref, name, mediaType \}/
    )
    expect(() => parseRemoteRunAttachments([{ ref: "", name: "a", mediaType: "x" }])).toThrow()
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

// A paired client cannot ask the Host's agent anything, so the session's model
// and thinking options ride the run stream, sent once the turn has applied the
// conversation's model.
describe("reporting the session's models", () => {
  const KIMI_OPTIONS = [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "kimi-code/k3",
      options: [
        { value: "kimi-code/kimi-for-coding", name: "K2.8 Preview" },
        { value: "kimi-code/k3", name: "K3" },
      ],
    },
  ]
  const fetchSessionModelSurface = jest.fn()
  const getConfigOptions = jest.fn()

  beforeEach(async () => {
    fetchSessionModelSurface.mockReset().mockResolvedValue({
      status: "ok",
      data: {
        models: resolveExternalAgentModels({ configOptions: KIMI_OPTIONS as never }),
        thinking: { levels: [], currentLevel: null, write: { kind: "none" } },
      },
    })
    getConfigOptions.mockReset().mockReturnValue({ status: "ok", data: KIMI_OPTIONS })
    Object.assign(h.manager, { fetchSessionModelSurface, getConfigOptions })
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
  })

  it("sends the session's options just before the terminal frame", async () => {
    h.emit(evt({ type: "message_delta", sessionId: "kimi-session" }))
    h.finish()
    await flush()
    await flush()
    const types = h.frames.map((f) => f.event.type)
    expect(types).toEqual(["message_delta", "config_options_update", "session_end"])
    const report = h.frames[1].event as unknown as {
      sessionId: string
      configOptions: unknown
    }
    expect(report.sessionId).toBe("kimi-session")
    expect(report.configOptions).toEqual(KIMI_OPTIONS)
    expect(fetchSessionModelSurface).toHaveBeenCalledWith("eac_1", "kimi-session")
  })

  it("reports after a failed turn too, when the session had opened", async () => {
    h.emit(evt({ type: "message_delta", sessionId: "kimi-session" }))
    h.fail("model refused")
    await flush()
    await flush()
    expect(h.frames.map((f) => f.event.type)).toEqual([
      "message_delta",
      "config_options_update",
      "session_end",
    ])
  })

  it("says nothing when no session ever opened", async () => {
    h.finish()
    await flush()
    expect(fetchSessionModelSurface).not.toHaveBeenCalled()
    expect(h.frames.map((f) => f.event.type)).toEqual(["session_end"])
  })

  it("does not hold the terminal frame for a report that never comes", async () => {
    fetchSessionModelSurface.mockReturnValue(new Promise(() => {}))
    jest.useFakeTimers()
    try {
      h.emit(evt({ type: "message_delta", sessionId: "kimi-session" }))
      h.finish()
      await jest.advanceTimersByTimeAsync(MODEL_REPORT_TIMEOUT_MS - 1)
      expect(h.frames.some((f) => f.terminal)).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      expect(h.frames.filter((f) => f.terminal)).toHaveLength(1)
      expect(h.frames.some((f) => f.event.type === "config_options_update")).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it("never lets an unreadable report cost the turn its terminal frame", async () => {
    fetchSessionModelSurface.mockRejectedValue(new Error("adapter gone"))
    h.emit(evt({ type: "message_delta", sessionId: "kimi-session" }))
    h.finish()
    await flush()
    await flush()
    const terminal = h.frames.filter((f) => f.terminal)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ terminal: "completed" })
    expect(h.frames.some((f) => f.event.type === "config_options_update")).toBe(false)
  })
})

// A gateway task's child is released at the end of the turn, and what it would
// report is its `cognia/<model>` route rather than the agent's native models.
describe("not reporting models for a Cognia gateway turn", () => {
  const fetchSessionModelSurface = jest.fn()
  const getConfigOptions = jest.fn()

  beforeEach(() => {
    fetchSessionModelSurface.mockReset().mockResolvedValue({
      status: "ok",
      data: {
        models: resolveExternalAgentModels({
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: "cognia/kimi-k2",
              options: [{ value: "cognia/kimi-k2", name: "kimi-k2" }],
            },
          ] as never,
        }),
        thinking: { levels: [], currentLevel: null, write: { kind: "none" } },
      },
    })
    getConfigOptions.mockReset().mockReturnValue({ status: "unsupported" })
    Object.assign(h.manager, { fetchSessionModelSurface, getConfigOptions })
  })

  it("skips the report when the session is a gateway task session", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
    })
    h.emit(evt({ type: "message_delta", sessionId: "cognia-gateway:task_1:native-7" }))
    h.finish()
    await flush()
    await flush()
    expect(h.frames.map((f) => f.event.type)).toEqual(["message_delta", "session_end"])
    expect(fetchSessionModelSurface).not.toHaveBeenCalled()
  })

  it("skips the report when the turn was asked to run on a Cognia model", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
      cogniaModel: { providerId: "p", modelId: "m" },
    })
    h.emit(evt({ type: "message_delta", sessionId: "native-session" }))
    h.fail("upstream refused")
    await flush()
    await flush()
    expect(h.frames.map((f) => f.event.type)).toEqual(["message_delta", "session_end"])
    expect(fetchSessionModelSurface).not.toHaveBeenCalled()
  })

  it("still reports for an explicitly native turn", async () => {
    await startRemoteExternalRun({
      runId: "run-1",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
      cogniaModel: null,
    })
    h.emit(evt({ type: "message_delta", sessionId: "native-session" }))
    h.finish()
    await flush()
    await flush()
    expect(fetchSessionModelSurface).toHaveBeenCalledWith("eac_1", "native-session")
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

describe("owned remote session operations", () => {
  const target = {
    stamp: STAMP,
    chatSessionId: "chat-1",
    externalSessionId: "native-1",
    callerDeviceId: "phone",
  }
  let listeners: Set<(event: ExternalAgentEvent) => void>
  beforeEach(async () => {
    listeners = new Set()
    h.manager.addEventListener = jest.fn((_id, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    })
    h.manager.getSession = jest.fn((): ExternalAgentSession => ({
      id: "native-1",
      agentId: "eac_1",
      status: "idle",
      createdAt: new Date(),
      lastActivityAt: new Date(),
    }))
    h.manager.renameSession = jest.fn(async () => {})
    h.manager.steerSession = jest.fn(async () => {})
    h.manager.getSessionEntries = jest.fn(async (): Promise<ExternalAgentSessionEntry[]> => [
      {
        id: "turn-2",
        parentId: null,
        type: "turn",
        forkAt: { kind: "turn", id: "turn-2", boundary: "before" },
      },
    ])
    await startRemoteExternalRun({
      runId: "owner",
      chatSessionId: "chat-1",
      stamp: STAMP,
      prompt: "hi",
      callerDeviceId: "phone",
    })
    h.emit(evt({ type: "session_start", sessionId: "native-1" }))
    h.finish()
    await flush()
  })
  it("denies a different device or conversation before mutation", async () => {
    for (const override of [
      { callerDeviceId: "other" },
      { chatSessionId: "other" },
      { externalSessionId: "other" },
    ]) {
      await expect(
        executeRemoteSessionOperation(
          {
            ...target,
            ...override,
            requestId: "bad",
            action: { operation: "rename", name: "Name" },
          },
          false
        )
      ).rejects.toThrow("does not belong")
    }
    expect(h.manager.renameSession).not.toHaveBeenCalled()
  })
  it("requires the mutation channel, rejects arbitrary arguments and preserves typed fork boundaries", async () => {
    await expect(
      executeRemoteSessionOperation(
        { ...target, requestId: "bad", action: { operation: "rename", name: "Name" } },
        true
      )
    ).rejects.toThrow("interactive")
    await expect(
      executeRemoteSessionOperation(
        { ...target, requestId: "bad", action: { operation: "entries", path: "/tmp" } as never },
        true
      )
    ).rejects.toThrow()
    await expect(
      executeRemoteSessionOperation(
        { ...target, requestId: "read", action: { operation: "entries" } },
        true
      )
    ).resolves.toMatchObject({ value: [{ forkAt: { kind: "turn", boundary: "before" } }] })
    await executeRemoteSessionOperation(
      { ...target, requestId: "rename", action: { operation: "rename", name: "Name" } },
      false
    )
    expect(h.manager.renameSession).toHaveBeenCalledWith("eac_1", "native-1", "Name")
    expect(h.released).toContain("rename")
  })
  it("replays early background delivery and routes device-scoped decisions through a live watch", async () => {
    const background = evt({
      type: "message_delta",
      sessionId: "native-1",
      delivery: "out_of_band",
      delta: { type: "text", text: "later" },
    })
    for (const listener of listeners) listener(background)
    await executeRemoteSessionOperation(
      { ...target, requestId: "watch", action: { operation: "watch", watchId: "watch" } },
      true
    )
    expect(
      h.frames.filter((frame) => frame.runId === "watch").map((frame) => frame.event)
    ).toContainEqual(background)
    const permission = evt({
      type: "permission_request",
      sessionId: "native-1",
      delivery: "out_of_band",
      request: { id: "p", requestId: "p", toolInfo: { name: "read" }, options: [] },
    } as never)
    for (const listener of listeners) listener(permission)
    await flush()
    await expect(
      resolveRemoteDecision({ decisionId: "watch:p", decision: "allow", callerDeviceId: "other" })
    ).resolves.toEqual({ resolved: false, reason: "wrong-device" })
    await executeRemoteSessionOperation(
      { ...target, requestId: "close", action: { operation: "unwatch", watchId: "watch" } },
      true
    )
    expect(h.manager.permissions.at(-1)?.response).toMatchObject({ granted: false })
    expect(h.released).toContain("watch")
  })
  it("never infers a session while steering", async () => {
    await executeRemoteSessionOperation(
      { ...target, requestId: "steer", action: { operation: "steer", text: "Continue" } },
      false
    )
    expect(h.manager.steerSession).toHaveBeenCalledWith("eac_1", "native-1", "Continue")
  })
  it("accepts shell promptly, keeps approval on its own watch, and publishes the awaited result", async () => {
    const result = { output: "ok", exitCode: 0, cancelled: false, truncated: false }
    h.manager.executeSessionShell = jest.fn(async (_agent, _session, _command, options) => {
      const response = await options.onPermissionRequest({
        id: "shell-permission",
        requestId: "shell-permission",
        toolInfo: { name: "bash" },
        options: [],
      } as never)
      expect(response.granted).toBe(true)
      return result
    })
    await executeRemoteSessionOperation(
      {
        ...target,
        requestId: "shell-watch",
        action: { operation: "watch", watchId: "shell-watch", purpose: "shell" },
      },
      true
    )
    await expect(
      executeRemoteSessionOperation(
        {
          ...target,
          requestId: "shell-run",
          action: { operation: "shell", watchId: "shell-watch", command: "pwd" },
        },
        false
      )
    ).resolves.toEqual({ value: { started: true } })
    expect(h.released).not.toContain("shell-run")
    await resolveRemoteDecision({
      decisionId: "shell-watch:shell-permission",
      decision: "allow",
      callerDeviceId: "phone",
    })
    await flush()
    expect(
      h.frames.find((frame) => frame.operationResult?.requestId === "shell-run")?.operationResult
        ?.value
    ).toEqual(result)
    expect(h.released).toContain("shell-run")
  })
  it("presentation watches do not duplicate transcript permissions", async () => {
    await executeRemoteSessionOperation(
      {
        ...target,
        requestId: "display",
        action: { operation: "watch", watchId: "display", purpose: "presentation" },
      },
      true
    )
    for (const listener of listeners)
      listener(
        evt({
          type: "permission_request",
          sessionId: "native-1",
          delivery: "out_of_band",
          request: { id: "p", toolInfo: { name: "read" }, options: [] },
        } as never)
      )
    await flush()
    expect(h.frames.filter((frame) => frame.runId === "display")).toHaveLength(0)
  })
})
