/**
 * Focused coverage for the M1-era job-action helpers in
 * `lib/db/twin-jobs.ts`: `cancelJob` and `retryDeadLetterJob`. The other
 * CRUD ops are covered by `twin-tables.test.ts`.
 */

import {
  cancelJob,
  createTwinJob,
  failJob,
  getTwinJob,
  retryDeadLetterJob,
  USER_CANCEL_SENTINEL,
} from "./twin-jobs"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().twinJobs.clear()
})
afterAll(dbFixture.dispose)

describe("cancelJob", () => {
  it("marks the row failed with the USER_CANCELLED sentinel", async () => {
    const job = await createTwinJob({
      twinId: "twin_a",
      kind: "ingest",
      sourceIds: ["src-1"],
    })
    await cancelJob(job.id)
    const updated = await getTwinJob(job.id)
    expect(updated?.status).toBe("failed")
    expect(updated?.phase).toBe("cancelled")
    expect(updated?.errorMessage).toContain(USER_CANCEL_SENTINEL)
    expect(updated?.completedAt).toBeGreaterThan(0)
  })

  it("appends a reason when provided", async () => {
    const job = await createTwinJob({
      twinId: "twin_a",
      kind: "ingest",
      sourceIds: [],
    })
    await cancelJob(job.id, "fingerprint mismatch")
    const updated = await getTwinJob(job.id)
    expect(updated?.errorMessage).toContain("fingerprint mismatch")
  })
})

describe("retryDeadLetterJob", () => {
  it("resets retryCount and re-queues the job", async () => {
    const job = await createTwinJob({
      twinId: "twin_a",
      kind: "ingest",
      sourceIds: ["src-1"],
    })
    // Push the job into the dead-letter state by failing it 3 times.
    await failJob(job.id, "[DEAD_LETTER] gave up")
    await failJob(job.id, "[DEAD_LETTER] gave up")
    await failJob(job.id, "[DEAD_LETTER] gave up")
    const dead = await getTwinJob(job.id)
    expect(dead?.retryCount).toBeGreaterThanOrEqual(3)

    await retryDeadLetterJob(job.id)
    const retried = await getTwinJob(job.id)
    expect(retried?.status).toBe("queued")
    expect(retried?.phase).toBe("queued")
    expect(retried?.progress).toBe(0)
    expect(retried?.retryCount).toBe(0)
    expect(retried?.errorMessage).toBeUndefined()
    expect(retried?.completedAt).toBeUndefined()
    expect(retried?.nextAttemptAt).toBeUndefined()
  })
})
