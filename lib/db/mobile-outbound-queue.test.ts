/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { LEGACY_MIXED_TARGET_ID } from "@/lib/runtime/target-registry"
import {
  CLAIM_ABANDONED_AFTER_MS,
  claimNext,
  discardCollabConflict,
  enqueue,
  enqueueCollabMutation,
  enqueueHostStateAction,
  enqueueHostStateIntentIfAvailable,
  listByStatus,
  markHostStateResult,
  markCollabConflict,
  recordFailure,
  releaseClaim,
  releaseStaleClaims,
  rebaseCollabConflict,
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
      protocol: "host-state",
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

  it("keeps collab conflicts for explicit discard or rebase", async () => {
    const row = await enqueueCollabMutation({
      ...scope,
      command: "collab_issue_patch",
      orgId: "org_1",
      entityType: "issue",
      entityId: "iss_1",
      payload: { issueId: "iss_1", baseRevision: 1, title: "Local title" },
      operationId: "op-stale",
    })
    await markCollabConflict(row.id, "revision conflict", {
      id: "iss_1",
      title: "Server title",
      revision: 4,
    })

    const replacement = await rebaseCollabConflict(row.id)
    expect(replacement).toMatchObject({
      protocol: "collab-v1",
      status: "pending",
      targetId: scope.targetId,
      payload: expect.objectContaining({
        issueId: "iss_1",
        title: "Local title",
        baseRevision: 4,
      }),
    })
    expect(replacement.id).not.toBe(row.id)
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toBeUndefined()

    await markCollabConflict(replacement.id, "revision conflict", { revision: 5 })
    await discardCollabConflict(replacement.id)
    await expect(getDb().mobileOutboundQueue.get(replacement.id)).resolves.toBeUndefined()
  })

  it("tells the user a conflicted create cannot be rebased, rather than calling it corrupt", async () => {
    // A create carries no entity id and has no base revision to move forward,
    // so it fell through to the payload-shape check and reported the row as
    // malformed — a data-corruption message for an ordinary, actionable state.
    const row = await enqueueCollabMutation({
      ...scope,
      command: "collab_plan_create",
      orgId: "org_1",
      entityType: "plan",
      entityId: "plan_1",
      payload: { workspaceId: "ws_1", title: "Local plan" },
      operationId: "op-create",
    })
    await markCollabConflict(row.id, "revision conflict", { id: "plan_1", revision: 2 })

    await expect(rebaseCollabConflict(row.id)).rejects.toThrow(/cannot be rebased/i)
    await expect(rebaseCollabConflict(row.id)).rejects.not.toThrow(/malformed/i)
    // Refused, not consumed — the row is still there to discard.
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject({
      status: "conflicted",
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

/**
 * Head-of-line ordering. The Host applies actions in the order they arrive,
 * while the client's own optimistic projection sorts by `clientSeq` — so a row
 * that overtook its predecessor made the two silently disagree until a resync.
 */
describe("per-channel dispatch order", () => {
  const channel = sessionStateChannel(scope.targetId, "s-order")
  const other = sessionStateChannel(scope.targetId, "s-other")

  beforeEach(async () => {
    activateAccountDatabase(scope.accountId, scope.targetId)
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase(scope.accountId, scope.targetId)
    setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  async function seed(
    id: string,
    clientSeq: number,
    overrides: Partial<{
      status: "pending" | "sending" | "failed" | "deadlettered" | "rejected"
      nextAttemptAt: number
      channel: string
      createdAt: number
    }> = {}
  ) {
    await getDb().mobileOutboundQueue.put({
      id,
      accountId: scope.accountId,
      targetId: scope.targetId,
      command: "host_state_submit",
      payload: { actions: [] },
      status: overrides.status ?? "pending",
      attempts: 0,
      createdAt: overrides.createdAt ?? clientSeq,
      nextAttemptAt: overrides.nextAttemptAt ?? 0,
      idempotencyKey: id,
      protocol: "host-state",
      channel: overrides.channel ?? channel,
      hostGeneration: 1,
      clientId: "client-a",
      clientSeq,
      actionId: id,
    })
  }

  it("holds a channel's successors behind a row that is backing off", async () => {
    await seed("first", 1, { nextAttemptAt: 5_000 })
    await seed("second", 2)

    await expect(claimNext(1_000, scope)).resolves.toBeNull()
    await expect(claimNext(5_000, scope)).resolves.toMatchObject({ id: "first" })
  })

  it("holds them behind one that is already in flight", async () => {
    await seed("first", 1, { status: "sending" })
    await seed("second", 2)
    await expect(claimNext(1_000, scope)).resolves.toBeNull()
  })

  /**
   * A retry is `pending` with a future `nextAttemptAt`, never `failed`:
   * `recordFailure` stores `decideNextAttempt`'s verdict, which is `pending` or
   * `deadlettered`. This pins the shape a real retry has, so the backoff case
   * above is exercised against a status the queue can actually reach.
   */
  it("puts a retry back to pending rather than to a status nothing claims", async () => {
    await seed("first", 1)
    const status = await recordFailure({
      id: "first",
      error: new Error("flaky link"),
      nowMs: 1_000,
    })
    expect(status).toBe("pending")
    expect((await getDb().mobileOutboundQueue.get("first"))?.status).toBe("pending")
  })

  /**
   * The reclaim exists for a claim whose process died. A second runner for the
   * same scope can start while the first is still awaiting its dispatch, and a
   * blanket reclaim handed that row to both at once.
   */
  it("leaves a claim young enough to still be in flight alone", async () => {
    await seed("first", 1, { status: "sending" })
    await getDb().mobileOutboundQueue.update("first", { claimedAt: 900 })

    await expect(releaseStaleClaims(scope, 1_000)).resolves.toBe(0)
    expect((await getDb().mobileOutboundQueue.get("first"))?.status).toBe("sending")

    await expect(releaseStaleClaims(scope, 900 + CLAIM_ABANDONED_AFTER_MS)).resolves.toBe(1)
    expect((await getDb().mobileOutboundQueue.get("first"))?.status).toBe("pending")
  })

  it("reclaims a claim that carries no stamp at all", async () => {
    await seed("first", 1, { status: "sending" })

    await expect(releaseStaleClaims(scope, 1_000)).resolves.toBe(1)
    expect((await getDb().mobileOutboundQueue.get("first"))?.status).toBe("pending")
  })

  it("never lets one stalled session block another", async () => {
    await seed("blocked", 1, { nextAttemptAt: 5_000 })
    await seed("blocked-next", 2)
    await seed("free", 1, { channel: other, createdAt: 10 })

    await expect(claimNext(1_000, scope)).resolves.toMatchObject({ id: "free" })
  })

  /**
   * A terminal row has already been surfaced for the user to decide on.
   * Blocking the session behind it would freeze every future action on a row
   * nothing is going to move on its own.
   */
  it("does not block behind a row that reached a terminal state", async () => {
    await seed("dead", 1, { status: "deadlettered" })
    await seed("refused", 2, { status: "rejected" })
    await seed("next", 3)

    await expect(claimNext(1_000, scope)).resolves.toMatchObject({ id: "next" })
  })

  it("leaves legacy rows with no channel unordered, as they always were", async () => {
    await getDb().mobileOutboundQueue.put({
      id: "legacy",
      accountId: scope.accountId,
      targetId: scope.targetId,
      command: "connector_send",
      payload: {},
      status: "pending",
      attempts: 0,
      createdAt: 99,
      nextAttemptAt: 0,
      idempotencyKey: "legacy",
    })
    await seed("blocked", 1, { nextAttemptAt: 5_000 })
    await seed("blocked-next", 2)

    await expect(claimNext(1_000, scope)).resolves.toMatchObject({ id: "legacy" })
  })

  /**
   * The retry keeps its `actionId` — a dispatch that reached the Host before
   * the client gave up is recognised as a duplicate rather than applied twice —
   * but takes a fresh sequence. Re-entering at the old one would park it
   * permanently at the head of a channel whose work is already done.
   *
   * The tail is measured against what is still OUTSTANDING, not against every
   * row the table has ever held: nothing waits behind a `sent` row, and reading
   * them all meant walking the whole table inside the retry's write
   * transaction.
   */
  it("re-stamps a manual retry behind everything still outstanding on its channel", async () => {
    await seed("dead", 1, { status: "deadlettered" })
    await seed("later", 2)

    await retryDeadletter("dead", 7_000)

    const row = await getDb().mobileOutboundQueue.get("dead")
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: 7_000,
      clientSeq: 3,
      actionId: "dead",
      idempotencyKey: "dead",
    })
    // `later` is now the channel head; the retry waits its turn behind it.
    await expect(claimNext(7_000, scope)).resolves.toMatchObject({ id: "later" })
  })

  it("makes a retry claimable again once its channel has drained", async () => {
    await seed("dead", 1, { status: "deadlettered" })
    await seed("later", 2, { status: "sent" as never })

    await retryDeadletter("dead", 7_000)

    expect((await getDb().mobileOutboundQueue.get("dead"))?.clientSeq).toBe(2)
    await expect(claimNext(7_000, scope)).resolves.toMatchObject({ id: "dead" })
  })

  it("clears the previous refusal when a rejected row is retried", async () => {
    await seed("refused", 1, { status: "rejected" })
    await getDb().mobileOutboundQueue.update("refused", {
      rejectionCode: "host_state_revision_conflict",
      currentRevision: 4,
    })

    await retryDeadletter("refused", 7_000)

    const row = await getDb().mobileOutboundQueue.get("refused")
    expect(row?.rejectionCode).toBeUndefined()
    expect(row?.currentRevision).toBeUndefined()
  })
})
