/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  claimDueHostDispatch,
  completeHostDispatch,
  cancelHostDispatch,
  enqueueHostDispatch,
  failHostDispatch,
  hostDispatchBackoffMs,
  listDeadLetteredHostDispatch,
  listHostDispatchForRun,
  listHostDispatchForTarget,
  markHostDispatchInflight,
  markHostDispatchAwaitingResult,
  pruneTerminalHostDispatch,
  recordHostDispatchRemoteRun,
  recoverStrandedHostDispatch,
  storeHostDispatchResultChunk,
  consumeHostDispatchResult,
  HOST_DISPATCH_LEASE_MS,
  HOST_DISPATCH_RESULT_REDELIVERY_MS,
  terminateHostDispatch,
} from "./host-dispatch-queue"
import { __resetDbForTesting, getDb } from "./schema"
import {
  HOST_DISPATCH_MAX_RESULT_CHARS,
  HOST_DISPATCH_MAX_RESULT_CHUNKS,
  HOST_DISPATCH_RESULT_CHUNK_CHARS,
} from "@/types/placement/host-dispatch"

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
  }, 15_000)

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
    expect(due.every((row) => row.status === "inflight" && row.leaseExpiresAt)).toBe(true)
  })

  it("atomically gives a due row to only one concurrent runner", async () => {
    await enqueueHostDispatch(input({ idempotencyKey: "one-owner" }))
    const [left, right] = await Promise.all([
      claimDueHostDispatch("local_acct_a", NOW, 1, "runner-left"),
      claimDueHostDispatch("local_acct_a", NOW, 1, "runner-right"),
    ])
    expect([...left, ...right]).toHaveLength(1)
    expect([...left, ...right][0]?.leaseOwner).toMatch(/runner-(left|right)/)
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

    expect(await recoverStrandedHostDispatch("local_acct_a", NOW)).toBe(0)
    expect(await recoverStrandedHostDispatch("local_acct_a", NOW + HOST_DISPATCH_LEASE_MS)).toBe(1)
    expect(
      (await claimDueHostDispatch("local_acct_a", NOW + HOST_DISPATCH_LEASE_MS)).map((r) => r.id)
    ).toEqual([row.id])
  })

  it("does not recover another account's stranded rows", async () => {
    const row = await enqueueHostDispatch(input({ accountId: "other_acct" }))
    await markHostDispatchInflight(row.id, NOW)

    expect(await recoverStrandedHostDispatch("local_acct_a", NOW)).toBe(0)
  })

  it("redelivers an acknowledged delivery after a bounded result wait", async () => {
    const row = await enqueueHostDispatch(input({ id: "rst-await" }))
    await claimDueHostDispatch("local_acct_a", NOW, 1, "runner")
    await markHostDispatchAwaitingResult(row.id, NOW)
    await expect(claimDueHostDispatch("local_acct_a", NOW)).resolves.toEqual([])
    await expect(
      claimDueHostDispatch("local_acct_a", NOW + HOST_DISPATCH_RESULT_REDELIVERY_MS)
    ).resolves.toHaveLength(1)
  })

  it("recovers legacy awaiting-result rows into receipt-deduplicated delivery", async () => {
    const row = await enqueueHostDispatch(input({ id: "rst-legacy-await" }))
    await getDb().hostDispatchQueue.update(row.id, { status: "awaiting-result" })

    await expect(recoverStrandedHostDispatch("local_acct_a", NOW + 1)).resolves.toBe(1)
    await expect(claimDueHostDispatch("local_acct_a", NOW + 1)).resolves.toHaveLength(1)
  })

  it("leaves unrelated legacy awaiting-result rows untouched for a job-scoped runner", async () => {
    const target = await enqueueHostDispatch(input({ id: "rst-target", idempotencyKey: "target" }))
    const unrelated = await enqueueHostDispatch(
      input({ id: "rst-unrelated", idempotencyKey: "unrelated" })
    )
    await getDb().hostDispatchQueue.bulkUpdate([
      { key: target.id, changes: { status: "awaiting-result" } },
      { key: unrelated.id, changes: { status: "awaiting-result" } },
    ])

    await expect(recoverStrandedHostDispatch("local_acct_a", NOW + 1, target.id)).resolves.toBe(1)
    await expect(getDb().hostDispatchQueue.get(target.id)).resolves.toMatchObject({
      status: "pending",
    })
    await expect(getDb().hostDispatchQueue.get(unrelated.id)).resolves.toMatchObject({
      status: "awaiting-result",
    })
  })

  it("persists out-of-order result chunks for restart-safe workflow recovery", async () => {
    await enqueueHostDispatch(input({ id: "rst-result", targetRef: "phone-7" }))
    await markHostDispatchAwaitingResult("rst-result", NOW)
    await expect(
      storeHostDispatchResultChunk("evil-phone", {
        requestId: "rst-result",
        seq: 0,
        total: 2,
        chunk: "a",
      })
    ).resolves.toEqual({ ok: false, reason: "wrong-target" })
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-result",
        seq: 1,
        total: 2,
        chunk: "secret}",
      })
    ).resolves.toEqual({ ok: true, complete: false })
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-result",
        seq: 0,
        total: 2,
        chunk: "{",
      })
    ).resolves.toEqual({ ok: true, complete: true })
    await expect(consumeHostDispatchResult("rst-result")).resolves.toBe("{secret}")
    await expect(consumeHostDispatchResult("rst-result")).resolves.toBe("{secret}")
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-result",
        seq: 0,
        total: 2,
        chunk: "{",
      })
    ).resolves.toEqual({ ok: true, complete: true })
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-result",
        seq: 0,
        total: 2,
        chunk: "replacement",
      })
    ).resolves.toEqual({ ok: false, reason: "terminal" })
  })

  it("rejects a conflicting replacement before assembly completes", async () => {
    await enqueueHostDispatch(input({ id: "rst-conflict", targetRef: "phone-7" }))
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-conflict",
        seq: 0,
        total: 2,
        chunk: "first",
      })
    ).resolves.toEqual({ ok: true, complete: false })
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-conflict",
        seq: 0,
        total: 2,
        chunk: "replacement",
      })
    ).resolves.toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects result chunk counts and payloads above the durable assembly bounds", async () => {
    await enqueueHostDispatch(input({ id: "rst-bounded", targetRef: "phone-7" }))

    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-bounded",
        seq: 0,
        total: HOST_DISPATCH_MAX_RESULT_CHUNKS + 1,
        chunk: "x",
      })
    ).resolves.toEqual({ ok: false, reason: "malformed" })
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: "rst-bounded",
        seq: 0,
        total: 1,
        chunk: "x".repeat(HOST_DISPATCH_RESULT_CHUNK_CHARS + 1),
      })
    ).resolves.toEqual({ ok: false, reason: "malformed" })
  })

  it("stops claiming a row once it succeeds", async () => {
    const row = await enqueueHostDispatch(input())
    await completeHostDispatch(row.id, NOW)

    expect(await claimDueHostDispatch("local_acct_a", NOW)).toEqual([])
    expect((await getDb().hostDispatchQueue.get(row.id))?.status).toBe("succeeded")
  })

  it("keeps terminal transitions monotonic when timeout and failure race a result", async () => {
    const row = await enqueueHostDispatch(input({ id: "terminal-race" }))
    await completeHostDispatch(row.id, NOW)

    await cancelHostDispatch(row.id, "timeout", NOW + 1)
    await terminateHostDispatch(row.id, "late failure", "delivery_failed", NOW + 2)
    await expect(failHostDispatch(row.id, "late retry", NOW + 3)).resolves.toBe("succeeded")
    await markHostDispatchInflight(row.id, NOW + 4)

    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      status: "succeeded",
      attempts: 0,
    })
  })

  it("applies cancellation and terminal failure only to nonterminal rows", async () => {
    const cancelled = await enqueueHostDispatch(
      input({ id: "cancel-pending", idempotencyKey: "cancel-pending" })
    )
    const failed = await enqueueHostDispatch(
      input({ id: "fail-pending", idempotencyKey: "fail-pending" })
    )

    await cancelHostDispatch(cancelled.id, "aborted", NOW)
    await terminateHostDispatch(failed.id, "invalid target", "invalid_target", NOW)

    await expect(getDb().hostDispatchQueue.get(cancelled.id)).resolves.toMatchObject({
      status: "cancelled",
      terminalCode: "aborted",
    })
    await expect(getDb().hostDispatchQueue.get(failed.id)).resolves.toMatchObject({
      status: "failed",
      terminalCode: "invalid_target",
    })
    await expect(failHostDispatch("missing", "gone", NOW)).resolves.toBe("failed")
    await expect(completeHostDispatch("missing", NOW)).resolves.toBeUndefined()
    await expect(cancelHostDispatch("missing", "cancelled", NOW)).resolves.toBeUndefined()
    await expect(terminateHostDispatch("missing", "gone", "missing", NOW)).resolves.toBeUndefined()
  })

  it("rejects terminal, mismatched, and corrupt oversized result assemblies", async () => {
    const terminal = await enqueueHostDispatch(
      input({ id: "result-terminal", idempotencyKey: "result-terminal", targetRef: "phone-7" })
    )
    await cancelHostDispatch(terminal.id, "aborted", NOW)
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: terminal.id,
        seq: 0,
        total: 1,
        chunk: "x",
      })
    ).resolves.toEqual({ ok: false, reason: "terminal" })

    const mismatched = await enqueueHostDispatch(
      input({ id: "result-mismatch", idempotencyKey: "result-mismatch", targetRef: "phone-7" })
    )
    await storeHostDispatchResultChunk("phone-7", {
      requestId: mismatched.id,
      seq: 0,
      total: 2,
      chunk: "x",
    })
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: mismatched.id,
        seq: 1,
        total: 3,
        chunk: "y",
      })
    ).resolves.toEqual({ ok: false, reason: "malformed" })

    await getDb().hostDispatchQueue.update(mismatched.id, {
      resultTotal: 2,
      resultChunks: { legacy: "x".repeat(HOST_DISPATCH_MAX_RESULT_CHARS) },
    })
    await expect(
      storeHostDispatchResultChunk("phone-7", {
        requestId: mismatched.id,
        seq: 1,
        total: 2,
        chunk: "y",
      })
    ).resolves.toEqual({ ok: false, reason: "malformed" })
  })

  it("prunes only terminal rows after the bounded retention window", async () => {
    const stale = await enqueueHostDispatch(
      input({ id: "terminal-stale", idempotencyKey: "stale" })
    )
    const fresh = await enqueueHostDispatch(
      input({ id: "terminal-fresh", idempotencyKey: "fresh" })
    )
    const pending = await enqueueHostDispatch(
      input({ id: "pending-stale", idempotencyKey: "pending" })
    )
    await completeHostDispatch(stale.id, NOW)
    await completeHostDispatch(fresh.id, NOW + 5_000)

    await expect(pruneTerminalHostDispatch(NOW + 10_000, 6_000)).resolves.toBe(1)
    await expect(getDb().hostDispatchQueue.get(stale.id)).resolves.toBeUndefined()
    await expect(getDb().hostDispatchQueue.get(fresh.id)).resolves.toBeDefined()
    await expect(getDb().hostDispatchQueue.get(pending.id)).resolves.toBeDefined()
  })

  it("lets a resumed run find what it had already sent", async () => {
    await enqueueHostDispatch(input({ idempotencyKey: "a" }))
    await enqueueHostDispatch(input({ idempotencyKey: "b", stepId: "step_2" }))
    await enqueueHostDispatch(input({ idempotencyKey: "c", runId: "run_other" }))

    const forRun = await listHostDispatchForRun("run_1")
    expect(forRun.map((row) => row.idempotencyKey).sort()).toEqual(["a", "b"])
  })

  it("lists everything ever sent to one target, newest first", async () => {
    await enqueueHostDispatch(input({ idempotencyKey: "a", now: NOW }))
    await enqueueHostDispatch(input({ idempotencyKey: "b", stepId: "step_2", now: NOW + 1_000 }))
    await enqueueHostDispatch(input({ idempotencyKey: "c", targetRef: "device:b" }))

    const rows = await listHostDispatchForTarget("device:a")
    expect(rows.map((row) => row.idempotencyKey)).toEqual(["b", "a"])
  })

  it("keeps terminal rows, because a failure is what the reader came for", async () => {
    const job = await enqueueHostDispatch(input())
    await markHostDispatchInflight(job.id)
    await failHostDispatch(job.id, "device denied the prompt", NOW, { maxAttempts: 1 })

    const rows = await listHostDispatchForTarget("device:a")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ lastError: "device denied the prompt" })
  })

  it("answers nothing for a target that was never addressed", async () => {
    await enqueueHostDispatch(input())
    await expect(listHostDispatchForTarget("device:never")).resolves.toEqual([])
  })

  it("tolerates a concurrent enqueue winning the race for one key", async () => {
    const [first, second] = await Promise.all([
      enqueueHostDispatch(input()),
      enqueueHostDispatch(input()),
    ])

    expect(await getDb().hostDispatchQueue.count()).toBe(1)
    expect(first!.idempotencyKey).toBe(second!.idempotencyKey)
  })

  it("rethrows storage failures that are not the unique-index race", async () => {
    const add = jest
      .spyOn(getDb().hostDispatchQueue, "add")
      .mockRejectedValueOnce(new Error("storage unavailable"))

    await expect(enqueueHostDispatch(input({ idempotencyKey: "storage-failure" }))).rejects.toThrow(
      "storage unavailable"
    )
    add.mockRestore()
  })

  it("records the target's run id once and ignores a repeated write", async () => {
    const row = await enqueueHostDispatch({
      accountId: "acct",
      domain: "schedule-handoff",
      targetRef: "host-b",
      kind: "workflow.trigger",
      payload: {},
      idempotencyKey: "remote-run-pointer",
      now: 1_000,
    })

    await recordHostDispatchRemoteRun(row.id, "remote-run-1", 2_000)
    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      remoteRunId: "remote-run-1",
      updatedAt: 2_000,
    })

    // A redelivery replays the same pointer; it must not churn `updatedAt` and
    // make an idle row look freshly touched.
    await recordHostDispatchRemoteRun(row.id, "remote-run-1", 3_000)
    await expect(getDb().hostDispatchQueue.get(row.id)).resolves.toMatchObject({
      updatedAt: 2_000,
    })
  })

  it("ignores a run pointer for a row that no longer exists", async () => {
    await expect(recordHostDispatchRemoteRun("gone", "run-x", 1_000)).resolves.toBeUndefined()
  })
})
