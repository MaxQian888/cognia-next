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
    const auditFailure = jest.fn().mockResolvedValue(undefined)
    const runner = createHostDispatchRunner({
      accountId: "acct",
      now: () => NOW,
      auditFailure,
      deliver: async (job) => {
        if (job.id === retry.id) throw new HostDispatchDeliveryError("offline", true, "offline")
        throw new HostDispatchDeliveryError("unsupported", false, "unsupported")
      },
    })
    await runner.kick()
    // The retryable failure still has attempts left, so nobody is paged for it;
    // only the non-retryable refusal is terminal and audited.
    expect(auditFailure).toHaveBeenCalledTimes(1)
    expect(auditFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: terminal.id }),
      expect.objectContaining({ kind: "failed", code: "unsupported" })
    )
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
    const auditFailure = jest.fn().mockResolvedValue(undefined)
    const runner = createHostDispatchRunner({
      accountId: "acct",
      now: () => NOW + 1,
      deliver,
      auditFailure,
    })

    await runner.kick()

    expect(deliver).not.toHaveBeenCalled()
    expect(auditFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id }),
      expect.objectContaining({ kind: "failed", code: "timeout" })
    )
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

  it("audits only the attempt that exhausts the retry budget", async () => {
    const row = await enqueueHostDispatch({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "host-b",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "exhaust",
      maxAttempts: 2,
      label: "wf-1",
      now: NOW,
    })
    const auditFailure = jest.fn().mockResolvedValue(undefined)
    const runner = createHostDispatchRunner({
      accountId: "acct",
      now: () => NOW,
      auditFailure,
      deliver: jest
        .fn()
        .mockRejectedValue(new HostDispatchDeliveryError("handoff_failed", true, "offline")),
    })

    // First attempt: retryable, still inside the budget — nothing audited.
    await runner.kick()
    expect(auditFailure).not.toHaveBeenCalled()

    // The row is now backing off; make it due again so the second attempt runs.
    await getDb().hostDispatchQueue.update(row.id, { nextAttemptAt: NOW })
    await runner.kick()

    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      status: "deadletter",
      attempts: 2,
    })
    expect(auditFailure).toHaveBeenCalledTimes(1)
    expect(auditFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id, attempts: 2, label: "wf-1" }),
      expect.objectContaining({ kind: "deadletter", code: "handoff_failed", error: "offline" })
    )
  })

  it("keeps draining when the audit itself throws", async () => {
    await enqueueHostDispatch({
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: {},
      idempotencyKey: "audit-throws",
      now: NOW,
    })
    const second = await enqueueHostDispatch({
      accountId: "acct",
      domain: "mobile-step",
      targetRef: "phone",
      kind: "camera",
      payload: {},
      idempotencyKey: "audit-throws-2",
      now: NOW + 1,
    })
    const runner = createHostDispatchRunner({
      accountId: "acct",
      now: () => NOW + 2,
      auditFailure: jest.fn().mockRejectedValue(new Error("center down")),
      deliver: jest
        .fn()
        .mockRejectedValue(new HostDispatchDeliveryError("unsupported", false, "no")),
    })

    await expect(runner.kick()).resolves.toBeUndefined()
    await expect(getDb().hostDispatchQueue.get(second.id)).resolves.toMatchObject({
      status: "failed",
    })
  })
})
