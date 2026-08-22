/** @jest-environment jsdom */
/**
 * Tests for the connector cleanup ledger (schema v178).
 *
 * The ledger exists so a failed blob delete is retried rather than silently
 * orphaning ciphertext, so the behaviours that matter are: a re-enqueue must
 * not reset an existing job's backoff, an exhausted job must stay visible
 * instead of disappearing, and a job must not be picked up before it is due.
 */

import "fake-indexeddb/auto"
import {
  MAX_CLEANUP_ATTEMPTS,
  clearCleanupJobsForAdapter,
  enqueueCleanupJob,
  listCleanupJobs,
  listDueCleanupJobs,
  listExhaustedCleanupJobs,
  recordCleanupFailure,
  resolveCleanupJob,
} from "./connector-cleanup-jobs"
import { __resetDbForTesting, getDb } from "./schema"

const KEY = "a".repeat(64)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

describe("enqueueCleanupJob", () => {
  it("creates a job that is due immediately", async () => {
    const job = await enqueueCleanupJob(
      { cacheKey: KEY, adapterId: "adp_1", reason: "adapter_removed", error: "locked" },
      1000
    )
    expect(job.id).toBe(KEY)
    expect(job.attempts).toBe(0)
    expect(job.nextAttemptAt).toBe(1000)
    expect(job.lastError).toBe("locked")
    expect(await listDueCleanupJobs(1000)).toHaveLength(1)
  })

  it("does not reset an existing job's attempts or backoff", async () => {
    await enqueueCleanupJob({ cacheKey: KEY, adapterId: "adp_1", reason: "evicted" }, 1000)
    await recordCleanupFailure(KEY, "first failure", 1000)
    const before = await getDb().connectorCleanupJobs.get(KEY)

    // A second sweep noticing the same blob must not make it due again.
    await enqueueCleanupJob({ cacheKey: KEY, adapterId: "adp_1", reason: "orphaned" }, 2000)

    const after = await getDb().connectorCleanupJobs.get(KEY)
    expect(after?.attempts).toBe(before?.attempts)
    expect(after?.nextAttemptAt).toBe(before?.nextAttemptAt)
    // The original, more specific reason survives.
    expect(after?.reason).toBe("evicted")
  })
})

describe("recordCleanupFailure", () => {
  it("backs off exponentially and caps the delay", async () => {
    await enqueueCleanupJob({ cacheKey: KEY, adapterId: "adp_1", reason: "evicted" }, 0)

    const first = await recordCleanupFailure(KEY, "e1", 0)
    expect(first?.attempts).toBe(1)
    expect(first?.nextAttemptAt).toBe(30_000)

    const second = await recordCleanupFailure(KEY, "e2", 0)
    expect(second?.attempts).toBe(2)
    expect(second?.nextAttemptAt).toBe(60_000)

    // Far enough in to hit the ceiling.
    for (let i = 0; i < 10; i += 1) await recordCleanupFailure(KEY, "e", 0)
    const capped = await getDb().connectorCleanupJobs.get(KEY)
    expect(capped?.nextAttemptAt).toBe(30 * 60 * 1000)
  })

  it("is a no-op for a job that no longer exists", async () => {
    expect(await recordCleanupFailure("missing", "e", 0)).toBeUndefined()
  })
})

describe("listDueCleanupJobs", () => {
  it("skips jobs that are not due yet", async () => {
    await enqueueCleanupJob({ cacheKey: KEY, adapterId: "adp_1", reason: "evicted" }, 0)
    await recordCleanupFailure(KEY, "e", 0)
    expect(await listDueCleanupJobs(1_000)).toHaveLength(0)
    expect(await listDueCleanupJobs(60_000)).toHaveLength(1)
  })

  it("stops retrying an exhausted job but keeps it visible", async () => {
    await enqueueCleanupJob({ cacheKey: KEY, adapterId: "adp_1", reason: "evicted" }, 0)
    for (let i = 0; i < MAX_CLEANUP_ATTEMPTS; i += 1) {
      await recordCleanupFailure(KEY, "still failing", 0)
    }

    // Due by the clock, but out of attempts — the automatic sweep drops it…
    expect(await listDueCleanupJobs(Number.MAX_SAFE_INTEGER)).toHaveLength(0)
    // …while diagnostics can still report it as a permanently stuck blob.
    expect(await listCleanupJobs()).toHaveLength(1)
    const exhausted = await listExhaustedCleanupJobs()
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0].lastError).toBe("still failing")
  })
})

describe("resolveCleanupJob / clearCleanupJobsForAdapter", () => {
  it("forgets a job once its blob is gone", async () => {
    await enqueueCleanupJob({ cacheKey: KEY, adapterId: "adp_1", reason: "evicted" }, 0)
    await resolveCleanupJob(KEY)
    expect(await listCleanupJobs()).toHaveLength(0)
  })

  it("clears only the named adapter's jobs", async () => {
    await enqueueCleanupJob({ cacheKey: KEY, adapterId: "adp_1", reason: "evicted" }, 0)
    await enqueueCleanupJob({ cacheKey: "b".repeat(64), adapterId: "adp_2", reason: "evicted" }, 0)

    expect(await clearCleanupJobsForAdapter("adp_1")).toBe(1)
    const left = await listCleanupJobs()
    expect(left).toHaveLength(1)
    expect(left[0].adapterId).toBe("adp_2")
  })
})
