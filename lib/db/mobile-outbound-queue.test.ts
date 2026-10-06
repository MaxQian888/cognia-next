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
  enqueueUnlessQueued,
  hostOwnsSessionState,
  hostStateSessionIntentAvailable,
  isAbandonedClaim,
  listByStatus,
  markHostStateResult,
  markCollabConflict,
  nextQueueWakeAt,
  offerHostStateRow,
  recordFailure,
  releaseClaim,
  releaseStaleClaims,
  rebaseCollabConflict,
  renewClaim,
  retryDeadletter,
  supersededHostStateDraftIds,
  withdrawQueuedAction,
} from "./mobile-outbound-queue"
import type { MobileOutboundJobRow } from "./mobile-outbound-types"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "./schema"
import {
  __resetRuntimeSnapshotForTesting,
  setRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { setActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import {
  createEmptyHostStateSession,
  sessionIndexChannel,
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

  it("mints UUID idempotency keys for paired-host read markers", async () => {
    const first = await enqueue({
      command: "session_mark_read",
      payload: { sessionId: "s1", readThrough: 20 },
    })
    const second = await enqueue({
      command: "session_mark_read",
      payload: { sessionId: "s1", readThrough: 20 },
    })
    expect(first.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    expect((await getDb().mobileOutboundQueue.get(first.id))?.idempotencyKey).toBe(
      first.idempotencyKey
    )
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

  it("withdraws a standalone action that has not started sending", async () => {
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await expect(withdrawQueuedAction(row.id, 2)).resolves.toBe("withdrawn")
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toBeUndefined()
  })

  it("withdraws a row backing off between attempts, but says an attempt may have landed", async () => {
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await claimNext(1, scope)
    await recordFailure({ id: row.id, error: new Error("host unreachable"), nowMs: 2 })

    await expect(withdrawQueuedAction(row.id, 3)).resolves.toBe("withdrawn-unconfirmed")
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toBeUndefined()
  })

  it("refuses to withdraw a row a live dispatcher is holding", async () => {
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await claimNext(1, scope)
    await expect(withdrawQueuedAction(row.id, 1 + CLAIM_ABANDONED_AFTER_MS - 1)).resolves.toBe(
      "in-flight"
    )
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject({
      status: "sending",
    })
  })

  /**
   * The restart case: the process that claimed it died, so nothing will ever
   * finish the send, and refusing left "Sending" on screen with no way out.
   */
  it("withdraws a sending row whose claim was abandoned", async () => {
    const row = await enqueue({
      command: "workflow_trigger_manual",
      payload: {},
      ...scope,
      nowMs: 1,
    })
    await claimNext(1, scope)
    await expect(withdrawQueuedAction(row.id, 1 + CLAIM_ABANDONED_AFTER_MS)).resolves.toBe(
      "withdrawn-unconfirmed"
    )
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toBeUndefined()
  })

  it("answers gone for a row that is no longer queued, and refuses terminal rows", async () => {
    await expect(withdrawQueuedAction("missing")).resolves.toBe("gone")
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await getDb().mobileOutboundQueue.update(row.id, { status: "deadlettered" })
    await expect(withdrawQueuedAction(row.id)).resolves.toBe("not-withdrawable")
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toBeDefined()
  })

  it("refuses to withdraw a conversation send, whose copy is already on screen", async () => {
    const row = await enqueueHostStateAction({
      channel: "cognia://target/desktop-studio/sessions/s1",
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 2,
      sessionId: "s1",
      clientId: "client-a",
      clientSeq: 1,
      actionId: "action-1",
      baseRevision: 1,
      createdAt: 100,
      action: { kind: "draft.replace", text: "draft", attachments: [] },
    })
    await expect(withdrawQueuedAction(row.id)).resolves.toBe("not-withdrawable")
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toBeDefined()
  })

  it("renews a live claim, and never resurrects one that has ended", async () => {
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await claimNext(1, scope)
    await renewClaim(row.id, 500)
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject({
      status: "sending",
      claimedAt: 500,
    })
    await releaseClaim(row.id)
    await renewClaim(row.id, 900)
    const released = await getDb().mobileOutboundQueue.get(row.id)
    expect(released?.status).toBe("pending")
    expect(released?.claimedAt).toBeUndefined()
  })

  it("tells an abandoned claim from a live one by its last renewal", () => {
    expect(isAbandonedClaim({ status: "pending" }, 10)).toBe(false)
    expect(isAbandonedClaim({ status: "sending" }, 10)).toBe(true)
    expect(
      isAbandonedClaim({ status: "sending", claimedAt: 10 }, 10 + CLAIM_ABANDONED_AFTER_MS - 1)
    ).toBe(false)
    expect(
      isAbandonedClaim({ status: "sending", claimedAt: 10 }, 10 + CLAIM_ABANDONED_AFTER_MS)
    ).toBe(true)
  })

  it("names the next moment only the clock can move: a backoff expiry or a claim going stale", async () => {
    await expect(nextQueueWakeAt(scope, 1_000)).resolves.toBeNull()
    const ready = await enqueue({
      command: "connector_send",
      payload: { n: 1 },
      ...scope,
      nowMs: 1,
    })
    // Ready now: a write already announced it, so it asks for no timer.
    await expect(nextQueueWakeAt(scope, 1_000)).resolves.toBeNull()
    await getDb().mobileOutboundQueue.update(ready.id, { nextAttemptAt: 9_000 })
    await expect(nextQueueWakeAt(scope, 1_000)).resolves.toBe(9_000)

    const claimed = await enqueue({
      command: "connector_send",
      payload: { n: 2 },
      ...scope,
      nowMs: 1,
    })
    await getDb().mobileOutboundQueue.update(claimed.id, { status: "sending", claimedAt: 500 })
    await expect(nextQueueWakeAt(scope, 1_000)).resolves.toBe(
      Math.min(9_000, 500 + CLAIM_ABANDONED_AFTER_MS)
    )
    // Another target's rows are someone else's runner's business.
    await expect(nextQueueWakeAt({ ...scope, targetId: "other-host" }, 1_000)).resolves.toBeNull()
  })

  describe("enqueueUnlessQueued", () => {
    it("returns the waiting run instead of stacking a second one", async () => {
      const first = await enqueueUnlessQueued({
        command: "workflow_trigger_manual",
        payload: { workflowId: "wf-1", inputs: { a: 1, b: 2 } },
        label: "Daily digest",
        ...scope,
      })
      expect(first.alreadyQueued).toBe(false)
      // Same payload, keys in another order.
      const again = await enqueueUnlessQueued({
        command: "workflow_trigger_manual",
        payload: { inputs: { b: 2, a: 1 }, workflowId: "wf-1" },
        ...scope,
      })
      expect(again).toEqual({
        row: expect.objectContaining({ id: first.row.id }),
        alreadyQueued: true,
      })
      await expect(getDb().mobileOutboundQueue.count()).resolves.toBe(1)
    })

    it("also counts a run that is on the wire right now", async () => {
      const first = await enqueueUnlessQueued({
        command: "workflow_trigger_manual",
        payload: { workflowId: "wf-1" },
        ...scope,
        nowMs: 1,
      })
      await claimNext(1, scope)
      await expect(
        enqueueUnlessQueued({
          command: "workflow_trigger_manual",
          payload: { workflowId: "wf-1" },
          ...scope,
        })
      ).resolves.toMatchObject({
        alreadyQueued: true,
        row: { id: first.row.id, status: "sending" },
      })
    })

    it("queues a new request once the earlier one has left the queue's hands", async () => {
      const first = await enqueueUnlessQueued({
        command: "workflow_trigger_manual",
        payload: { workflowId: "wf-1" },
        ...scope,
      })
      await getDb().mobileOutboundQueue.update(first.row.id, { status: "sent" })
      const second = await enqueueUnlessQueued({
        command: "workflow_trigger_manual",
        payload: { workflowId: "wf-1" },
        ...scope,
      })
      expect(second.alreadyQueued).toBe(false)
      expect(second.row.id).not.toBe(first.row.id)
    })

    it("keeps different workflows, commands and targets apart", async () => {
      await enqueueUnlessQueued({
        command: "workflow_trigger_manual",
        payload: { workflowId: "wf-1" },
        ...scope,
      })
      const results = await Promise.all([
        enqueueUnlessQueued({
          command: "workflow_trigger_manual",
          payload: { workflowId: "wf-2" },
          ...scope,
        }),
        enqueueUnlessQueued({
          command: "bot_run_manual",
          payload: { workflowId: "wf-1" },
          ...scope,
        }),
        enqueueUnlessQueued({
          command: "workflow_trigger_manual",
          payload: { workflowId: "wf-1" },
          ...scope,
          targetId: "other-host",
        }),
      ])
      expect(results.map((result) => result.alreadyQueued)).toEqual([false, false, false])
      await expect(getDb().mobileOutboundQueue.count()).resolves.toBe(4)
    })

    it("lets exactly one of two simultaneous taps through", async () => {
      const [a, b] = await Promise.all([
        enqueueUnlessQueued({
          command: "workflow_trigger_manual",
          payload: { workflowId: "wf-1" },
          ...scope,
        }),
        enqueueUnlessQueued({
          command: "workflow_trigger_manual",
          payload: { workflowId: "wf-1" },
          ...scope,
        }),
      ])
      expect([a.alreadyQueued, b.alreadyQueued].sort()).toEqual([false, true])
      expect(a.row.id).toBe(b.row.id)
      await expect(getDb().mobileOutboundQueue.count()).resolves.toBe(1)
    })

    it("refuses conversation sends, which are ordered and never deduplicated", async () => {
      await expect(
        enqueueUnlessQueued({
          command: "host_state_submit",
          payload: {},
          channel: "cognia://target/desktop-studio/sessions/s1",
          ...scope,
        })
      ).rejects.toThrow(/standalone actions/)
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

  it("keeps the clashing fields of a field-level conflict on the row", async () => {
    const row = await enqueueCollabMutation({
      ...scope,
      command: "collab_issue_patch",
      orgId: "org_1",
      entityType: "issue",
      entityId: "iss_1",
      payload: { issueId: "iss_1", baseRevision: 1, status: "done" },
      operationId: "op-field",
    })
    const fields = { status: { yours: "done", theirs: "todo", changedAt: 2, changedBy: "usr_b" } }
    await markCollabConflict(row.id, "field conflict", { id: "iss_1", revision: 3 }, fields)
    const stored = await getDb().mobileOutboundQueue.get(row.id)
    expect(stored).toMatchObject({
      status: "conflicted",
      currentRevision: 3,
      conflictFields: fields,
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

  it("writes in the Host's namespace but files the row under the local delivery scope", async () => {
    // The Host stores its channels under `local-host`; this client knows the
    // pairing as `desktop-studio`. The action has to be addressed the Host's
    // way, but the row has to stay findable by the runner, which filters on
    // the local pair.
    const hostChannel = sessionStateChannel("local-host", "s1")
    await getDb().hostStateChannels.put({
      channel: hostChannel,
      hostId: "host-authority",
      hostGeneration: 7,
      hostSeq: 11,
      revision: 3,
      digest: "digest",
      state: createEmptyHostStateSession("local-host", "s1"),
      updatedAt: 100,
    })
    setRuntimeSnapshot({
      target: { id: scope.targetId, kind: "companion", platform: "web", hostKind: "desktop" },
      vaultState: "unlocked",
      connectionState: "online",
      host: {
        compatible: true,
        operations: ["host_state_submit"],
        grants: [],
        hostStateScope: { accountId: "local_acct_a", runtimeTargetId: "local-host" },
      },
    })

    const row = await enqueueHostStateIntentIfAvailable({
      sessionId: "s1",
      actionId: "action-scoped",
      clientId: "client-a",
      nowMs: 200,
      action: { kind: "message.enqueue", messageId: "m-scoped", text: "hi", attachments: [] },
    })

    expect(row).not.toBeNull()
    // Wire side — the Host's namespace.
    expect(row?.channel).toBe(hostChannel)
    expect((row?.payload as { actions: Array<Record<string, unknown>> }).actions[0]).toMatchObject({
      accountId: "local_acct_a",
      runtimeTargetId: "local-host",
      channel: hostChannel,
    })
    // Local side — what the outbound runner filters on.
    expect(row?.accountId).toBe(scope.accountId)
    expect(row?.targetId).toBe(scope.targetId)
  })

  it("keeps one queued draft per conversation while the Host has seen none of them", async () => {
    const channel = sessionStateChannel(scope.targetId, "s-drafts")
    await getDb().hostStateChannels.put({
      channel,
      hostId: "host-authority",
      hostGeneration: 4,
      hostSeq: 0,
      revision: 0,
      digest: "digest",
      state: createEmptyHostStateSession(scope.targetId, "s-drafts"),
      updatedAt: 100,
    })
    setRuntimeSnapshot({
      target: { id: scope.targetId, kind: "companion", platform: "mobile", hostKind: "desktop" },
      vaultState: "unlocked",
      connectionState: "online",
      host: { compatible: true, operations: ["host_state_submit"], grants: [] },
    })
    const draft = (actionId: string, text: string) =>
      enqueueHostStateIntentIfAvailable({
        sessionId: "s-drafts",
        actionId,
        clientId: "client-a",
        nowMs: 300,
        action: { kind: "draft.replace", text, attachments: [] },
      })

    await draft("draft-1", "h")
    await enqueueHostStateIntentIfAvailable({
      sessionId: "s-drafts",
      actionId: "send",
      clientId: "client-a",
      nowMs: 300,
      action: { kind: "message.enqueue", messageId: "m1", text: "hi", attachments: [] },
    })
    await draft("draft-2", "he")
    await draft("draft-3", "hello")

    const rows = await getDb().mobileOutboundQueue.toArray()
    // The send is never collapsed; of the drafts only the last survives, and
    // it still sorts after the send.
    expect(rows.map((row) => [row.actionId, row.clientSeq]).sort()).toEqual([
      ["draft-3", 4],
      ["send", 2],
    ])
  })

  it("falls back to the local scope when the Host declares none", async () => {
    const channel = sessionStateChannel(scope.targetId, "s2")
    await getDb().hostStateChannels.put({
      channel,
      hostId: "host-authority",
      hostGeneration: 7,
      hostSeq: 11,
      revision: 3,
      digest: "digest",
      state: createEmptyHostStateSession(scope.targetId, "s2"),
      updatedAt: 100,
    })
    setRuntimeSnapshot({
      target: { id: scope.targetId, kind: "companion", platform: "web", hostKind: "desktop" },
      vaultState: "unlocked",
      connectionState: "online",
      host: { compatible: true, operations: ["host_state_submit"], grants: [] },
    })

    const row = await enqueueHostStateIntentIfAvailable({
      sessionId: "s2",
      actionId: "action-legacy-scope",
      clientId: "client-a",
      nowMs: 201,
      action: { kind: "message.enqueue", messageId: "m-legacy", text: "hi", attachments: [] },
    })

    expect(row?.channel).toBe(channel)
    expect(row?.targetId).toBe(scope.targetId)
  })

  it("says whether a session intent would be queued, without queueing anything", async () => {
    const snapshot = (operations: string[]) =>
      setRuntimeSnapshot({
        target: { id: scope.targetId, kind: "companion", platform: "web", hostKind: "desktop" },
        vaultState: "unlocked",
        connectionState: "online",
        host: { compatible: true, operations, grants: [] },
      })
    snapshot([])
    // Not negotiated.
    await expect(hostStateSessionIntentAvailable("s-avail")).resolves.toBe(false)
    snapshot(["host_state_submit"])
    // Negotiated, but the session has no confirmed Host snapshot yet.
    await expect(hostStateSessionIntentAvailable("s-avail")).resolves.toBe(false)
    await getDb().hostStateChannels.put({
      channel: sessionStateChannel(scope.targetId, "s-avail"),
      hostId: "host-authority",
      hostGeneration: 1,
      hostSeq: 1,
      revision: 1,
      digest: "digest",
      state: createEmptyHostStateSession(scope.targetId, "s-avail"),
      updatedAt: 100,
    })
    await expect(hostStateSessionIntentAvailable("s-avail")).resolves.toBe(true)
    await expect(hostStateSessionIntentAvailable("")).resolves.toBe(false)
    await expect(getDb().mobileOutboundQueue.count()).resolves.toBe(0)
  })

  it("says the Host owns the session rows exactly when a target negotiated HostState submit", () => {
    const host = (operations: string[]) => ({ compatible: true, operations, grants: [] })
    const companion = {
      id: scope.targetId,
      kind: "companion" as const,
      platform: "web" as const,
      hostKind: "desktop" as const,
    }
    const base = { vaultState: "unlocked" as const, connectionState: "online" as const }

    expect(
      hostOwnsSessionState({ ...base, target: companion, host: host(["host_state_submit"]) })
    ).toBe(true)
    // A native host (no client target) that advertises the operation also routes.
    expect(hostOwnsSessionState({ ...base, target: null, host: host(["host_state_submit"]) })).toBe(
      true
    )
    expect(hostOwnsSessionState({ ...base, target: companion, host: host([]) })).toBe(false)
    expect(
      hostOwnsSessionState({
        ...base,
        target: companion,
        host: { ...host(["host_state_submit"]), compatible: false },
      })
    ).toBe(false)
    expect(hostOwnsSessionState({ ...base, target: companion })).toBe(false)
    expect(
      hostOwnsSessionState({
        ...base,
        target: { ...companion, kind: "standalone" as const },
        host: host(["host_state_submit"]),
      })
    ).toBe(false)
    // No active runtime target context: nothing routes to a Host.
    expect(
      hostOwnsSessionState({ ...base, target: companion, host: host(["host_state_submit"]) }, null)
    ).toBe(false)
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

  it("addresses a folder intent to the session index, with no session id", async () => {
    const indexChannel = sessionIndexChannel(scope.targetId)
    await getDb().hostStateChannels.put({
      channel: indexChannel,
      hostId: "host-authority",
      hostGeneration: 7,
      hostSeq: 11,
      revision: 4,
      digest: "digest",
      state: { kind: "session-index", channel: indexChannel, revision: 4, sessions: [] },
      updatedAt: 100,
    })
    setRuntimeSnapshot({
      target: { id: scope.targetId, kind: "companion", platform: "web", hostKind: "desktop" },
      vaultState: "unlocked",
      connectionState: "online",
      host: { compatible: true, operations: ["host_state_submit"], grants: [] },
    })

    const row = await enqueueHostStateIntentIfAvailable({
      actionId: "folder-create",
      clientId: "client-a",
      nowMs: 300,
      action: { kind: "folder.create", folderId: "f1", projectId: "p1", name: "Work" },
    })

    expect(row?.channel).toBe(indexChannel)
    const [action] = (row?.payload as { actions: Array<Record<string, unknown>> }).actions
    expect(action).toMatchObject({ channel: indexChannel, hostId: "host-authority" })
    expect(action).not.toHaveProperty("sessionId")
    // Folder intents are last-writer-wins: no base revision rides along.
    expect(action).not.toHaveProperty("baseRevision")
  })

  it("refuses to address a folder intent to a session, or a session intent to nothing", async () => {
    setRuntimeSnapshot({
      target: { id: scope.targetId, kind: "companion", platform: "web", hostKind: "desktop" },
      vaultState: "unlocked",
      connectionState: "online",
      host: { compatible: true, operations: ["host_state_submit"], grants: [] },
    })
    await expect(
      enqueueHostStateIntentIfAvailable({
        sessionId: "s1",
        action: { kind: "folder.delete", folderId: "f1" },
      })
    ).rejects.toThrow("host_state_index_intent_names_session")
    await expect(
      enqueueHostStateIntentIfAvailable({ action: { kind: "session.pin", pinned: true } })
    ).rejects.toThrow("host_state_session_id_required")
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

describe("HostState rows across Host restarts and draft bursts", () => {
  const channel = sessionStateChannel(scope.targetId, "s-restart")

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

  function hostStateRow(
    id: string,
    clientSeq: number,
    overrides: Partial<MobileOutboundJobRow> & { kind?: "draft.replace" | "turn.abort" } = {}
  ): MobileOutboundJobRow {
    const { kind = "turn.abort", ...rest } = overrides
    const action = {
      channel: rest.channel ?? channel,
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: "host-authority",
      hostGeneration: 3,
      sessionId: "s-restart",
      clientId: rest.clientId ?? "client-a",
      clientSeq,
      actionId: id,
      ...(kind === "draft.replace" ? { baseRevision: 0 } : {}),
      createdAt: 1,
      action:
        kind === "draft.replace"
          ? { kind: "draft.replace" as const, text: id, attachments: [] }
          : { kind: "turn.abort" as const },
    }
    return {
      id,
      accountId: scope.accountId,
      targetId: scope.targetId,
      command: "host_state_submit",
      payload: { accountId: scope.accountId, runtimeTargetId: scope.targetId, actions: [action] },
      status: "pending",
      attempts: 0,
      createdAt: clientSeq,
      nextAttemptAt: 0,
      idempotencyKey: id,
      protocol: "host-state",
      channel: action.channel,
      hostGeneration: 3,
      clientId: action.clientId,
      clientSeq,
      actionId: id,
      ...rest,
    }
  }

  async function confirm(hostGeneration: number, hostId = "host-authority") {
    await getDb().hostStateChannels.put({
      channel,
      hostId,
      hostGeneration,
      hostSeq: 0,
      revision: 0,
      digest: "digest",
      state: createEmptyHostStateSession(scope.targetId, "s-restart"),
      updatedAt: 1,
    })
  }

  const offeredGeneration = (row: MobileOutboundJobRow | undefined) =>
    (row?.payload as { actions: Array<{ hostGeneration: number }> }).actions[0]!.hostGeneration

  describe("offerHostStateRow", () => {
    it("re-stamps a never-offered row onto the generation the same Host published", async () => {
      await getDb().mobileOutboundQueue.put(hostStateRow("a", 1))
      await confirm(5)

      const offer = await offerHostStateRow("a")

      expect(offer?.firstOffer).toBe(true)
      expect(offeredGeneration(offer?.row)).toBe(5)
      const stored = await getDb().mobileOutboundQueue.get("a")
      expect(stored).toMatchObject({ hostGeneration: 5, offeredHostGeneration: 5 })
      expect(offeredGeneration(stored)).toBe(5)
    })

    it("leaves an already-offered row on the generation it was offered under", async () => {
      await getDb().mobileOutboundQueue.put(hostStateRow("a", 1, { offeredHostGeneration: 3 }))
      await confirm(5)

      const offer = await offerHostStateRow("a")

      expect(offer?.firstOffer).toBe(false)
      expect(offeredGeneration(offer?.row)).toBe(3)
    })

    it("does not re-stamp onto another Host, or backwards", async () => {
      await getDb().mobileOutboundQueue.put(hostStateRow("a", 1))
      await confirm(5, "another-host")
      expect(offeredGeneration((await offerHostStateRow("a"))?.row)).toBe(3)

      await getDb().mobileOutboundQueue.put(hostStateRow("b", 2))
      await confirm(2)
      expect(offeredGeneration((await offerHostStateRow("b"))?.row)).toBe(3)
    })

    it("still records the offer when there is nothing to re-base", async () => {
      await getDb().mobileOutboundQueue.put(hostStateRow("a", 1))

      const offer = await offerHostStateRow("a")

      expect(offer?.firstOffer).toBe(true)
      expect(await getDb().mobileOutboundQueue.get("a")).toMatchObject({
        offeredHostGeneration: 3,
      })
    })

    it("answers null for a row that is gone", async () => {
      await expect(offerHostStateRow("missing")).resolves.toBeNull()
    })
  })

  it("forgets the offer on a failure the Host proved unapplied, and on a manual retry", async () => {
    await getDb().mobileOutboundQueue.put(hostStateRow("a", 1, { offeredHostGeneration: 3 }))
    await recordFailure({ id: "a", error: new Error("network"), nowMs: 10, random: () => 0 })
    expect((await getDb().mobileOutboundQueue.get("a"))?.offeredHostGeneration).toBe(3)

    await recordFailure({
      id: "a",
      error: new Error("stale_host_generation"),
      nowMs: 20,
      random: () => 0,
      forgetOffer: true,
    })
    expect(await getDb().mobileOutboundQueue.get("a")).not.toHaveProperty("offeredHostGeneration")

    await getDb().mobileOutboundQueue.update("a", {
      status: "rejected",
      offeredHostGeneration: 3,
      rejectionCode: "stale_host_generation",
    })
    await retryDeadletter("a", 30)
    expect(await getDb().mobileOutboundQueue.get("a")).not.toHaveProperty("offeredHostGeneration")
  })

  describe("supersededHostStateDraftIds", () => {
    it("keeps the latest never-offered draft per conversation and client", () => {
      const rows = [
        hostStateRow("d1", 1, { kind: "draft.replace" }),
        hostStateRow("abort", 2),
        hostStateRow("d3", 3, { kind: "draft.replace" }),
        hostStateRow("d4", 4, { kind: "draft.replace" }),
        hostStateRow("other-client", 1, { kind: "draft.replace", clientId: "client-b" }),
        hostStateRow("other-channel", 1, {
          kind: "draft.replace",
          channel: sessionStateChannel(scope.targetId, "s-elsewhere"),
        }),
      ]
      expect(supersededHostStateDraftIds(rows).sort()).toEqual(["d1", "d3"])
    })

    it("never collapses a draft a Host may hold or one on the wire", () => {
      const rows = [
        hostStateRow("offered", 1, { kind: "draft.replace", offeredHostGeneration: 3 }),
        hostStateRow("sending", 2, { kind: "draft.replace", status: "sending" }),
        hostStateRow("latest", 3, { kind: "draft.replace" }),
      ]
      expect(supersededHostStateDraftIds(rows)).toEqual([])
    })
  })

  it("drops superseded drafts at claim time, for a backlog queued before they were collapsed", async () => {
    await getDb().mobileOutboundQueue.bulkPut([
      hostStateRow("d1", 1, { kind: "draft.replace" }),
      hostStateRow("d2", 2, { kind: "draft.replace" }),
      hostStateRow("d3", 3, { kind: "draft.replace" }),
    ])

    await expect(claimNext(1_000, scope)).resolves.toMatchObject({ id: "d3" })
    expect((await getDb().mobileOutboundQueue.toArray()).map((row) => row.id)).toEqual(["d3"])
  })
})
