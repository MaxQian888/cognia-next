/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import {
  CLAIM_ABANDONED_AFTER_MS,
  enqueue,
  enqueueHostStateAction,
  listByStatus,
  listAll,
} from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import { beginMobileStepReceipt, persistMobileStepResult } from "@/lib/db/mobile-step-receipts"
import {
  DISPATCH_DEADLINE_GRACE_MS,
  createOutboundRunner,
  dispatchDeadlineMs,
  getQueueSummary,
  needsAttention,
  inFlight,
} from "./outbound-queue"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

const scope = { accountId: "acct_queue", targetId: "desktop-studio", routingGeneration: 1 }

// Stub the network subscriber so the runner doesn't try to reach Capacitor.
jest.mock("@/lib/capacitor/network", () => ({
  subscribe: jest.fn(async () => () => {}),
}))

// Stub platform detection so runner enforce-mobile branch is a no-op for tests.
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  detectNativePlatform: () => "mobile",
}))

const settleRejectedHostStateIntentMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/sync/host-state-intent-settlement", () => ({
  settleRejectedHostStateIntent: (...args: unknown[]) => settleRejectedHostStateIntentMock(...args),
}))

describe("createOutboundRunner", () => {
  beforeEach(async () => {
    setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
    // fake-indexeddb resets between test files but not test cases — clear by hand.
    const all = await listAll()
    await Promise.all(all.map((r) => getDb().mobileOutboundQueue.delete(r.id)))
    await getDb().mobileStepReceipts.clear()
  }, 15_000)

  afterEach(() => {
    clearActiveRuntimeTargetContext()
  })

  it("dispatches a pending row and marks it sent", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
    })
    await enqueue({ command: "connector_send", payload: { x: 1 } })
    await runner.kick()
    expect(call).toHaveBeenCalledWith(
      "connector_send",
      { x: 1 },
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )
    const sent = await listByStatus("sent")
    expect(sent).toHaveLength(1)
    await runner.stop()
  })

  it("dispatches legacy Bot retry receipts with the native UUID contract without rewriting their audit identity", async () => {
    const call = jest.fn().mockResolvedValue({ replayed: true })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    const first = await enqueue({
      command: "bot_delivery_replay",
      payload: { deliveryId: "failed-delivery" },
      idempotencyKey: "bot-replay:failed-delivery",
    })
    await enqueue({
      command: "bot_delivery_replay",
      payload: { deliveryId: "failed-delivery" },
      idempotencyKey: "bot-replay:failed-delivery",
    })
    await enqueue({
      command: "bot_trigger_set_armed",
      payload: { installationId: "i", triggerId: "t", armed: true },
      idempotencyKey: "bot-arm:i:t:1",
    })
    await enqueue({
      command: "bot_trigger_set_armed",
      payload: { installationId: "i", triggerId: "t", armed: false },
      idempotencyKey: "bot-arm:i:t:0",
    })
    await enqueue({
      command: "bot_trigger_set_armed",
      payload: { installationId: "i", triggerId: "t", armed: true },
      idempotencyKey: "bot-arm:i:t:1",
    })
    await runner.kick()
    expect((await listByStatus("pending")).map((row) => row.lastError)).toEqual([])
    const keys = call.mock.calls.map((args) => args[2].idempotencyKey as string)
    expect(keys).toHaveLength(5)
    for (const key of keys)
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    const replayKeys = call.mock.calls
      .filter((args) => args[0] === "bot_delivery_replay")
      .map((args) => args[2].idempotencyKey)
    expect(replayKeys[0]).not.toBe(replayKeys[1])
    expect(
      new Set(
        call.mock.calls
          .filter((args) => args[0] === "bot_trigger_set_armed")
          .map((args) => args[2].idempotencyKey)
      ).size
    ).toBe(3)
    expect((await getDb().mobileOutboundQueue.get(first.id))?.idempotencyKey).toBe(
      "bot-replay:failed-delivery"
    )
    expect(await listByStatus("sent")).toHaveLength(5)
    await runner.stop()
  })

  it("passes current UUID and unrelated malformed command keys unchanged", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    const uuid = crypto.randomUUID()
    await enqueue({
      command: "bot_delivery_replay",
      payload: { deliveryId: "d" },
      idempotencyKey: uuid,
    })
    await enqueue({ command: "connector_send", payload: {}, idempotencyKey: "bot-replay:d" })
    await enqueue({
      command: "bot_delivery_replay",
      payload: { deliveryId: "d" },
      idempotencyKey: "malformed",
    })
    await runner.kick()
    expect(call.mock.calls.map((args) => args[2].idempotencyKey).sort()).toEqual(
      [uuid, "bot-replay:d", "malformed"].sort()
    )
    await runner.stop()
  })

  it("ACKs durable mobile-step chunks and immediately erases their sensitive rows", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true, complete: true })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    await beginMobileStepReceipt({
      requestId: "rst-sensitive",
      deviceId: "phone-1",
      kind: "action.mobile.camera",
      timeoutAt: 10_000,
      now: 1,
      accountId: scope.accountId,
      targetId: scope.targetId,
    })
    await persistMobileStepResult(
      "rst-sensitive",
      [{ requestId: "rst-sensitive", seq: 0, total: 1, chunk: '"secret-photo"' }],
      2
    )

    await runner.kick()

    expect(call).toHaveBeenCalledWith(
      "workflow_step_result",
      expect.objectContaining({ requestId: "rst-sensitive", chunk: '"secret-photo"' }),
      { idempotencyKey: "mobile-step-result:rst-sensitive:0" }
    )
    expect(await getDb().mobileOutboundQueue.count()).toBe(0)
    const receipt = await getDb().mobileStepReceipts.get("rst-sensitive")
    expect(receipt?.status).toBe("acknowledged")
    expect(receipt).not.toHaveProperty("resultJson")
    await runner.stop()
  })

  it("retains HostState conflict receipts instead of marking them sent", async () => {
    const call = jest.fn().mockResolvedValue({
      results: [
        {
          actionId: "host-action-1",
          outcome: "conflicted",
          hostGeneration: 1,
          hostSeq: 2,
          rejection: {
            code: "host_state_revision_conflict",
            message: "revision changed",
            currentRevision: 3,
          },
        },
      ],
    })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    await enqueueHostStateAction({
      channel: "cognia://target/desktop-studio/sessions/s1",
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 1,
      sessionId: "s1",
      clientId: "client-a",
      clientSeq: 1,
      actionId: "host-action-1",
      baseRevision: 1,
      createdAt: Date.now(),
      action: { kind: "draft.replace", text: "draft", attachments: [] },
    })

    await runner.kick()

    expect(await listByStatus("sent")).toHaveLength(0)
    expect(await listByStatus("conflicted")).toEqual([
      expect.objectContaining({
        actionId: "host-action-1",
        rejectionCode: "host_state_revision_conflict",
        currentRevision: 3,
      }),
    ])
    await runner.stop()
  })

  it("freezes HostState rows without consuming a retry when rollout disables submit", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      canDispatch: (row) => row.protocol !== "host-state",
    })
    await enqueueHostStateAction({
      channel: "cognia://target/desktop-studio/sessions/s1",
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 1,
      sessionId: "s1",
      clientId: "client-a",
      clientSeq: 1,
      actionId: "frozen-action",
      createdAt: Date.now(),
      action: { kind: "turn.abort" },
    })
    await enqueue({
      id: "legacy-behind-frozen",
      command: "memory_update",
      payload: { text: "legacy compatibility write" },
      accountId: scope.accountId,
      targetId: scope.targetId,
    })

    await runner.kick()

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith(
      "memory_update",
      { text: "legacy compatibility write" },
      expect.any(Object)
    )
    expect(await listByStatus("pending")).toEqual([
      expect.objectContaining({ actionId: "frozen-action", attempts: 0 }),
    ])
    expect(await listByStatus("sent")).toEqual([
      expect.objectContaining({ id: "legacy-behind-frozen" }),
    ])
    await runner.stop()
  })

  describe("a Host that restarted since the row was queued", () => {
    const channel = "cognia://target/desktop-studio/sessions/s1"
    const staleAction = (actionId: string, overrides: Record<string, unknown> = {}) => ({
      channel,
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 3,
      sessionId: "s1",
      clientId: "client-a",
      clientSeq: 1,
      actionId,
      createdAt: Date.now(),
      action: { kind: "turn.abort" as const },
      ...overrides,
    })
    const confirmChannel = (hostGeneration: number, hostId: string = scope.targetId) =>
      getDb().hostStateChannels.put({
        channel,
        hostId,
        hostGeneration,
        hostSeq: 0,
        revision: 0,
        digest: "hs-test",
        state: {} as never,
        updatedAt: Date.now(),
      })
    const appliedReceipt = (actionId: string, hostGeneration: number) => ({
      results: [{ actionId, outcome: "applied", hostGeneration, hostSeq: 1 }],
    })

    beforeEach(async () => {
      await getDb().hostStateChannels.clear()
    })

    it("re-bases a row no Host was ever offered onto the generation the Host published", async () => {
      await confirmChannel(5)
      const call = jest.fn().mockResolvedValue(appliedReceipt("queued-before-restart", 5))
      const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
      await enqueueHostStateAction(staleAction("queued-before-restart"))

      await runner.kick()

      expect(call).toHaveBeenCalledTimes(1)
      const sent = call.mock.calls[0]![1] as { actions: Array<{ hostGeneration: number }> }
      expect(sent.actions[0]!.hostGeneration).toBe(5)
      expect(await listByStatus("sent")).toEqual([
        expect.objectContaining({
          actionId: "queued-before-restart",
          hostGeneration: 5,
          offeredHostGeneration: 5,
        }),
      ])
      await runner.stop()
    })

    it("never re-bases onto a different Host's generation", async () => {
      await confirmChannel(5, "some-other-host")
      const call = jest.fn().mockResolvedValue(appliedReceipt("other-host", 3))
      const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
      await enqueueHostStateAction(staleAction("other-host"))

      await runner.kick()

      const sent = call.mock.calls[0]![1] as { actions: Array<{ hostGeneration: number }> }
      expect(sent.actions[0]!.hostGeneration).toBe(3)
      await runner.stop()
    })

    it("keeps a row that may already be applied on the generation it was offered under", async () => {
      await confirmChannel(5)
      const call = jest.fn().mockRejectedValue(new Error("stale_host_generation"))
      const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
      const row = await enqueueHostStateAction(staleAction("offered-before-restart"))
      // An earlier offer under generation 3 whose answer never came back.
      await getDb().mobileOutboundQueue.update(row.id, { offeredHostGeneration: 3 })

      await runner.kick()

      const sent = call.mock.calls[0]![1] as { actions: Array<{ hostGeneration: number }> }
      expect(sent.actions[0]!.hostGeneration).toBe(3)
      // The Host may hold the earlier offer, so its refusal stands, visibly.
      expect(await listByStatus("rejected")).toEqual([
        expect.objectContaining({
          actionId: "offered-before-restart",
          rejectionCode: "stale_host_generation",
        }),
      ])
      await runner.stop()
    })

    it("returns a first offer refused as stale to the queue and re-bases it once the mirror catches up", async () => {
      let clock = Date.now()
      const call = jest
        .fn()
        .mockRejectedValueOnce(new Error("stale_host_generation"))
        .mockResolvedValueOnce(appliedReceipt("raced-the-resync", 4))
      const runner = createOutboundRunner({
        dispatcher: { call },
        enforceMobile: false,
        scope,
        now: () => clock,
        random: () => 0,
      })
      // Stamped from the runner's frozen clock: a `Date.now()` taken after it
      // can land a few ms later under load, which makes the row not yet due
      // (`nextAttemptAt` is its `createdAt`) and leaves it unclaimed.
      await enqueueHostStateAction(staleAction("raced-the-resync", { createdAt: clock }))

      await runner.kick()

      // Nothing was applied anywhere: not a rejection, a retry with the offer
      // forgotten.
      expect(await listByStatus("rejected")).toHaveLength(0)
      const [pending] = await listByStatus("pending")
      expect(pending).toMatchObject({ actionId: "raced-the-resync", attempts: 1 })
      expect(pending).not.toHaveProperty("offeredHostGeneration")

      await confirmChannel(4)
      clock += 60_000
      await runner.kick()

      expect(call).toHaveBeenCalledTimes(2)
      const resent = call.mock.calls[1]![1] as { actions: Array<{ hostGeneration: number }> }
      expect(resent.actions[0]!.hostGeneration).toBe(4)
      expect(await listByStatus("sent")).toEqual([
        expect.objectContaining({ actionId: "raced-the-resync" }),
      ])
      await runner.stop()
    })
  })

  it("sends only the latest of several drafts no Host has seen", async () => {
    const channel = "cognia://target/desktop-studio/sessions/s1"
    const draft = (actionId: string, clientSeq: number, text: string) => ({
      channel,
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 1,
      sessionId: "s1",
      clientId: "client-a",
      clientSeq,
      actionId,
      baseRevision: 0,
      createdAt: Date.now() - 1_000 + clientSeq,
      action: { kind: "draft.replace" as const, text, attachments: [] },
    })
    const call = jest.fn(async (_command: string, payload: Record<string, unknown>) => {
      const [action] = payload.actions as Array<{ actionId: string }>
      return {
        results: [
          { actionId: action!.actionId, outcome: "applied", hostGeneration: 1, hostSeq: 1 },
        ],
      }
    })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    await enqueueHostStateAction(draft("draft-1", 1, "h"))
    await enqueueHostStateAction(draft("draft-2", 2, "he"))
    await enqueueHostStateAction({
      ...draft("abort", 3, ""),
      action: { kind: "turn.abort" },
      baseRevision: undefined,
    })
    await enqueueHostStateAction(draft("draft-4", 4, "hello"))

    await runner.kick()

    const sentIds = call.mock.calls.map(
      ([, payload]) => (payload.actions as Array<{ actionId: string }>)[0]!.actionId
    )
    expect(sentIds).toEqual(["abort", "draft-4"])
    expect((await listAll()).map((row) => row.actionId).sort()).toEqual(["abort", "draft-4"])
    await runner.stop()
  })

  describe("refused list intents", () => {
    const folderAction = (actionId: string) => ({
      channel: "cognia://target/desktop-studio/sessions",
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 1,
      clientId: "client-a",
      clientSeq: 1,
      actionId,
      createdAt: Date.now(),
      action: { kind: "folder.create" as const, folderId: "f1", projectId: "p1", name: "Work" },
    })

    beforeEach(() => settleRejectedHostStateIntentMock.mockClear())

    it("settles an intent a Host too old to know it refused, without retrying", async () => {
      const call = jest.fn().mockRejectedValue(new Error("host_state_invalid_submit_request"))
      const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
      await enqueueHostStateAction(folderAction("old-host"))

      await runner.kick()

      expect(await listByStatus("rejected")).toEqual([
        expect.objectContaining({
          actionId: "old-host",
          rejectionCode: "host_state_invalid_submit_request",
        }),
      ])
      expect(call).toHaveBeenCalledTimes(1)
      expect(settleRejectedHostStateIntentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "old-host",
          action: expect.objectContaining({ kind: "folder.create" }),
        }),
        "host_state_invalid_submit_request"
      )
      await runner.stop()
    })

    it("settles a receipt the Host refused, and leaves an applied one alone", async () => {
      const call = jest
        .fn()
        .mockResolvedValueOnce({
          results: [
            {
              actionId: "refused",
              outcome: "rejected",
              hostGeneration: 1,
              hostSeq: 1,
              rejection: { code: "host_state_forbidden", message: "no" },
            },
          ],
        })
        .mockResolvedValueOnce({
          results: [{ actionId: "applied", outcome: "applied", hostGeneration: 1, hostSeq: 2 }],
        })
      const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
      await enqueueHostStateAction(folderAction("refused"))
      await enqueueHostStateAction({ ...folderAction("applied"), clientSeq: 2 })

      await runner.kick()

      expect(settleRejectedHostStateIntentMock).toHaveBeenCalledTimes(1)
      expect(settleRejectedHostStateIntentMock).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "refused" }),
        "host_state_forbidden"
      )
      await runner.stop()
    })
  })

  it("schedules retry on retryable failure", async () => {
    const call = jest.fn().mockRejectedValue(new Error("503 service unavailable"))
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      now: () => 1_000,
      scope,
      random: () => 0,
    })
    // Match the runner's mocked now() so claimNext picks the row up.
    await enqueue({ command: "connector_send", payload: {}, nowMs: 0 })
    await runner.kick()
    const pending = await listByStatus("pending")
    expect(pending).toHaveLength(1)
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].nextAttemptAt).toBe(2_000)
    await runner.stop()
  })

  it("never dispatches a row that belongs to another runtime target", async () => {
    const call = jest.fn().mockResolvedValue(null)
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
    })
    await enqueue({
      command: "connector_send",
      payload: { target: "other" },
      accountId: scope.accountId,
      targetId: "desktop-other",
    })

    await runner.kick()

    expect(call).not.toHaveBeenCalled()
    expect(
      await listByStatus("pending", {
        ...scope,
        targetId: "desktop-other",
      })
    ).toHaveLength(1)
    await runner.stop()
  })

  it("keeps pending, sending, and dead-letter rows isolated by Host and resumes A only on A", async () => {
    const statuses = ["pending", "sending", "deadlettered"] as const
    for (const targetId of ["host-a", "host-b"]) {
      for (const status of statuses) {
        await getDb().mobileOutboundQueue.put({
          id: `${targetId}-${status}`,
          accountId: scope.accountId,
          targetId,
          command: "connector_send",
          payload: { targetId, status },
          status,
          createdAt: status === "pending" ? 1 : 2,
          nextAttemptAt: status === "pending" ? 0 : 10_000,
          attempts: 0,
          idempotencyKey: `${targetId}-${status}-key`,
        })
      }
    }
    const callB = jest.fn().mockResolvedValue(undefined)
    const runnerB = createOutboundRunner({
      dispatcher: { call: callB },
      enforceMobile: false,
      scope: { ...scope, targetId: "host-b" },
      now: () => 100,
    })
    await runnerB.kick()
    expect(callB).toHaveBeenCalledTimes(1)
    expect((await getDb().mobileOutboundQueue.get("host-a-pending"))?.status).toBe("pending")

    const callA = jest.fn().mockResolvedValue(undefined)
    const runnerA = createOutboundRunner({
      dispatcher: { call: callA },
      enforceMobile: false,
      scope: { ...scope, targetId: "host-a" },
      now: () => 100,
    })
    await runnerA.kick()
    expect(callA).toHaveBeenCalledTimes(1)
    expect((await getDb().mobileOutboundQueue.get("host-a-pending"))?.status).toBe("sent")
    // Reclaimed, not dispatched: the row carries no `claimedAt`, so no live
    // dispatcher owns it and `releaseStaleClaims` frees the channel head it was
    // holding. Its backoff (`nextAttemptAt: 10_000`) keeps it out of this drain.
    expect((await getDb().mobileOutboundQueue.get("host-a-sending"))?.status).toBe("pending")
    expect((await getDb().mobileOutboundQueue.get("host-a-deadlettered"))?.status).toBe(
      "deadlettered"
    )
    // Host B's row is untouched by Host A's reclaim — the sweep is scoped.
    expect((await getDb().mobileOutboundQueue.get("host-b-deadlettered"))?.status).toBe(
      "deadlettered"
    )
    await Promise.all([runnerA.stop(), runnerB.stop()])
  })

  it("deadletters non-retryable failures immediately", async () => {
    const call = jest.fn().mockRejectedValue(new Error("401 unauthorized"))
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
    })
    await enqueue({ command: "connector_send", payload: {} })
    await runner.kick()
    const dead = await listByStatus("deadlettered")
    expect(dead).toHaveLength(1)
    expect(dead[0].lastError).toContain("401")
    await runner.stop()
  })

  it("respects nextAttemptAt — does not dispatch rows scheduled for the future", async () => {
    const call = jest.fn().mockResolvedValue(null)
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      now: () => 1_000,
      scope,
    })
    await getDb().mobileOutboundQueue.put({
      id: "future",
      command: "connector_send",
      payload: {},
      status: "pending",
      attempts: 0,
      createdAt: 0,
      nextAttemptAt: 5_000, // in the future
      idempotencyKey: "k",
      ...scope,
    })
    await runner.kick()
    expect(call).not.toHaveBeenCalled()
    await runner.stop()
  })

  it("drains multiple ready rows in a single kick", async () => {
    const call = jest.fn().mockResolvedValue(null)
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
    })
    await enqueue({ command: "connector_send", payload: { i: 1 } })
    await enqueue({ command: "connector_send", payload: { i: 2 } })
    await enqueue({ command: "connector_send", payload: { i: 3 } })
    await runner.kick()
    expect(call).toHaveBeenCalledTimes(3)
    await runner.stop()
  })

  it("counts recoverable and terminal outbox states without treating them as sent", async () => {
    for (const status of [
      "pending",
      "sending",
      "deadlettered",
      "rejected",
      "conflicted",
    ] as const) {
      const row = await enqueue({ command: "connector_send", payload: {} })
      await getDb().mobileOutboundQueue.update(row.id, { status })
    }
    const summary = await getQueueSummary()
    expect(summary).toEqual({ pending: 1, sending: 1, deadlettered: 1, rejected: 1, conflicted: 1 })
    expect(needsAttention(summary)).toBe(3)
    expect(inFlight(summary)).toBe(2)
  })

  it.each([
    [null, {}, "malformed acknowledgement"],
    [{ ok: false, reason: "closed" }, {}, "rejected: closed"],
    [{ ok: true }, { requestId: 7, seq: 0 }, "payload is malformed"],
  ])("does not ACK malformed mobile result receipts %j", async (response, payload, expected) => {
    const runner = createOutboundRunner({
      dispatcher: { call: async () => response },
      enforceMobile: false,
      scope,
    })
    const row = await enqueue({
      command: "workflow_step_result",
      payload: payload as Record<string, unknown>,
    })
    await runner.kick()
    expect((await getDb().mobileOutboundQueue.get(row.id))?.lastError).toContain(expected)
    await runner.stop()
  })

  it("keeps collaboration conflicts actionable and preserves the server revision", async () => {
    const conflict = Object.assign(new Error("revision conflict"), {
      status: 409,
      authoritative: { revision: 2 },
    })
    const runner = createOutboundRunner({
      dispatcher: {
        call: async () => {
          throw conflict
        },
      },
      enforceMobile: false,
      scope,
    })
    const row = await enqueue({
      command: "collab_issue_patch",
      payload: {},
      protocol: "collab-v1",
    })
    await runner.kick()
    expect((await getDb().mobileOutboundQueue.get(row.id))?.status).toBe("conflicted")
    await runner.stop()
  })

  it("files the clashing fields of a field-level conflict with the row", async () => {
    const fields = { title: { yours: "a", theirs: "b", changedAt: 4, changedBy: null } }
    const conflict = Object.assign(new Error("field conflict"), {
      status: 409,
      authoritative: { revision: 4 },
      fields,
    })
    const runner = createOutboundRunner({
      dispatcher: {
        call: async () => {
          throw conflict
        },
      },
      enforceMobile: false,
      scope,
    })
    const row = await enqueue({
      command: "collab_issue_patch",
      payload: {},
      protocol: "collab-v1",
    })
    await runner.kick()
    expect(await getDb().mobileOutboundQueue.get(row.id)).toMatchObject({
      status: "conflicted",
      conflictFields: fields,
    })
    await runner.stop()
  })

  it.each([
    [{ results: [] }, "host_state_malformed_response"],
    [
      { results: [{ actionId: "wrong", outcome: "applied", hostGeneration: 1, hostSeq: 1 }] },
      "host_state_malformed_response",
    ],
  ])("refuses an unmatched HostState receipt %j", async (response, expected) => {
    const runner = createOutboundRunner({
      dispatcher: { call: async () => response },
      enforceMobile: false,
      scope,
    })
    const row = await enqueue({
      command: "host_state_submit",
      payload: {},
      protocol: "host-state",
      actionId: "expected",
    })
    await runner.kick()
    expect((await getDb().mobileOutboundQueue.get(row.id))?.lastError).toBe(expected)
    await runner.stop()
  })

  it("accepts exact HostState success and coded terminal errors", async () => {
    const call = jest
      .fn()
      .mockResolvedValueOnce({
        results: [{ actionId: "a", outcome: "applied", hostGeneration: 1, hostSeq: 1 }],
      })
      .mockRejectedValueOnce({ code: "upgrade_required" })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    const first = await enqueue({
      command: "host_state_submit",
      payload: {},
      protocol: "host-state",
      actionId: "a",
      nowMs: 1,
    })
    const second = await enqueue({
      command: "host_state_submit",
      payload: {},
      protocol: "host-state",
      actionId: "b",
      nowMs: 2,
    })
    await runner.kick()
    expect((await getDb().mobileOutboundQueue.get(first.id))?.status).toBe("sent")
    expect((await getDb().mobileOutboundQueue.get(second.id))?.status).toBe("rejected")
    await runner.stop()
  })

  it("cancels a delayed network subscription and makes repeated stop safe", async () => {
    const network = jest.requireMock("@/lib/capacitor/network") as { subscribe: jest.Mock }
    let finish!: (unsubscribe: () => void) => void
    network.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const runner = createOutboundRunner({
      dispatcher: { call: jest.fn() },
      enforceMobile: false,
      scope,
    })
    await runner.stop()
    const unsubscribe = jest.fn(() => {
      throw new Error("already removed")
    })
    finish(unsubscribe)
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await runner.stop()
  })

  it("responds to online events and stops cleanly when listener cleanup throws", async () => {
    const network = jest.requireMock("@/lib/capacitor/network") as { subscribe: jest.Mock }
    let notify!: (state: { connected: boolean }) => void
    network.subscribe.mockImplementationOnce(async (callback) => {
      notify = callback
      return () => {
        throw new Error("gone")
      }
    })
    const call = jest.fn().mockResolvedValue(null)
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    await enqueue({ command: "connector_send", payload: {} })
    notify({ connected: false })
    expect(call).not.toHaveBeenCalled()
    notify({ connected: true })
    await runner.kick()
    expect(call).toHaveBeenCalledTimes(1)
    await runner.quiesce()
    await runner.quiesce()
    notify({ connected: true })
    await runner.stop()
  })

  it("kick() returns immediately on non-mobile platforms when enforceMobile=true", async () => {
    jest.resetModules()
    jest.doMock("@/lib/capacitor/_shared", () => ({
      detectNativePlatform: () => "web",
    }))
    jest.doMock("@/lib/capacitor/network", () => ({
      subscribe: jest.fn(async () => () => {}),
    }))
    const { createOutboundRunner: factory } = await import("./outbound-queue")
    const call = jest.fn()
    const runner = factory({ dispatcher: { call }, enforceMobile: true, scope })
    await enqueue({ command: "connector_send", payload: {} })
    await runner.kick()
    expect(call).not.toHaveBeenCalled()
    await runner.stop()
    jest.dontMock("@/lib/capacitor/_shared")
    jest.dontMock("@/lib/capacitor/network")
  })

  it("isDraining flips while dispatch is in flight", async () => {
    let resolve: ((v: unknown) => void) | null = null
    const call = jest.fn(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
    })
    await enqueue({ command: "connector_send", payload: {} })
    const p = runner.kick()
    // Wait for `dispatcher.call` to be reached (Dexie txn settles in a few
    // microtasks). Give up after 50 ticks so a real bug doesn't hang.
    for (let i = 0; i < 50 && resolve === null; i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(resolve).not.toBeNull()
    expect(runner.isDraining()).toBe(true)
    resolve!(null)
    await p
    expect(runner.isDraining()).toBe(false)
    await runner.stop()
  })

  it("quiesce waits for an in-flight completion write and rejects later kicks", async () => {
    let resolveDispatch: ((value: unknown) => void) | null = null
    const call = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve
        })
    )
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
    })
    await enqueue({ command: "connector_send", payload: { host: "a" } })
    const draining = runner.kick()
    for (let i = 0; i < 50 && resolveDispatch === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    let quiesced = false
    const quiescing = runner.quiesce().then(() => {
      quiesced = true
    })
    await Promise.resolve()
    expect(quiesced).toBe(false)

    resolveDispatch!(null)
    await Promise.all([draining, quiescing])
    expect(quiesced).toBe(true)
    expect(await listByStatus("sent")).toHaveLength(1)

    await enqueue({ command: "connector_send", payload: { host: "a-late" } })
    await runner.kick()
    expect(call).toHaveBeenCalledTimes(1)
  })
})

