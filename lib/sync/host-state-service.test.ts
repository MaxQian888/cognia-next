/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  createEmptyHostStateSession,
  hostStateDigest,
  sessionIndexChannel,
  sessionStateChannel,
  type HostStateAction,
  type HostStateAppliedAction,
  type HostStateSnapshot,
} from "@cognia/agent-config-types/host-state"
import { activateAccountDatabase, __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createAgentRpcHostStateDispatcher,
  createHostStateService,
  installHostStateSync,
} from "./host-state-service"
import type { Transport } from "@/lib/tauri/transport-types"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
import {
  __resetDevicePresenceForTests,
  attachSessionLease,
  syncEventStreams,
} from "@/lib/companion/device-presence-registry"
import {
  HOST_STATE_LEASE_TTL_MS,
  commitHostStateAction,
  listPendingHostStateActions,
  markHostStateBroadcast,
} from "./host-state-store"

const acceptHostStateChatTurnMock = jest.fn().mockResolvedValue(null)
const bindHostStateChatTurnContextMock = jest.fn().mockResolvedValue(false)
const claimHostStateChatTurnForDispatchMock = jest.fn().mockResolvedValue("legacy")
const markHostStateChatTurnStartedMock = jest.fn().mockResolvedValue(false)
jest.mock("@/lib/work-submission/host-adapter", () => ({
  acceptHostStateChatTurn: (...args: unknown[]) => acceptHostStateChatTurnMock(...args),
  bindHostStateChatTurnContext: (...args: unknown[]) => bindHostStateChatTurnContextMock(...args),
  claimHostStateChatTurnForDispatch: (...args: unknown[]) =>
    claimHostStateChatTurnForDispatchMock(...args),
  markHostStateChatTurnStarted: (...args: unknown[]) => markHostStateChatTurnStartedMock(...args),
}))

const stopLeaseHeartbeatMock = jest.fn()
const startLeaseHeartbeatMock = jest.fn(
  (_submissionId: string, _leaseOwner: string) => stopLeaseHeartbeatMock
)
jest.mock("@/lib/work-submission/lease-heartbeat", () => ({
  startWorkSubmissionLeaseHeartbeat: (submissionId: string, leaseOwner: string) =>
    startLeaseHeartbeatMock(submissionId, leaseOwner),
}))

const buildSendOptionsMock = jest.fn().mockResolvedValue({ model: "sonnet" })
jest.mock("@/hooks/chat/claude-chat-send-options", () => ({
  buildSendOptions: (...args: unknown[]) => buildSendOptionsMock(...args),
}))

const sendPromptMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...args: unknown[]) => sendPromptMock(...args),
}))

/** Let the `applying` chain, its recovery, and the Dexie writes settle. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const scope = { accountId: "acct-service", runtimeTargetId: "target-service" }
const hostId = "host-service"
/** A device holding every grant — the per-action gate is exercised separately. */
const owner = {
  deviceId: "device-owner",
  grants: ["host.observe", "workspace.write", "process.spawn", "host.admin"],
}
const channel = sessionStateChannel(scope.runtimeTargetId, "session-1")
const writableStatus = {
  hostId,
  hostGeneration: 4,
  hostSeq: 8,
  leaseExpiresAt: 10_000,
  pendingDispatch: 0,
  pendingBroadcast: 0,
  recovery: "ready" as const,
}

/** One canonical runtime event on the session channel under test. */
function runtimeEnvelope(event: AgentEventEnvelope["event"], eventId: string): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId,
    sequence: 1,
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    hostRef: hostId,
    runtime: "anthropic-agent-sdk",
    timestamp: "2026-08-14T00:00:00.000Z",
    event,
  }
}

function action(
  intent: HostStateAction["action"],
  overrides: Partial<HostStateAction> = {}
): HostStateAction {
  return {
    channel,
    accountId: scope.accountId,
    runtimeTargetId: scope.runtimeTargetId,
    hostId,
    hostGeneration: 1,
    sessionId: "session-1",
    clientId: "web-a",
    clientSeq: 1,
    actionId: "action-1",
    baseRevision: 0,
    createdAt: 100,
    action: intent,
    ...overrides,
  }
}

