/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { cancelJob, createTwinJob, getTwinJob, pauseJob } from "./twin-jobs"
import {
  __resetActiveTwinJobsForTesting,
  isTwinJobInterrupted,
  registerActiveTwinJob,
  throwIfTwinJobInterrupted,
} from "@/lib/twin/job-control"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetActiveTwinJobsForTesting()
})

it("cooperatively interrupts an active job when it is paused", async () => {
  const job = await createTwinJob({ twinId: "twin-1", kind: "ingest", sourceIds: [] })
  const active = registerActiveTwinJob(job.id)

  await pauseJob(job.id)

  expect(() => throwIfTwinJobInterrupted(active.signal)).toThrow("pause")
  try {
    throwIfTwinJobInterrupted(active.signal)
  } catch (error) {
    expect(isTwinJobInterrupted(error)).toBe(true)
  }
  expect(await getTwinJob(job.id)).toMatchObject({ status: "paused", phase: "paused" })
})

it("updates an inactive job when it is cancelled", async () => {
  const job = await createTwinJob({ twinId: "twin-1", kind: "distill", sourceIds: [] })

  await cancelJob(job.id, "user request")

  expect(await getTwinJob(job.id)).toMatchObject({
    status: "failed",
    phase: "cancelled",
    errorMessage: "[USER_CANCELLED] user request",
  })
})
