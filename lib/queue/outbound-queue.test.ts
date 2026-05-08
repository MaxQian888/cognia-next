/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { enqueue, listByStatus, listAll } from "@/lib/db/mobile-outbound-queue"
import { createOutboundRunner } from "./outbound-queue"

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
    // fake-indexeddb resets between test files but not test cases — clear by hand.
    const all = await listAll()
    const { getDb } = await import("@/lib/db/schema")
    await Promise.all(all.map((r) => getDb().mobileOutboundQueue.delete(r.id)))
  })

  it("dispatches a pending row and marks it sent", async () => {
    const call = jest.fn().mockResolvedValue({ ok: true })
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
    })
    await enqueue({ command: "rpc_generic", payload: { x: 1 } })
    await runner.kick()
    expect(call).toHaveBeenCalledWith(
      "rpc_generic",
      { x: 1 },
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    )
    const sent = await listByStatus("sent")
    expect(sent).toHaveLength(1)
    runner.stop()
  })

  it("schedules retry on retryable failure", async () => {
    const call = jest.fn().mockRejectedValue(new Error("503 service unavailable"))
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      now: () => 1_000,
      random: () => 0,
    })
    // Match the runner's mocked now() so claimNext picks the row up.
    await enqueue({ command: "rpc_generic", payload: {}, nowMs: 0 })
    await runner.kick()
    const pending = await listByStatus("pending")
    expect(pending).toHaveLength(1)
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].nextAttemptAt).toBe(2_000)
    runner.stop()
  })

  it("deadletters non-retryable failures immediately", async () => {
    const call = jest.fn().mockRejectedValue(new Error("401 unauthorized"))
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
    })
    await enqueue({ command: "rpc_generic", payload: {} })
    await runner.kick()
    const dead = await listByStatus("deadlettered")
    expect(dead).toHaveLength(1)
    expect(dead[0].lastError).toContain("401")
    runner.stop()
  })

  it("respects nextAttemptAt — does not dispatch rows scheduled for the future", async () => {
    const call = jest.fn().mockResolvedValue(null)
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
      now: () => 1_000,
    })
    const { getDb } = await import("@/lib/db/schema")
    await getDb().mobileOutboundQueue.put({
      id: "future",
      command: "rpc_generic",
      payload: {},
      status: "pending",
      attempts: 0,
      createdAt: 0,
      nextAttemptAt: 5_000, // in the future
      idempotencyKey: "k",
    })
    await runner.kick()
    expect(call).not.toHaveBeenCalled()
    runner.stop()
  })

  it("drains multiple ready rows in a single kick", async () => {
    const call = jest.fn().mockResolvedValue(null)
    const runner = createOutboundRunner({
      dispatcher: { call },
      enforceMobile: false,
    })
    await enqueue({ command: "rpc_generic", payload: { i: 1 } })
    await enqueue({ command: "rpc_generic", payload: { i: 2 } })
    await enqueue({ command: "rpc_generic", payload: { i: 3 } })
    await runner.kick()
    expect(call).toHaveBeenCalledTimes(3)
    runner.stop()
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
    const runner = factory({ dispatcher: { call }, enforceMobile: true })
    await enqueue({ command: "rpc_generic", payload: {} })
    await runner.kick()
    expect(call).not.toHaveBeenCalled()
    runner.stop()
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
    })
    await enqueue({ command: "rpc_generic", payload: {} })
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
    runner.stop()
  })
})