describe("HostStateService", () => {
  beforeEach(async () => {
    activateAccountDatabase(scope.accountId, scope.runtimeTargetId)
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase(scope.accountId, scope.runtimeTargetId)
    await getDb().sessions.put({
      id: "session-1",
      projectId: "project-1",
      title: "Before",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
  }, 30_000)

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("atomically projects a draft and publishes the ordered event", async () => {
    const publish = jest.fn(async () => undefined)
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      publish,
    })
    await service.start({
      now: 0,
      heartbeat: false,
    })

    const response = await service.submit(
      {
        ...scope,
        actions: [action({ kind: "draft.replace", text: "shared", attachments: [] })],
      },
      owner
    )

    expect(response.results).toEqual([
      expect.objectContaining({ actionId: "action-1", outcome: "applied", hostSeq: 1 }),
    ])
    await expect(getDb().chatDrafts.get("session-1")).resolves.toMatchObject({
      text: "shared",
      revision: 1,
      originClientId: "web-a",
    })
    expect(publish).toHaveBeenCalledWith(
      "host-state://action",
      expect.objectContaining({ hostSeq: 1, outcome: "applied" })
    )
    await expect(
      service.snapshot({
        ...scope,
        channel: sessionIndexChannel(scope.runtimeTargetId),
      })
    ).resolves.toMatchObject({
      state: {
        sessions: [
          expect.objectContaining({ sessionId: "session-1", title: "Before", revision: 1 }),
        ],
      },
    })
  })

  it("recovers runtime dispatch without executing the semantic action twice", async () => {
    const dispatchRuntime = jest
      .fn()
      .mockRejectedValueOnce(new Error("runtime offline"))
      .mockResolvedValueOnce({ correlationId: "turn-1" })
    const publish = jest.fn(async () => undefined)
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      dispatchRuntime,
      publish,
    })
    await service.start({
      now: 0,
      heartbeat: false,
    })
    const queued = action({
      kind: "message.enqueue",
      messageId: "message-1",
      text: "hello",
      attachments: [],
    })

    await expect(service.submit({ ...scope, actions: [queued] }, owner)).rejects.toThrow(
      "runtime offline"
    )
    await expect(service.recover()).resolves.toEqual({ dispatched: 1, broadcast: 1 })
    await expect(service.submit({ ...scope, actions: [queued] }, owner)).resolves.toMatchObject({
      results: [{ outcome: "duplicate", hostSeq: 1 }],
    })

    // The semantic action ran once and was replayed once; the ledger holds it
    // plus the session-index projection it triggered.
    expect(dispatchRuntime).toHaveBeenCalledTimes(2)

    // Dispatch outcome is itself confirmed state, so the client can tell a
    // send that is on its way from one that never left. The failure is
    // published before the throw, and the recovery supersedes it.
    const snapshot = await service.snapshot({ ...scope, channel })
    const operations = (snapshot.state as { operations: { status: string }[] }).operations
    expect(operations).toEqual([
      expect.objectContaining({ actionId: "action-1", status: "dispatching" }),
    ])
    // `publish` is typed as a zero-arg mock here, so the recorded call tuple has
    // no declared element to index — read it through the argument list instead.
    const published = (publish.mock.calls as unknown as unknown[][])
      .map((call) => (call[1] as HostStateAppliedAction | undefined)?.mutation)
      .filter((mutation) => mutation?.kind === "operation.changed")
      .map((mutation) => (mutation as { status?: string } | undefined)?.status)
    expect(published).toEqual(["failed", "dispatching"])
  })

  /**
   * `recover()` existed from the start and was called only by tests. Production
   * ran `start()` and went straight to serving, so a send left half-dispatched
   * by a killed Host sat in the ledger forever and the client that submitted it
   * waited on a receipt that was never coming.
   */
  it("redrives the ledger on start instead of leaving a killed Host's work stranded", async () => {
    const publish = jest.fn(async () => undefined)
    const dispatchRuntime = jest.fn().mockRejectedValueOnce(new Error("runtime offline"))
    const first = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      dispatchRuntime,
      publish,
    })
    await first.start({ now: 0, heartbeat: false })
    await expect(
      first.submit(
        {
          ...scope,
          actions: [
            action({ kind: "message.enqueue", messageId: "m1", text: "hi", attachments: [] }),
          ],
        },
        owner
      )
    ).rejects.toThrow("runtime offline")
    await first.stop()

    // A new owner takes over with work still pending.
    dispatchRuntime.mockResolvedValue({ correlationId: "turn-1" })
    const second = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-b",
      now: () => 200,
      dispatchRuntime,
      publish,
    })
    const status = await second.start({ now: HOST_STATE_LEASE_TTL_MS + 1, heartbeat: false })

    expect(status.recovery).toBe("ready")
    expect(dispatchRuntime).toHaveBeenCalledTimes(2)
    await expect(listPendingHostStateActions()).resolves.toEqual([])
    await second.stop()
  })

  /**
   * Winning the lease proves the previous owner is gone, and its runtime went
   * with it. A channel still reading `running` describes work that stopped
   * without ever saying so — every replica reading it sees a live turn.
   */
  it("settles turns the previous owner left in flight", async () => {
    const publish = jest.fn(async () => undefined)
    const first = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      publish,
    })
    await first.start({ now: 0, heartbeat: false })
    await first.projectRuntimeEnvelope(
      runtimeEnvelope({ kind: "lifecycle", phase: "started" }, "evt-start")
    )
    await first.projectRuntimeEnvelope(
      runtimeEnvelope(
        { kind: "permission-request", requestId: "req-1", toolName: "Bash" },
        "evt-permission"
      )
    )
    await expect(first.snapshot({ ...scope, channel })).resolves.toMatchObject({
      state: { turn: "awaiting-decision" },
    })
    await first.stop()

    const second = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-b",
      now: () => 200,
      publish,
    })
    const status = await second.start({ now: HOST_STATE_LEASE_TTL_MS + 1, heartbeat: false })
    expect(status.recovery).toBe("ready")

    const snapshot = await second.snapshot({ ...scope, channel })
    const state = snapshot.state as Extract<typeof snapshot.state, { kind: "session" }>
    expect(state.runtime).toBe("unavailable")
    // Retryable, not fatal: the conversation survived the Host that died.
    expect(state.turn).toBe("retryable-error")
    expect(state.decisions.map((item) => item.status)).toEqual(["interrupted"])
    expect(state.activeTurn).toBeNull()
    await second.stop()
  })

  it("reports degraded rather than presenting stale state as fresh", async () => {
    const publish = jest.fn(async () => undefined)
    const dispatchRuntime = jest.fn().mockRejectedValue(new Error("runtime offline"))
    const first = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      dispatchRuntime,
      publish,
    })
    await first.start({ now: 0, heartbeat: false })
    await expect(
      first.submit(
        {
          ...scope,
          actions: [
            action({ kind: "message.enqueue", messageId: "m1", text: "hi", attachments: [] }),
          ],
        },
        owner
      )
    ).rejects.toThrow("runtime offline")
    await first.stop()

    const second = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-b",
      now: () => 200,
      dispatchRuntime,
      publish,
    })
    // Recovery fails again — the Host still serves, and says so.
    const status = await second.start({ now: HOST_STATE_LEASE_TTL_MS + 1, heartbeat: false })
    expect(status.recovery).toBe("degraded")
    await second.stop()
  })

  it("recovers a session-index projection after the source event was already broadcast", async () => {
    const publish = jest.fn(async () => undefined)
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      publish,
    })
    await service.start({
      now: 0,
      heartbeat: false,
    })
    const source = action({ kind: "draft.replace", text: "recover me", attachments: [] })
    await commitHostStateAction({
      action: source,
      mutation: {
        kind: "draft.replaced",
        text: "recover me",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
      now: 100,
    })
    await markHostStateBroadcast(1, source.actionId, 100)

    await expect(service.status()).resolves.toMatchObject({ pendingBroadcast: 1 })
    await expect(service.recover()).resolves.toEqual({ dispatched: 0, broadcast: 0 })

    await expect(
      service.snapshot({
        ...scope,
        channel: sessionIndexChannel(scope.runtimeTargetId),
      })
    ).resolves.toMatchObject({
      state: { sessions: [expect.objectContaining({ sessionId: "session-1", revision: 1 })] },
    })
    await expect(getDb().hostStateActions.get([1, source.actionId])).resolves.toMatchObject({
      broadcastState: "completed",
      summaryState: "completed",
    })
    expect(publish).toHaveBeenCalledWith(
      "host-state://action",
      expect.objectContaining({ channel: sessionIndexChannel(scope.runtimeTargetId), hostSeq: 2 })
    )
  })

  it("rejects account and target confusion before touching the ledger", async () => {
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
    })
    await service.start({
      now: 0,
      heartbeat: false,
    })

    await expect(
      service.submit(
        {
          accountId: "acct-other",
          runtimeTargetId: scope.runtimeTargetId,
          actions: [action({ kind: "turn.abort" })],
        },
        owner
      )
    ).rejects.toThrow("host_state_scope_mismatch")
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
  })

  /**
   * Holding the Remote Control grant is not the same as currently driving the
   * session. A live-only intent names something the runtime is holding open
   * right now, so it may only come from the device the Host is routing that
   * state to — otherwise a second phone answers a prompt the first is looking
   * at, or aborts a turn that started after it last heard anything.
   */
  describe("attachment refs on a queued message", () => {
    const now = 100
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

    async function stageAttachment(sessionId: string, deviceId: string): Promise<string> {
      const store = await import("@/lib/db/session-attachment-uploads")
      const { sha256Bytes } = await import("@/lib/ocr/hash")
      const init = await store.beginAttachmentUpload({
        sessionId,
        deviceId,
        name: "shot.png",
        mediaType: "image/png",
        size: PNG.byteLength,
        hash: await sha256Bytes(PNG),
      })
      await store.appendAttachmentChunk({
        uploadId: init.uploadId,
        deviceId,
        offset: 0,
        bytes: PNG,
      })
      return (await store.commitAttachmentUpload({ uploadId: init.uploadId, deviceId })).ref
    }

    async function service() {
      const instance = createHostStateService({
        ...scope,
        hostId,
        ownerId: "brain-a",
        now: () => now,
        publish: jest.fn(async () => undefined),
        dispatchRuntime: jest.fn(async () => undefined),
      })
      await instance.start({ now: 0, heartbeat: false })
      return instance
    }

    function messageWithRef(ref: string) {
      return action({
        kind: "message.enqueue",
        messageId: "m-1",
        text: "look at this",
        attachments: [{ name: "shot.png", mediaType: "image/png", size: PNG.byteLength, ref }],
      })
    }

    it("accepts a ref this caller uploaded into this session", async () => {
      const instance = await service()
      const ref = await stageAttachment("session-1", owner.deviceId)
      const response = await instance.submit({ ...scope, actions: [messageWithRef(ref)] }, owner)
      expect(response.results[0]).toMatchObject({ outcome: "applied" })
    })

    /**
     * Refused at submit, while the composer is still holding the file and can
     * re-stage it. Discovering this from a failed dispatch minutes later means
     * a sent message that silently never carried its screenshot.
     */
    it("refuses a ref that never committed, before the ledger", async () => {
      const instance = await service()
      const response = await instance.submit(
        { ...scope, actions: [messageWithRef("cognia-upload:upl_nope")] },
        owner
      )
      expect(response.results[0]).toMatchObject({
        outcome: "rejected",
        rejection: { code: "host_state_attachment_unavailable" },
      })
      await expect(getDb().hostStateActions.count()).resolves.toBe(0)
    })

    it("refuses a ref another device uploaded", async () => {
      const instance = await service()
      const ref = await stageAttachment("session-1", "device-someone-else")
      const response = await instance.submit({ ...scope, actions: [messageWithRef(ref)] }, owner)
      expect(response.results[0]).toMatchObject({
        rejection: { code: "host_state_attachment_unavailable" },
      })
    })

    it("refuses a ref staged against a different session", async () => {
      const instance = await service()
      const ref = await stageAttachment("session-other", owner.deviceId)
      const response = await instance.submit({ ...scope, actions: [messageWithRef(ref)] }, owner)
      expect(response.results[0]).toMatchObject({
        rejection: { code: "host_state_attachment_unavailable" },
      })
    })

    it("leaves a message with no attachments alone", async () => {
      const instance = await service()
      const response = await instance.submit(
        {
          ...scope,
          actions: [
            action({ kind: "message.enqueue", messageId: "m-1", text: "hi", attachments: [] }),
          ],
        },
        owner
      )
      expect(response.results[0]).toMatchObject({ outcome: "applied" })
    })
  })

  describe("live-only intents require the effective controller", () => {
    // Same instant the other suites use: the HostState lease is 30s, so a far
    // future clock would expire it before the first submit.
    const now = 100

    function readyStream(leaseId: string) {
      return { leaseId, transport: "ws" as const, state: "ready" as const, openedAt: now }
    }

    function attachController(deviceId: string, leaseId = `esl_${deviceId}`, at = now) {
      syncEventStreams({ deviceId, streams: [readyStream(leaseId)], at })
      attachSessionLease({
        sessionId: "session-1",
        deviceId,
        mode: "control",
        eventStreamLeaseId: leaseId,
        at,
      })
      return leaseId
    }

    async function serviceWithLease() {
      const service = createHostStateService({
        ...scope,
        hostId,
        ownerId: "brain-a",
        now: () => now,
        publish: jest.fn(async () => undefined),
        dispatchRuntime: jest.fn(async () => undefined),
      })
      await service.start({ now: 0, heartbeat: false })
      return service
    }

    beforeEach(() => {
      __resetDevicePresenceForTests()
    })

    afterEach(() => {
      __resetDevicePresenceForTests()
    })

    it("accepts an abort from the attached controller", async () => {
      const service = await serviceWithLease()
      attachController(owner.deviceId)
      const response = await service.submit(
        { ...scope, actions: [action({ kind: "turn.abort" })] },
        owner
      )
      expect(response.results[0]).toMatchObject({ outcome: "applied" })
    })

    /**
     * Requiring an attachment would refuse every client that drives a companion
     * host through the ordinary chat surface — `use-claude-chat-controller`
     * submits `turn.abort` and `approval.respond` and never calls
     * `session_attach`. Making them all attach belongs with the shared
     * composer, not with this gate.
     */
    it("accepts one from a granted device when nobody holds the session", async () => {
      const service = await serviceWithLease()
      const response = await service.submit(
        { ...scope, actions: [action({ kind: "turn.abort" })] },
        owner
      )
      expect(response.results[0]).toMatchObject({ outcome: "applied" })
    })

    it("refuses one from a second device while the first is driving", async () => {
      const service = await serviceWithLease()
      attachController("device-first", "esl-first", now)
      attachController(owner.deviceId, "esl-second", now + 10)
      const response = await service.submit(
        { ...scope, actions: [action({ kind: "turn.steer", text: "no" })] },
        owner
      )
      expect(response.results[0]).toMatchObject({
        outcome: "rejected",
        rejection: { code: "host_state_not_controller" },
      })
      // Refused before the ledger, exactly like an unauthorized action: the
      // device may not append to durable state or fan an event to every replica.
      await expect(getDb().hostStateActions.count()).resolves.toBe(0)
    })

    /**
     * The controller's stream dropping is a reconnect, not a handover. Nobody
     * is effective during the gap, so a second client is free to act — and the
     * first gets its authority back without re-attaching.
     */
    it("stops reserving the session once the controller's stream drops", async () => {
      const service = await serviceWithLease()
      attachController("device-first", "esl-first", now)
      syncEventStreams({ deviceId: "device-first", streams: [], at: now })
      const response = await service.submit(
        { ...scope, actions: [action({ kind: "turn.abort" })] },
        owner
      )
      expect(response.results[0]).toMatchObject({ outcome: "applied" })
    })

    it("still accepts a safe intent from a second device while the first is driving", async () => {
      const service = await serviceWithLease()
      attachController("device-first", "esl-first", now)
      const response = await service.submit(
        { ...scope, actions: [action({ kind: "turn.followup", text: "queue this" })] },
        owner
      )
      expect(response.results[0]).toMatchObject({ outcome: "applied" })
    })

    /**
     * Safe intents describe work to do next rather than work in flight, so a
     * phone with a dead stream can still leave a draft or queue a message and
     * let the queue decide when it runs.
     */
    it("accepts safe intents with no attachment at all", async () => {
      const service = await serviceWithLease()
      const response = await service.submit(
        {
          ...scope,
          actions: [
            action({ kind: "draft.replace", text: "later", attachments: [] }),
            action(
              { kind: "turn.followup", text: "and then this" },
              { actionId: "action-2", clientSeq: 2, baseRevision: 1 }
            ),
          ],
        },
        owner
      )
      expect(response.results.map((result) => result.outcome)).toEqual(["applied", "applied"])
    })
  })

  it("imports a canonical session as a new continuation without touching the source", async () => {
    const publish = jest.fn(async () => undefined)
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      publish,
    })
    await service.start({
      now: 0,
      heartbeat: false,
    })
    const turns = [
      { turnId: "turn-user", role: "user" as const, text: "Question" },
      { turnId: "turn-assistant", role: "assistant" as const, text: "Answer" },
    ]
    const imported = action(
      {
        kind: "session.import",
        envelope: {
          header: {
            canonicalVersion: 1,
            canonicalSessionId: "source-session",
            sourceRuntime: "cognia-cli",
            title: "Imported",
            createdAt: "2026-08-14T00:00:00.000Z",
            updatedAt: "2026-08-14T00:00:00.000Z",
            turnCount: turns.length,
            importFidelity: "structured",
            sequenceDigest: computeSequenceDigest(turns),
          },
          turns,
        },
      },
      {
        channel: sessionStateChannel(scope.runtimeTargetId, "continuation-1"),
        sessionId: "continuation-1",
        actionId: "import-action",
        baseRevision: undefined,
      }
    )

    await expect(service.submit({ ...scope, actions: [imported] }, owner)).resolves.toMatchObject({
      results: [{ actionId: "import-action", outcome: "applied" }],
    })
    await expect(getDb().sessions.get("continuation-1")).resolves.toMatchObject({
      title: "Imported",
      handoffSource: "thread-handoff",
      transcriptRevision: 2,
    })
    await expect(
      getDb().messages.where("sessionId").equals("continuation-1").count()
    ).resolves.toBe(2)
    await expect(getDb().sessions.get("session-1")).resolves.toMatchObject({ title: "Before" })
  })

  it("refuses an intent the caller lacks the capability for, without touching the ledger", async () => {
    const publish = jest.fn(async () => undefined)
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      publish,
    })
    await service.start({ now: 0, heartbeat: false })

    // `host.observe` is what every freshly-paired device holds; truncating a
    // transcript needs `host.admin`.
    const response = await service.submit(
      { ...scope, actions: [action({ kind: "transcript.truncate" })] },
      { deviceId: "device-member", grants: ["host.observe"] }
    )

    expect(response.results).toEqual([
      expect.objectContaining({
        actionId: "action-1",
        outcome: "rejected",
        rejection: expect.objectContaining({ code: "host_state_forbidden" }),
      }),
    ])
    // Nothing durable, and nothing fanned out to the other replicas.
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
    expect(publish).not.toHaveBeenCalled()
  })

  it("applies the granted actions of a mixed batch and rejects only the rest", async () => {
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      publish: jest.fn(async () => undefined),
    })
    await service.start({ now: 0, heartbeat: false })

    const response = await service.submit(
      {
        ...scope,
        actions: [
          action(
            { kind: "draft.replace", text: "allowed", attachments: [] },
            {
              actionId: "action-draft",
              clientSeq: 1,
            }
          ),
          action(
            { kind: "session.create", title: "denied" },
            {
              actionId: "action-create",
              clientSeq: 2,
            }
          ),
        ],
      },
      // Remote Control, but not Agent Control.
      { deviceId: "device-control", grants: ["host.observe", "workspace.write"] }
    )

    expect(response.results).toEqual([
      expect.objectContaining({ actionId: "action-draft", outcome: "applied" }),
      expect.objectContaining({
        actionId: "action-create",
        outcome: "rejected",
        rejection: expect.objectContaining({ code: "host_state_forbidden" }),
      }),
    ])
    await expect(getDb().chatDrafts.get("session-1")).resolves.toMatchObject({ text: "allowed" })
  })

  it("fails the whole batch when the request reached the Host with no bound caller", async () => {
    const service = createHostStateService({ ...scope, hostId, ownerId: "brain-a", now: () => 100 })
    await service.start({ now: 0, heartbeat: false })

    await expect(
      service.submit(
        {
          ...scope,
          actions: [action({ kind: "draft.replace", text: "x", attachments: [] })],
        },
        { deviceId: "", grants: [] }
      )
    ).rejects.toThrow("host_state_caller_unbound")
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
  })

  /**
   * The device id is not the only field that can be missing. A grant list that
   * is not an array of strings means the request skipped `bind_authority` just
   * as surely, and must fail the batch rather than degrade into per-action
   * denials that read like an ordinary permission problem.
   */
  it("fails the whole batch when the caller's grants did not survive binding", async () => {
    const service = createHostStateService({ ...scope, hostId, ownerId: "brain-a", now: () => 100 })
    await service.start({ now: 0, heartbeat: false })

    for (const grants of ["workspace.write", null, [1]] as unknown[]) {
      await expect(
        service.submit(
          {
            ...scope,
            actions: [action({ kind: "draft.replace", text: "x", attachments: [] })],
          },
          { deviceId: "device-a", grants } as never
        )
      ).rejects.toThrow("host_state_caller_unbound")
    }
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
  })

  it("projects canonical runtime envelopes through the ordered HostState ledger", async () => {
    const publish = jest.fn(async () => undefined)
    const service = createHostStateService({
      ...scope,
      hostId,
      ownerId: "brain-a",
      now: () => 100,
      publish,
    })
    await service.start({
      now: 0,
      heartbeat: false,
    })
    const envelope: AgentEventEnvelope = {
      schemaVersion: 1,
      eventId: "runtime-event-1",
      sequence: 1,
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      hostRef: hostId,
      runtime: "anthropic-agent-sdk",
      timestamp: "2026-08-14T00:00:00.000Z",
      event: {
        kind: "permission-request",
        requestId: "approval-1",
        toolName: "Bash",
      },
    }

    await expect(service.projectRuntimeEnvelope(envelope)).resolves.toMatchObject({
      hostSeq: 1,
      mutation: {
        kind: "decision.requested",
        decision: {
          requestId: "approval-1",
          kind: "tool-approval",
          status: "pending",
          label: "Bash",
        },
      },
    })
    await expect(service.projectRuntimeEnvelope(envelope)).resolves.toMatchObject({ hostSeq: 1 })

    const snapshot = await service.snapshot({ ...scope, channel })
    expect(snapshot.state).toMatchObject({
      turn: "awaiting-decision",
      decisions: [{ requestId: "approval-1", kind: "tool-approval", status: "pending" }],
    })
    expect(publish).toHaveBeenCalledTimes(2)
    await expect(getDb().hostStateActions.count()).resolves.toBe(2)
  })

  it("subscribes before snapshot and replays only events after the snapshot cut", async () => {
    const initial = createEmptyHostStateSession(channel, "session-1")
    const snapshot: HostStateSnapshot = {
      channel,
      hostId,
      hostGeneration: 4,
      cutHostSeq: 8,
      revision: 0,
      digest: hostStateDigest(initial),
      state: initial,
    }
    const bufferedEvent: HostStateAppliedAction = {
      channel,
      hostId,
      hostGeneration: 4,
      hostSeq: 9,
      outcome: "applied",
      mutation: { kind: "session.renamed", title: "After cut", revision: 1 },
    }
    let handler: ((event: HostStateAppliedAction) => void) | null = null
    const order: string[] = []
    const transport: Transport = {
      subscribe: (_topic, next) => {
        order.push("subscribe")
        handler = next as (event: HostStateAppliedAction) => void
        return () => undefined
      },
      call: async (command) => {
        if (command === "host_state_status") return writableStatus as never
        order.push("snapshot")
        handler?.(bufferedEvent)
        return snapshot as never
      },
    }

    const sync = await installHostStateSync({
      transport,
      ...scope,
      channels: async () => [channel],
    })

    expect(order).toEqual(["subscribe", "snapshot"])
    await expect(getDb().hostStateChannels.get(channel)).resolves.toMatchObject({
      hostSeq: 9,
      state: { title: "After cut", revision: 1 },
    })
    sync.stop()
  })

  it("reapplies durable pending actions over a fresh snapshot after reload", async () => {
    const initial = createEmptyHostStateSession(channel, "session-1")
    const pendingAction = action(
      {
        kind: "message.enqueue",
        messageId: "pending-message",
        text: "survives reload",
        attachments: [],
      },
      { hostGeneration: 4, actionId: "pending-action", baseRevision: undefined }
    )
    await getDb().mobileOutboundQueue.put({
      id: pendingAction.actionId,
      accountId: scope.accountId,
      targetId: scope.runtimeTargetId,
      command: "host_state_submit",
      payload: { actions: [pendingAction] },
      status: "pending",
      attempts: 0,
      createdAt: 100,
      nextAttemptAt: 100,
      idempotencyKey: pendingAction.actionId,
      protocol: "host-state",
      channel,
      hostGeneration: 4,
      clientId: pendingAction.clientId,
      clientSeq: pendingAction.clientSeq,
      actionId: pendingAction.actionId,
    })
    const snapshot: HostStateSnapshot = {
      channel,
      hostId,
      hostGeneration: 4,
      cutHostSeq: 8,
      revision: 0,
      digest: hostStateDigest(initial),
      state: initial,
    }
    const onState = jest.fn()
    const transport: Transport = {
      subscribe: () => () => undefined,
      call: async (command) =>
        (command === "host_state_status" ? writableStatus : snapshot) as never,
    }

    const sync = await installHostStateSync({
      transport,
      ...scope,
      channels: async () => [channel],
      onState,
    })

    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: "queued",
        queue: [expect.objectContaining({ actionId: "pending-action" })],
      })
    )
    await expect(getDb().messages.get("pending-message")).resolves.toMatchObject({
      sessionId: "session-1",
      parts: [{ type: "text", text: "survives reload" }],
      metadata: { hostState: { actionId: "pending-action", optimistic: true } },
    })
    sync.stop()
  })

  it("re-snapshots and keeps applying after a sequence gap", async () => {
    const initial = createEmptyHostStateSession(channel, "session-1")
    const snapshotAt = (cutHostSeq: number, title?: string): HostStateSnapshot => {
      const state = title ? { ...initial, title, revision: 1 } : initial
      return {
        channel,
        hostId,
        hostGeneration: 4,
        cutHostSeq,
        revision: title ? 1 : 0,
        digest: hostStateDigest(state),
        state,
      }
    }
    const renamed = (hostSeq: number, title: string): HostStateAppliedAction => ({
      channel,
      hostId,
      hostGeneration: 4,
      hostSeq,
      outcome: "applied",
      mutation: { kind: "session.renamed", title, revision: 1 },
    })

    let handler: ((event: HostStateAppliedAction) => void) | null = null
    let snapshots = 0
    const transport: Transport = {
      subscribe: (_topic, next) => {
        handler = next as (event: HostStateAppliedAction) => void
        return () => undefined
      },
      call: async (command) => {
        if (command === "host_state_status") return writableStatus as never
        snapshots += 1
        // First cut at 8; the recovery cut absorbs the skipped 9 and 10.
        return (snapshots === 1 ? snapshotAt(8) : snapshotAt(10, "Recovered")) as never
      },
    }

    const sync = await installHostStateSync({
      transport,
      ...scope,
      channels: async () => [channel],
    })
    expect(snapshots).toBe(1)

    // hostSeq 9 never arrives — 11 is a gap the client cannot reduce against.
    ;(handler as ((event: HostStateAppliedAction) => void) | null)?.(renamed(11, "Missed"))
    await flush()
    expect(snapshots).toBe(2)

    // The stream must still be live: an event on top of the recovery cut applies.
    ;(handler as ((event: HostStateAppliedAction) => void) | null)?.(renamed(11, "Live again"))
    await flush()
    await expect(getDb().hostStateChannels.get(channel)).resolves.toMatchObject({
      hostSeq: 11,
      state: { title: "Live again" },
    })

    // And the documented recovery path still resolves rather than rethrowing.
    await expect(sync.resync()).resolves.toBeUndefined()
    sync.stop()
  })

  it("discovers a remotely created session from the index without a full table pull", async () => {
    const indexChannel = sessionIndexChannel(scope.runtimeTargetId)
    const sessionChannel = sessionStateChannel(scope.runtimeTargetId, "session-remote")
    const remoteState = {
      ...createEmptyHostStateSession(sessionChannel, "session-remote"),
      title: "Remote",
      revision: 1,
    }
    let handler: ((event: HostStateAppliedAction) => void) | null = null
    const calls: string[] = []
    const transport: Transport = {
      subscribe: (_topic, next) => {
        handler = next as (event: HostStateAppliedAction) => void
        return () => undefined
      },
      call: async (command, payload) => {
        if (command === "host_state_status") return writableStatus as never
        const requested = (payload as { channel: string }).channel
        calls.push(requested)
        if (requested === indexChannel) {
          const state = {
            kind: "session-index" as const,
            channel: indexChannel,
            revision: 0,
            sessions: [],
          }
          return {
            channel: indexChannel,
            hostId,
            hostGeneration: 4,
            cutHostSeq: 0,
            revision: 0,
            digest: hostStateDigest(state),
            state,
          } as never
        }
        return {
          channel: sessionChannel,
          hostId,
          hostGeneration: 4,
          cutHostSeq: 2,
          revision: 1,
          digest: hostStateDigest(remoteState),
          state: remoteState,
        } as never
      },
    }
    const sync = await installHostStateSync({
      transport,
      ...scope,
      channels: async () => [indexChannel],
    })
    ;(handler as ((event: HostStateAppliedAction) => void) | null)?.({
      channel: sessionChannel,
      hostId,
      hostGeneration: 4,
      hostSeq: 1,
      outcome: "applied",
      mutation: { kind: "session.renamed", title: "Remote", revision: 1 },
    })
    ;(handler as ((event: HostStateAppliedAction) => void) | null)?.({
      channel: indexChannel,
      hostId,
      hostGeneration: 4,
      hostSeq: 2,
      outcome: "applied",
      mutation: {
        kind: "session.upserted",
        revision: 1,
        session: {
          sessionId: "session-remote",
          title: "Remote",
          conversation: "present",
          turn: "idle",
          revision: 1,
          transcriptRevision: 0,
        },
      },
    })
    await flush()

    expect(calls).toEqual([indexChannel, sessionChannel])
    await expect(getDb().sessions.get("session-remote")).resolves.toMatchObject({
      title: "Remote",
      transcriptRevision: 0,
    })
    sync.stop()
  })
})

