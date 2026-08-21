/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  claimDueHostDispatch,
  completeHostDispatch,
  enqueueHostDispatch,
  failHostDispatch,
  hostDispatchBackoffMs,
  listDeadLetteredHostDispatch,
  listHostDispatchForRun,
  markHostDispatchInflight,
  recoverStrandedHostDispatch,
} from "./host-dispatch-queue"
import { __resetDbForTesting, getDb } from "./schema"

const NOW = 1_700_000_000_000

function input(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "local_acct_a",
    domain: "remote-step" as const,
    targetRef: "device:a",
    kind: "action.mobile.camera",
    payload: { quality: 50 },
    idempotencyKey: "run_1:step_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW,
    ...overrides,
  }
}

describe("hostDispatchQueue", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().hostDispatchQueue.clear()
  })

  it("enqueues a pending row addressed to its target", async () => {
    const row = await enqueueHostDispatch(input())

    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      targetRef: "device:a",
      domain: "remote-step",
      nextAttemptAt: NOW,
    })
    expect(await getDb().hostDispatchQueue.count()).toBe(1)
  })

  it("returns the existing row rather than dispatching the same work twice", async () => {
    // The key is the identity of the WORK, not of the attempt: a caller that
    // retries after a crash must re-find its row, not enqueue a second one.
    const first = await enqueueHostDispatch(input())
    const second = await enqueueHostDispatch(input({ payload: { quality: 99 } }))

    expect(second.id).toBe(first.id)
    expect(second.payload).toEqual({ quality: 50 })
    expect(await getDb().hostDispatchQueue.count()).toBe(1)
  })

  it("claims only rows that are due, oldest first, for this account", async () => {
    await enqueueHostDispatch(input({ idempotencyKey: "k1", now: NOW - 1_000 }))
    await enqueueHostDispatch(input({ idempotencyKey: "k2", now: NOW }))
    await enqueueHostDispatch(input({ idempotencyKey: "k3", accountId: "other_acct" }))
    const future = await enqueueHostDispatch(input({ idempotencyKey: "k4" }))
    await getDb().hostDispatchQueue.update(future.id, { nextAttemptAt: NOW + 60_000 })

    const due = await claimDueHostDispatch("local_acct_a", NOW)

    expect(due.map((row) => row.idempotencyKey)).toEqual(["k1", "k2"])
  })

  it("backs off exponentially and stops climbing at the ceiling", async () => {
    expect(hostDispatchBackoffMs(1)).toBe(2_000)
    expect(hostDispatchBackoffMs(2)).toBe(4_000)
    expect(hostDispatchBackoffMs(3)).toBe(8_000)
    expect(hostDispatchBackoffMs(30)).toBe(5 * 60_000)
  })

  it("reschedules a failure and dead-letters once it runs out of road", async () => {
    // An indefinitely retrying row is how a queue quietly becomes a busy loop;
    // a silently dropped one is how work disappears. Neither is acceptable, so
    // exhaustion is an explicit terminal state a human can see.
    const row = await enqueueHostDispatch(input({ maxAttempts: 2 }))

    expect(await failHostDispatch(row.id, "device offline", NOW)).toBe("pending")
    const retried = await getDb().hostDispatchQueue.get(row.id)
    expect(retried).toMatchObject({ attempts: 1, lastError: "device offline" })
    expect(retried!.nextAttemptAt).toBe(NOW + 2_000)

    expect(await failHostDispatch(row.id, "device offline", NOW)).toBe("deadletter")
    expect(await listDeadLetteredHostDispatch("local_acct_a")).toHaveLength(1)
  })

  it("never retries a dead-lettered row on its own", async () => {
    const row = await enqueueHostDispatch(input({ maxAttempts: 1 }))
    await failHostDispatch(row.id, "gone", NOW)

    expect(await claimDueHostDispatch("local_acct_a", NOW + 86_400_000)).toEqual([])
  })

  it("recovers rows stranded inflight by a host that died mid-dispatch", async () => {
    // Without this an interrupted dispatch stays `inflight` forever and is
    // never retried — the exact silent loss this queue exists to prevent.
    const row = await enqueueHostDispatch(input())
    await markHostDispatchInflight(row.id, NOW)
    expect(await claimDueHostDispatch("local_acct_a", NOW)).toEqual([])

    expect(await recoverStrandedHostDispatch("local_acct_a", NOW)).toBe(1)
    expect((await claimDueHostDispatch("local_acct_a", NOW)).map((r) => r.id)).toEqual([row.id])
  })

  it("does not recover another account's stranded rows", async () => {
    const row = await enqueueHostDispatch(input({ accountId: "other_acct" }))
    await markHostDispatchInflight(row.id, NOW)

    expect(await recoverStrandedHostDispatch("local_acct_a", NOW)).toBe(0)
  })

  it("stops claiming a row once it succeeds", async () => {
    const row = await enqueueHostDispatch(input())
    await completeHostDispatch(row.id, NOW)

    expect(await claimDueHostDispatch("local_acct_a", NOW)).toEqual([])
    expect((await getDb().hostDispatchQueue.get(row.id))?.status).toBe("succeeded")
  })

  it("lets a resumed run find what it had already sent", async () => {
    await enqueueHostDispatch(input({ idempotencyKey: "a" }))
    await enqueueHostDispatch(input({ idempotencyKey: "b", stepId: "step_2" }))
    await enqueueHostDispatch(input({ idempotencyKey: "c", runId: "run_other" }))

    const forRun = await listHostDispatchForRun("run_1")
    expect(forRun.map((row) => row.idempotencyKey).sort()).toEqual(["a", "b"])
  })

  it("tolerates a concurrent enqueue winning the race for one key", async () => {
    const [first, second] = await Promise.all([
      enqueueHostDispatch(input()),
      enqueueHostDispatch(input()),
    ])

    expect(await getDb().hostDispatchQueue.count()).toBe(1)
    expect(first!.idempotencyKey).toBe(second!.idempotencyKey)
  })
})
