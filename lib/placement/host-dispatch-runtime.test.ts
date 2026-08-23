/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import Dexie from "dexie"

import {
  completeHostDispatch,
  enqueueHostDispatch,
  HOST_DISPATCH_TERMINAL_RETENTION_MS,
} from "@/lib/db/host-dispatch-queue"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetHostDispatchDeliveriesForTesting,
  HostDispatchDeliveryError,
  registerHostDispatchDelivery,
} from "./host-dispatch-delivery"
import { installHostDispatchRuntime } from "./host-dispatch-runtime"

describe("installHostDispatchRuntime", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().hostDispatchQueue.clear()
    __resetHostDispatchDeliveriesForTesting()
  }, 15_000)

  afterEach(() => {
    jest.useRealTimers()
    __resetHostDispatchDeliveriesForTesting()
  })

  it("drains a pending mobile step on bootstrap without waiting for a new workflow call", async () => {
    const request = {
      requestId: "rst-restart",
      targetDeviceId: "phone",
      kind: "action.mobile.location",
      params: {},
      runId: "run",
      stepId: "step",
      workflowId: "wf",
      issuedAt: Date.now(),
      timeoutAt: Date.now() + 60_000,
    }
    await enqueueHostDispatch({
      id: request.requestId,
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: request.kind,
      payload: request,
      idempotencyKey: "stable",
    })
    const emit = jest.fn(async () => undefined)

    const runtime = installHostDispatchRuntime({ accountId: "acct", emit })
    for (let index = 0; index < 100 && emit.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(emit).toHaveBeenCalledWith("workflow://step-execute", request)
    await expect(getDb().hostDispatchQueue.get(request.requestId)).resolves.toMatchObject({
      status: "pending",
    })
    await runtime.stop()
  })

  it("wakes at the next retry time without unrelated database activity", async () => {
    let now = 1_700_000_000_000
    let wake: (() => void) | undefined
    const scheduleWake = jest.fn((callback: () => void) => {
      wake = callback
      return 1 as unknown as ReturnType<typeof setTimeout>
    })
    const cancelWake = jest.fn()
    const delivery = jest
      .fn()
      .mockRejectedValueOnce(new HostDispatchDeliveryError("offline", true, "offline"))
      .mockResolvedValueOnce("succeeded")
    const unregister = registerHostDispatchDelivery("schedule-handoff", delivery)
    const row = await enqueueHostDispatch({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "cloud-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "retry-wake",
      now,
    })
    const runtime = installHostDispatchRuntime({
      accountId: "acct",
      now: () => now,
      scheduleWake,
      cancelWake,
    })

    let retry = await getDb().hostDispatchQueue.get(row.id)
    for (
      let index = 0;
      index < 50 && !(retry?.status === "pending" && retry.attempts === 1);
      index += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      retry = await getDb().hostDispatchQueue.get(row.id)
    }
    expect(retry).toMatchObject({ status: "pending", attempts: 1 })
    for (
      let index = 0;
      index < 20 && !scheduleWake.mock.calls.some((call) => call[1] === 2_000);
      index += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(scheduleWake).toHaveBeenCalledWith(expect.any(Function), 2_000)

    now = retry!.nextAttemptAt
    wake?.()
    for (let index = 0; index < 20 && delivery.mock.calls.length < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(delivery).toHaveBeenCalledTimes(2)
    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      status: "succeeded",
    })
    await runtime.stop()
    unregister()
  })

  it("wakes when an in-flight lease expires so a crashed claim is recovered", async () => {
    let now = 1_700_000_000_000
    let wake: (() => void) | undefined
    const scheduleWake = jest.fn((callback: () => void) => {
      wake = callback
      return 9 as unknown as ReturnType<typeof setTimeout>
    })
    const delivery = jest.fn().mockResolvedValue("succeeded")
    const unregister = registerHostDispatchDelivery("schedule-handoff", delivery)
    const row = await enqueueHostDispatch({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "cloud-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "expired-lease-wake",
      now,
    })
    await getDb().hostDispatchQueue.update(row.id, {
      status: "inflight",
      leaseOwner: "crashed-runner",
      leaseExpiresAt: now + 4_000,
    })

    const runtime = installHostDispatchRuntime({
      accountId: "acct",
      now: () => now,
      scheduleWake,
      cancelWake: jest.fn(),
    })
    for (let index = 0; index < 20 && scheduleWake.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(scheduleWake).toHaveBeenCalledWith(expect.any(Function), 4_000)

    now += 4_000
    wake?.()
    for (let index = 0; index < 20 && delivery.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(delivery).toHaveBeenCalledTimes(1)
    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      status: "succeeded",
    })
    await runtime.stop()
    unregister()
  })

  it("cancels an armed wake on idempotent shutdown and ignores its stale callback", async () => {
    const now = 1_700_000_000_000
    let wake: (() => void) | undefined
    const scheduleWake = jest.fn((callback: () => void) => {
      wake = callback
      return 7 as unknown as ReturnType<typeof setTimeout>
    })
    const cancelWake = jest.fn()
    const delivery = jest.fn().mockResolvedValue("succeeded")
    const unregister = registerHostDispatchDelivery("schedule-handoff", delivery)
    const row = await enqueueHostDispatch({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "cloud-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "shutdown-wake",
      now,
    })
    await getDb().hostDispatchQueue.update(row.id, { nextAttemptAt: now + 5_000 })

    const runtime = installHostDispatchRuntime({
      accountId: "acct",
      now: () => now,
      scheduleWake,
      cancelWake,
    })
    for (let index = 0; index < 20 && scheduleWake.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(scheduleWake).toHaveBeenCalledWith(expect.any(Function), 5_000)

    await runtime.kick()
    expect(delivery).not.toHaveBeenCalled()
    await runtime.stop()
    await runtime.stop()
    wake?.()
    await Promise.resolve()

    expect(cancelWake).toHaveBeenCalledWith(7)
    expect(delivery).not.toHaveBeenCalled()
    unregister()
  })

  it("kicks immediately for a due row and contains subscription failures", async () => {
    const unsubscribe = jest.fn()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const liveQuery = jest.spyOn(Dexie, "liveQuery").mockReturnValue({
      subscribe(observer: { next: (value: number) => void; error: (error: unknown) => void }) {
        observer.next(100)
        observer.error("indexeddb closed")
        return { unsubscribe }
      },
    } as never)

    const runtime = installHostDispatchRuntime({ accountId: "acct", now: () => 100 })
    await runtime.stop()

    expect(warn).toHaveBeenCalledWith(
      "host-dispatch-runtime: queue subscription failed",
      "indexeddb closed"
    )
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    liveQuery.mockRestore()
    warn.mockRestore()
  })

  it("contains drain failures and schedules a bounded retry", async () => {
    const now = 1_700_000_000_000
    let wake: (() => void) | undefined
    const scheduleWake = jest.fn((callback: () => void) => {
      wake = callback
      return 11 as unknown as ReturnType<typeof setTimeout>
    })
    const runner = {
      kick: jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error("indexeddb unavailable"))
        .mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      isDraining: jest.fn(() => false),
    }
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)

    const runtime = installHostDispatchRuntime({
      accountId: "acct",
      now: () => now,
      scheduleWake,
      cancelWake: jest.fn(),
      runner,
    })
    for (let index = 0; index < 20 && scheduleWake.mock.calls.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(warn).toHaveBeenCalledWith(
      "host-dispatch-runtime: queue drain failed",
      expect.any(Error)
    )
    expect(scheduleWake).toHaveBeenCalledWith(expect.any(Function), 2_000)
    wake?.()
    await Promise.resolve()
    expect(runner.kick).toHaveBeenCalledTimes(2)

    await runtime.stop()
    warn.mockRestore()
  })

  it("prunes stale terminal payloads in the Host runtime", async () => {
    const now = 1_700_000_000_000
    const staleAt = now - HOST_DISPATCH_TERMINAL_RETENTION_MS
    const row = await enqueueHostDispatch({
      id: "stale-terminal",
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: { image: "sensitive" },
      idempotencyKey: "stale-terminal",
      now: staleAt,
    })
    await completeHostDispatch(row.id, staleAt)
    const runner = {
      kick: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      isDraining: jest.fn(() => false),
    }

    const runtime = installHostDispatchRuntime({ accountId: "acct", now: () => now, runner })
    for (let index = 0; index < 20 && (await getDb().hostDispatchQueue.get(row.id)); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toBeUndefined()
    await runtime.stop()
  })

  it("replaces an obsolete wake and ignores an inflight row without a lease", async () => {
    const cancelWake = jest.fn()
    const scheduleWake = jest
      .fn()
      .mockReturnValueOnce(21 as unknown as ReturnType<typeof setTimeout>)
      .mockReturnValueOnce(22 as unknown as ReturnType<typeof setTimeout>)
    const runner = {
      kick: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      isDraining: jest.fn(() => false),
    }
    const unsubscribe = jest.fn()
    const liveQuery = jest.spyOn(Dexie, "liveQuery").mockReturnValue({
      subscribe(observer: { next: (value: number | undefined) => void }) {
        observer.next(200)
        observer.next(300)
        return { unsubscribe }
      },
    } as never)

    const runtime = installHostDispatchRuntime({
      accountId: "acct",
      now: () => 100,
      scheduleWake,
      cancelWake,
      runner,
    })

    expect(cancelWake).toHaveBeenCalledWith(21)
    await runtime.stop()
    expect(cancelWake).toHaveBeenCalledWith(22)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    liveQuery.mockRestore()

    const row = await enqueueHostDispatch({
      id: "lease-less",
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "cloud-a",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "lease-less",
      now: 100,
    })
    await getDb().hostDispatchQueue.update(row.id, {
      status: "inflight",
      leaseExpiresAt: undefined,
    })
    scheduleWake.mockClear()
    cancelWake.mockClear()

    const leaseLessRuntime = installHostDispatchRuntime({
      accountId: "acct",
      now: () => 100,
      scheduleWake,
      cancelWake,
      runner,
    })
    for (let index = 0; index < 10; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(scheduleWake).not.toHaveBeenCalled()
    await leaseLessRuntime.stop()
  })
})