describe("HostState Agent RPC dispatcher", () => {
  beforeEach(async () => {
    activateAccountDatabase(scope.accountId, scope.runtimeTargetId)
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase(scope.accountId, scope.runtimeTargetId)
    await getDb().sessions.put({
      id: "session-1",
      title: "Direct",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
    acceptHostStateChatTurnMock.mockReset().mockResolvedValue(null)
    bindHostStateChatTurnContextMock.mockReset().mockResolvedValue(false)
    claimHostStateChatTurnForDispatchMock.mockReset().mockResolvedValue("legacy")
    markHostStateChatTurnStartedMock.mockReset().mockResolvedValue(false)
    startLeaseHeartbeatMock.mockClear()
    stopLeaseHeartbeatMock.mockClear()
    buildSendOptionsMock.mockReset().mockResolvedValue({ model: "sonnet" })
    sendPromptMock.mockReset().mockResolvedValue(undefined)
  }, 30_000)

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("reuses the action id for every idempotent runtime command", async () => {
    const sendMessage = jest.fn(async () => undefined)
    const steer = jest.fn(async () => undefined)
    const abort = jest.fn(async () => undefined)
    const resolveApproval = jest.fn(async () => undefined)
    const resolveElicitation = jest.fn(async () => undefined)
    const dispatch = createAgentRpcHostStateDispatcher({
      sendMessage,
      steer,
      abort,
      resolveApproval,
      resolveElicitation,
    })

    await dispatch(
      action({ kind: "message.enqueue", messageId: "m-1", text: "hello", attachments: [] })
    )
    await dispatch(action({ kind: "turn.followup", text: "next" }, { actionId: "action-2" }))
    await dispatch(action({ kind: "turn.abort" }, { actionId: "action-3" }))
    await dispatch(
      action(
        { kind: "approval.respond", requestId: "approval-1", decision: "allow" },
        { actionId: "action-4" }
      )
    )
    await dispatch(
      action(
        { kind: "elicitation.respond", requestId: "ask-1", response: { answer: "yes" } },
        { actionId: "action-5" }
      )
    )

    expect(sendMessage).toHaveBeenCalledWith("session-1", "hello", "action-1")
    expect(steer).toHaveBeenCalledWith("session-1", "next", "next", "action-2")
    expect(abort).toHaveBeenCalledWith("session-1", "action-3")
    expect(resolveApproval).toHaveBeenCalledWith("session-1", "approval-1", "allow", "action-4")
    expect(resolveElicitation).toHaveBeenCalledWith("session-1", "ask-1", { answer: "yes" })
  })

  it("resolves attachment refs into real content and then frees the staged bytes", async () => {
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const store = await import("@/lib/db/session-attachment-uploads")
    const { sha256Bytes } = await import("@/lib/ocr/hash")
    const init = await store.beginAttachmentUpload({
      sessionId: "session-1",
      deviceId: "dev-1",
      name: "shot.png",
      mediaType: "image/png",
      size: PNG.byteLength,
      hash: await sha256Bytes(PNG),
    })
    await store.appendAttachmentChunk({
      uploadId: init.uploadId,
      deviceId: "dev-1",
      offset: 0,
      bytes: PNG,
    })
    const { ref } = await store.commitAttachmentUpload({
      uploadId: init.uploadId,
      deviceId: "dev-1",
    })

    await createAgentRpcHostStateDispatcher()(
      action({
        kind: "message.enqueue",
        messageId: "m-1",
        text: "look at this",
        attachments: [{ name: "shot.png", mediaType: "image/png", size: PNG.byteLength, ref }],
      })
    )

    // The refs never reach the runtime — the bytes do, through the same
    // `buildSendContent` the desktop composer runs.
    const [, prompt] = sendPromptMock.mock.calls[0]!
    expect(Array.isArray(prompt)).toBe(true)
    expect(prompt).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))

    // Only after the send: before it, the staging copy is the only one there is.
    expect(await store.resolveAttachmentRef(ref, { sessionId: "session-1" })).toBeNull()
  })

  it("fails the dispatch rather than sending a prompt whose attachment vanished", async () => {
    await expect(
      createAgentRpcHostStateDispatcher()(
        action({
          kind: "message.enqueue",
          messageId: "m-1",
          text: "look at this",
          attachments: [
            { name: "gone.png", mediaType: "image/png", size: 4, ref: "cognia-upload:upl_gone" },
          ],
        })
      )
    ).rejects.toThrow("host_state_attachment_unavailable")
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("binds the final send options and marks a durable direct handoff", async () => {
    acceptHostStateChatTurnMock.mockResolvedValueOnce({ submissionId: "work:action-1" })
    claimHostStateChatTurnForDispatchMock.mockResolvedValueOnce("claimed")
    bindHostStateChatTurnContextMock.mockResolvedValueOnce(true)
    const queued = action({
      kind: "message.enqueue",
      messageId: "m-1",
      text: "hello",
      attachments: [],
    })

    await createAgentRpcHostStateDispatcher()(queued)

    expect(bindHostStateChatTurnContextMock).toHaveBeenCalledWith(queued, { model: "sonnet" })
    expect(sendPromptMock).toHaveBeenCalledWith(
      "session-1",
      "hello",
      { model: "sonnet" },
      {
        commandId: "action-1",
      }
    )
    expect(markHostStateChatTurnStartedMock).toHaveBeenCalledWith("action-1")
    expect(startLeaseHeartbeatMock).toHaveBeenCalledWith("work:action-1", "host-state")
    expect(stopLeaseHeartbeatMock).not.toHaveBeenCalled()
    expect(bindHostStateChatTurnContextMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder[0]
    )
  })

  it("does not dispatch when another runner owns the accepted HostState turn", async () => {
    acceptHostStateChatTurnMock.mockResolvedValueOnce({ submissionId: "work:action-1" })
    claimHostStateChatTurnForDispatchMock.mockResolvedValueOnce("owned_elsewhere")

    await createAgentRpcHostStateDispatcher()(
      action({ kind: "message.enqueue", messageId: "m-1", text: "hello", attachments: [] })
    )

    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(bindHostStateChatTurnContextMock).not.toHaveBeenCalled()
    expect(markHostStateChatTurnStartedMock).not.toHaveBeenCalled()
  })

  it("falls back to direct dispatch when durable acceptance fails", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    acceptHostStateChatTurnMock.mockRejectedValueOnce(new Error("ledger unavailable"))
    const queued = action({
      kind: "message.enqueue",
      messageId: "m-1",
      text: "hello",
      attachments: [],
    })

    await createAgentRpcHostStateDispatcher()(queued)

    expect(sendPromptMock).toHaveBeenCalled()
    expect(bindHostStateChatTurnContextMock).not.toHaveBeenCalled()
    expect(markHostStateChatTurnStartedMock).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith("acceptHostStateChatTurn failed", expect.any(Error))
    consoleError.mockRestore()
  })
})
