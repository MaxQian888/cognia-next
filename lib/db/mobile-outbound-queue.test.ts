/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { LEGACY_MIXED_TARGET_ID } from "@/lib/runtime/target-registry"
import {
  claimNext,
  enqueue,
  enqueueHostStateAction,
  enqueueHostStateIntentIfAvailable,
  listByStatus,
  markHostStateResult,
  releaseClaim,
  retryDeadletter,
} from "./mobile-outbound-queue"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "./schema"
import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { setActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import {
  createEmptyHostStateSession,
  sessionStateChannel,
} from "@cognia/agent-config-types/host-state"

const scope = { accountId: "acct_queue", targetId: "desktop-studio", routingGeneration: 1 }

describe("mobile outbound queue target isolation", () => {
  beforeEach(async () => {
    activateAccountDatabase(scope.accountId, scope.targetId)
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase(scope.accountId, scope.targetId)
    setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
    __resetRuntimeSnapshotForTesting()
    localStorage.clear()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetRuntimeSnapshotForTesting()
  })

  it("persists the account and runtime target that owned an enqueued action", async () => {
    const row = await enqueue({
      command: "connector_send",
      payload: { text: "hello" },
      ...scope,
    })

    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject({
      accountId: scope.accountId,
      targetId: scope.targetId,
    })
  })

  it("reuses the durable queue for HostState actions and retains terminal conflicts", async () => {
    const row = await enqueueHostStateAction({
      protocolVersion: 1,
      channel: "cognia://target/desktop-studio/sessions/s1",
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 2,
      sessionId: "s1",
      clientId: "client-a",
      clientSeq: 4,
      actionId: "action-4",
      baseRevision: 1,
      createdAt: 100,
      action: { kind: "draft.replace", text: "draft", attachments: [] },
    })

    expect(row).toMatchObject({
      protocol: "host-state-v1",
      command: "host_state_submit",
      idempotencyKey: "action-4",
      actionId: "action-4",
      clientSeq: 4,
      hostGeneration: 2,
      status: "pending",
    })
    await markHostStateResult(row.id, {
      outcome: "conflicted",
      rejection: { code: "host_state_revision_conflict", currentRevision: 2 },
    })
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject({
      status: "conflicted",
      rejectionCode: "host_state_revision_conflict",
      currentRevision: 2,
    })
  })

  it("returns a policy-frozen claim to pending without incrementing attempts", async () => {
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await expect(claimNext(1, scope)).resolves.toMatchObject({ id: row.id, status: "sending" })

    await releaseClaim(row.id)

    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 0,
    })
  })

  it("atomically builds negotiated HostState intents from the confirmed snapshot", async () => {
    const channel = sessionStateChannel(scope.targetId, "s1")
    await getDb().hostStateChannels.put({
      channel,
      hostId: "host-authority",
      hostGeneration: 7,
      hostSeq: 11,
      revision: 3,
      digest: "digest",
      state: createEmptyHostStateSession(scope.targetId, "s1"),
      updatedAt: 100,
    })
    setRuntimeSnapshot({
      target: {
        id: scope.targetId,
        kind: "companion",
        platform: "web",
        hostKind: "desktop",
      },
      vaultState: "unlocked",
      connectionState: "offline",
      host: {
        compatible: true,
        operations: ["host_state_submit"],
        grants: [],
      },
    })

    const [first, second] = await Promise.all([
      enqueueHostStateIntentIfAvailable({
        sessionId: "s1",
        actionId: "action-a",
        clientId: "client-a",
        nowMs: 101,
        action: { kind: "draft.replace", text: "one", attachments: [] },
      }),
      enqueueHostStateIntentIfAvailable({
        sessionId: "s1",
        actionId: "action-b",
        clientId: "client-a",
        nowMs: 102,
        action: { kind: "message.enqueue", messageId: "message-b", text: "two", attachments: [] },
      }),
    ])

    expect([first?.clientSeq, second?.clientSeq].sort()).toEqual([1, 2])
    const action = (
      second?.payload as {
        actions: Array<Record<string, unknown>>
      }
    ).actions[0]
    expect(action).toMatchObject({
      hostId: "host-authority",
      hostGeneration: 7,
      runtimeTargetId: scope.targetId,
      clientId: "client-a",
    })
    expect(action).not.toHaveProperty("baseRevision")
    expect(
      (first?.payload as { actions: Array<Record<string, unknown>> }).actions[0]
    ).toMatchObject({
      baseRevision: 3,
    })
  })

  it("keeps legacy writes when HostState was not negotiated or has no confirmed snapshot", async () => {
    setRuntimeSnapshot({
      target: {
        id: scope.targetId,
        kind: "companion",
        platform: "web",
        hostKind: "desktop",
      },
      vaultState: "unlocked",
      connectionState: "online",
      host: { compatible: true, operations: [], grants: [] },
    })

    await expect(
      enqueueHostStateIntentIfAvailable({
        sessionId: "s1",
        action: { kind: "message.enqueue", messageId: "m1", text: "hello", attachments: [] },
      })
    ).resolves.toBeNull()
    await expect(getDb().mobileOutboundQueue.count()).resolves.toBe(0)
  })

  it("shows quarantined legacy actions to their account without dispatching them", async () => {
    await getDb().mobileOutboundQueue.put({
      id: "legacy-action",
      accountId: scope.accountId,
      targetId: LEGACY_MIXED_TARGET_ID,
      command: "workflow_trigger_manual",
      payload: { workflowId: "wf-1" },
      status: "deadlettered",
      attempts: 0,
      createdAt: 100,
      nextAttemptAt: 100,
      idempotencyKey: "legacy-key",
      lastError: "Legacy outbound action could not be safely attributed to a runtime target.",
    })

    await expect(listByStatus("deadlettered", scope)).resolves.toEqual([
      expect.objectContaining({ id: "legacy-action" }),
    ])

    await expect(retryDeadletter("legacy-action", 200)).rejects.toThrow(/cannot be retried/i)
    await expect(claimNext(200, scope)).resolves.toBeNull()
  })
})
