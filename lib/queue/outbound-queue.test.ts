/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import {
  enqueue,
  enqueueHostStateAction,
  listByStatus,
  listAll,
} from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import { createOutboundRunner } from "./outbound-queue"
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
  detectNativePlatform: () => "mobile",
}))

describe("createOutboundRunner", () => {
  beforeEach(async () => {
    setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
    // fake-indexeddb resets between test files but not test cases — clear by hand.
    const all = await listAll()
    await Promise.all(all.map((r) => getDb().mobileOutboundQueue.delete(r.id)))
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

  it("retains a stale Host generation as a visible terminal rejection", async () => {
    const call = jest.fn().mockRejectedValue(new Error("stale_host_generation"))
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
      actionId: "stale-action",
      createdAt: Date.now(),
      action: { kind: "turn.abort" },
    })

    await runner.kick()

    expect(await listByStatus("rejected")).toEqual([
      expect.objectContaining({
        actionId: "stale-action",
        rejectionCode: "stale_host_generation",
      }),
    ])
    expect(call).toHaveBeenCalledTimes(1)
    await runner.stop()
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