/** Resolve after `ms` of real time; the runner's deadlines use real timers. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `check` holds, or give up after `timeoutMs` so a bug cannot hang. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time")
    await sleep(10)
  }
}

describe("outbound runner liveness", () => {
  beforeEach(async () => {
    setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
    const all = await listAll()
    await Promise.all(all.map((r) => getDb().mobileOutboundQueue.delete(r.id)))
  }, 15_000)

  afterEach(() => {
    clearActiveRuntimeTargetContext()
  })

  it("bounds a dispatch by its command's transport deadline plus grace", () => {
    expect(dispatchDeadlineMs("workflow_trigger_manual")).toBe(30_000 + DISPATCH_DEADLINE_GRACE_MS)
    expect(dispatchDeadlineMs("video_trim")).toBe(1_260_000 + DISPATCH_DEADLINE_GRACE_MS)
  })

  /**
   * The restart symptom: a dispatch whose promise never settled held its row
   * `sending` and parked the drain behind it for the life of the app.
   */
  it("gives up on a dispatch that never answers and schedules a retry", async () => {
    const call = jest.fn(() => new Promise<never>(() => undefined))
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      dispatchDeadlineMs: () => 30,
    })
    const row = await enqueue({ command: "workflow_trigger_manual", payload: { workflowId: "w" } })

    await runner.kick()

    const after = await getDb().mobileOutboundQueue.get(row.id)
    expect(after).toMatchObject({ status: "pending", attempts: 1 })
    expect(after?.lastError).toMatch(/got no answer/)
    expect(runner.isDraining()).toBe(false)
    await runner.stop()
  })

  it("treats a pre-flight gate that never answers, or throws, as not now", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const hung = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      canDispatch: () => new Promise<boolean>(() => undefined),
      preflightDeadlineMs: 30,
    })
    const row = await enqueue({ command: "connector_send", payload: {} })
    await hung.kick()
    expect(call).not.toHaveBeenCalled()
    expect(await getDb().mobileOutboundQueue.get(row.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    })
    await hung.stop()

    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const throwing = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      canDispatch: () => {
        throw new Error("gate exploded")
      },
    })
    await throwing.kick()
    expect(call).not.toHaveBeenCalled()
    expect((await getDb().mobileOutboundQueue.get(row.id))?.status).toBe("pending")
    warn.mockRestore()
    await throwing.stop()
  })

  /**
   * The gate's refusal is released back to `pending`, and that write is what
   * the pending-jobs subscription kicks on. Without a hold, every kick
   * re-claimed and re-released the row in a tight loop.
   */
  it("holds a refused row out of later drains until thawed", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    let allow = false
    const canDispatch = jest.fn(() => allow)
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      canDispatch,
    })
    await enqueue({ command: "connector_send", payload: {} })

    await runner.kick()
    await runner.kick()
    await runner.kick()
    expect(canDispatch).toHaveBeenCalledTimes(1)

    allow = true
    await runner.kick({ thaw: true })
    expect(canDispatch).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenCalledTimes(1)
    expect(await listByStatus("sent")).toHaveLength(1)
    await runner.stop()
  })

  it("asks about a refused row again by itself once its hold lapses", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    let allow = false
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      canDispatch: () => allow,
      frozenRecheckMs: 40,
    })
    await enqueue({ command: "connector_send", payload: {} })
    await runner.kick()
    expect(call).not.toHaveBeenCalled()

    allow = true
    await waitUntil(async () => (await listByStatus("sent")).length === 1)
    expect(call).toHaveBeenCalledTimes(1)
    await runner.stop()
  })

  /**
   * A claim left by a process killed moments before a restart is still young
   * at the first drain. It used to be reclaimed on that first drain or never.
   */
  it("reclaims an abandoned claim on any drain, not only the first", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    let clock = 10_000
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      now: () => clock,
    })
    await runner.kick()
    await getDb().mobileOutboundQueue.put({
      id: "left-behind",
      accountId: scope.accountId,
      targetId: scope.targetId,
      command: "workflow_trigger_manual",
      payload: { workflowId: "w" },
      status: "sending",
      attempts: 0,
      createdAt: 9_000,
      nextAttemptAt: 9_000,
      claimedAt: 9_500,
      idempotencyKey: "left-behind-key",
    })

    await runner.kick()
    expect(call).not.toHaveBeenCalled()
    expect((await getDb().mobileOutboundQueue.get("left-behind"))?.status).toBe("sending")

    clock = 9_500 + CLAIM_ABANDONED_AFTER_MS
    await runner.kick()
    expect(call).toHaveBeenCalledWith(
      "workflow_trigger_manual",
      { workflowId: "w" },
      expect.objectContaining({ idempotencyKey: "left-behind-key" })
    )
    expect((await getDb().mobileOutboundQueue.get("left-behind"))?.status).toBe("sent")
    await runner.stop()
  })

  it("renews its claim for as long as a dispatch is running", async () => {
    let clock = 1_000
    let finish: ((value: unknown) => void) | null = null
    const call = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      scope,
      now: () => clock,
      claimRenewIntervalMs: 15,
    })
    const row = await enqueue({ command: "connector_send", payload: {}, nowMs: 1_000 })
    const draining = runner.kick()
    await waitUntil(async () => finish !== null)
    clock = 5_000
    await waitUntil(
      async () => (await getDb().mobileOutboundQueue.get(row.id))?.claimedAt === 5_000
    )
    finish!({ ok: true })
    await draining
    expect((await getDb().mobileOutboundQueue.get(row.id))?.status).toBe("sent")
    await runner.stop()
  })

  it("wakes itself when a backed-off row becomes due, with no other event", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    const row = await enqueue({ command: "connector_send", payload: {} })
    await getDb().mobileOutboundQueue.update(row.id, { nextAttemptAt: Date.now() + 60 })

    await runner.kick()
    expect(call).not.toHaveBeenCalled()

    await waitUntil(async () => (await getDb().mobileOutboundQueue.get(row.id))?.status === "sent")
    expect(call).toHaveBeenCalledTimes(1)
    await runner.stop()
  })

  it("arms no wake-up once stopped", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const runner = createOutboundRunner({ dispatcher: { call }, enforceMobile: false, scope })
    const row = await enqueue({ command: "connector_send", payload: {} })
    await getDb().mobileOutboundQueue.update(row.id, { nextAttemptAt: Date.now() + 40 })
    await runner.kick()
    await runner.stop()
    await sleep(120)
    expect(call).not.toHaveBeenCalled()
  })
})
