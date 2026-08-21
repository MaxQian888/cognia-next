/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  createEmptyHostStateSession,
  hostStateDigest,
  sessionIndexChannel,
  sessionStateChannel,
  type HostStateActionV1,
  type HostStateAppliedActionV1,
  type HostStateSnapshotV1,
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
import { commitHostStateAction, markHostStateBroadcast } from "./host-state-store"

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
const channel = sessionStateChannel(scope.runtimeTargetId, "session-1")
const writableStatus = {
  protocolVersion: 1 as const,
  hostId,
  hostGeneration: 4,
  hostSeq: 8,
  leaseExpiresAt: 10_000,
  pendingDispatch: 0,
  pendingBroadcast: 0,
}

function action(
  intent: HostStateActionV1["action"],
  overrides: Partial<HostStateActionV1> = {}
): HostStateActionV1 {
  return {
    protocolVersion: 1,
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

    const response = await service.submit({
      protocolVersion: 1,
      ...scope,
      actions: [action({ kind: "draft.replace", text: "shared", attachments: [] })],
    })

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
        protocolVersion: 1,
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

    await expect(
      service.submit({ protocolVersion: 1, ...scope, actions: [queued] })
    ).rejects.toThrow("runtime offline")
    await expect(service.recover()).resolves.toEqual({ dispatched: 1, broadcast: 1 })
    await expect(
      service.submit({ protocolVersion: 1, ...scope, actions: [queued] })
    ).resolves.toMatchObject({ results: [{ outcome: "duplicate", hostSeq: 1 }] })

    expect(dispatchRuntime).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledTimes(2)
    await expect(getDb().hostStateActions.count()).resolves.toBe(2)
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
        protocolVersion: 1,
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
      service.submit({
        protocolVersion: 1,
        accountId: "acct-other",
        runtimeTargetId: scope.runtimeTargetId,
        actions: [action({ kind: "turn.abort" })],
      })
    ).rejects.toThrow("host_state_scope_mismatch")
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
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

    await expect(
      service.submit({ protocolVersion: 1, ...scope, actions: [imported] })
    ).resolves.toMatchObject({ results: [{ actionId: "import-action", outcome: "applied" }] })
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
        kind: "approval.requested",
        request: { requestId: "approval-1", label: "Bash" },
      },
    })
    await expect(service.projectRuntimeEnvelope(envelope)).resolves.toMatchObject({ hostSeq: 1 })

    const snapshot = await service.snapshot({ protocolVersion: 1, ...scope, channel })
    expect(snapshot.state).toMatchObject({
      pendingApprovals: [{ requestId: "approval-1", label: "Bash" }],
    })
    expect(publish).toHaveBeenCalledTimes(2)
    await expect(getDb().hostStateActions.count()).resolves.toBe(2)
  })

  it("subscribes before snapshot and replays only events after the snapshot cut", async () => {
    const initial = createEmptyHostStateSession(channel, "session-1")
    const snapshot: HostStateSnapshotV1 = {
      protocolVersion: 1,
      channel,
      hostId,
      hostGeneration: 4,
      cutHostSeq: 8,
      revision: 0,
      digest: hostStateDigest(initial),
      state: initial,
    }
    const bufferedEvent: HostStateAppliedActionV1 = {
      protocolVersion: 1,
      channel,
      hostId,
      hostGeneration: 4,
      hostSeq: 9,
      outcome: "applied",
      mutation: { kind: "session.renamed", title: "After cut", revision: 1 },
    }
    let handler: ((event: HostStateAppliedActionV1) => void) | null = null
    const order: string[] = []
    const transport: Transport = {
      subscribe: (_topic, next) => {
        order.push("subscribe")
        handler = next as (event: HostStateAppliedActionV1) => void
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
      payload: { protocolVersion: 1, actions: [pendingAction] },
      status: "pending",
      attempts: 0,
      createdAt: 100,
      nextAttemptAt: 100,
      idempotencyKey: pendingAction.actionId,
      protocol: "host-state-v1",
      channel,
      hostGeneration: 4,
      clientId: pendingAction.clientId,
      clientSeq: pendingAction.clientSeq,
      actionId: pendingAction.actionId,
    })
    const snapshot: HostStateSnapshotV1 = {
      protocolVersion: 1,
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
        status: "queued",
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
    const snapshotAt = (cutHostSeq: number, title?: string): HostStateSnapshotV1 => {
      const state = title ? { ...initial, title, revision: 1 } : initial
      return {
        protocolVersion: 1,
        channel,
        hostId,
        hostGeneration: 4,
        cutHostSeq,
        revision: title ? 1 : 0,
        digest: hostStateDigest(state),
        state,
      }
    }
    const renamed = (hostSeq: number, title: string): HostStateAppliedActionV1 => ({
      protocolVersion: 1,
      channel,
      hostId,
      hostGeneration: 4,
      hostSeq,
      outcome: "applied",
      mutation: { kind: "session.renamed", title, revision: 1 },
    })

    let handler: ((event: HostStateAppliedActionV1) => void) | null = null
    let snapshots = 0
    const transport: Transport = {
      subscribe: (_topic, next) => {
        handler = next as (event: HostStateAppliedActionV1) => void
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
    ;(handler as ((event: HostStateAppliedActionV1) => void) | null)?.(renamed(11, "Missed"))
    await flush()
    expect(snapshots).toBe(2)

    // The stream must still be live: an event on top of the recovery cut applies.
    ;(handler as ((event: HostStateAppliedActionV1) => void) | null)?.(renamed(11, "Live again"))
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
    let handler: ((event: HostStateAppliedActionV1) => void) | null = null
    const calls: string[] = []
    const transport: Transport = {
      subscribe: (_topic, next) => {
        handler = next as (event: HostStateAppliedActionV1) => void
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
            protocolVersion: 1,
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
          protocolVersion: 1,
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
    ;(handler as ((event: HostStateAppliedActionV1) => void) | null)?.({
      protocolVersion: 1,
      channel: sessionChannel,
      hostId,
      hostGeneration: 4,
      hostSeq: 1,
      outcome: "applied",
      mutation: { kind: "session.renamed", title: "Remote", revision: 1 },
    })
    ;(handler as ((event: HostStateAppliedActionV1) => void) | null)?.({
      protocolVersion: 1,
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
          status: "idle",
          revision: 1,
          transcriptRevision: 0,
          archived: false,
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
