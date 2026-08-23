/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  enqueueHostDispatch,
  HOST_DISPATCH_RESULT_REDELIVERY_MS,
} from "@/lib/db/host-dispatch-queue"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { HostDispatchDeliveryError } from "./host-dispatch-delivery"
import { createHostDispatchRunner } from "./host-dispatch-runner"

const NOW = 1_700_000_000_000

describe("createHostDispatchRunner", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().hostDispatchQueue.clear()
  }, 15_000)

  it("atomically delivers a job and schedules safe result redelivery", async () => {
    const row = await enqueueHostDispatch({
      id: "rst-1",
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: {},
      idempotencyKey: "run:step:phone",
      now: NOW,
    })
    const deliver = jest.fn(async () => "awaiting-result" as const)
    const runner = createHostDispatchRunner({ accountId: "acct", now: () => NOW, deliver })
    await runner.kick()
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id, status: "inflight" })
    )
    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      status: "pending",
      nextAttemptAt: NOW + HOST_DISPATCH_RESULT_REDELIVERY_MS,
    })
  })

  it("retries transport failures but terminalizes malformed delivery", async () => {
    const retry = await enqueueHostDispatch({
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: {},
      idempotencyKey: "retry",
      now: NOW,
    })
    const terminal = await enqueueHostDispatch({
      accountId: "acct",
      domain: "remote-step",
      targetRef: "worker",
      kind: "work",
      payload: {},
      idempotencyKey: "terminal",
      now: NOW,
    })
    const runner = createHostDispatchRunner({
      accountId: "acct",
      now: () => NOW,
      deliver: async (job) => {
        if (job.id === retry.id) throw new HostDispatchDeliveryError("offline", true, "offline")
        throw new HostDispatchDeliveryError("unsupported", false, "unsupported")
      },
    })
    await runner.kick()
    await expect(getDb().hostDispatchQueue.get(retry.id)).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
    })
    await expect(getDb().hostDispatchQueue.get(terminal.id)).resolves.toMatchObject({
      status: "failed",
      terminalCode: "unsupported",
    })
  })

  it("terminalizes an expired durable deadline without delivering", async () => {
    const row = await enqueueHostDispatch({
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: {},
      idempotencyKey: "expired",
      now: NOW,
      expiresAt: NOW + 1,
    })
    const deliver = jest.fn().mockResolvedValue("succeeded")
    const runner = createHostDispatchRunner({ accountId: "acct", now: () => NOW + 1, deliver })

    await runner.kick()

    expect(deliver).not.toHaveBeenCalled()
    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      status: "failed",
      terminalCode: "timeout",
    })
  })

  it("coalesces concurrent drains and ignores kicks after shutdown", async () => {
    let release: (() => void) | undefined
    await enqueueHostDispatch({
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: {},
      idempotencyKey: "coalesced",
      now: NOW,
    })
    const deliver = jest.fn(
      () => new Promise<"succeeded">((resolve) => (release = () => resolve("succeeded")))
    )
    const runner = createHostDispatchRunner({ accountId: "acct", now: () => NOW, deliver })

    const first = runner.kick()
    const second = runner.kick()
    expect(first).toBe(second)
    for (let index = 0; index < 20 && !release; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(runner.isDraining()).toBe(true)
    expect(release).toBeDefined()
    release?.()
    await first
    expect(runner.isDraining()).toBe(false)

    await runner.stop()
    await expect(runner.kick()).resolves.toBeUndefined()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("records non-Error delivery failures", async () => {
    const row = await enqueueHostDispatch({
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: {},
      idempotencyKey: "string-error",
      now: NOW,
    })
    const runner = createHostDispatchRunner({
      accountId: "acct",
      now: () => NOW,
      deliver: jest.fn().mockRejectedValue("offline"),
    })

    await runner.kick()

    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      status: "pending",
      lastError: "offline",
    })
  })
})
