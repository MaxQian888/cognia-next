/** @jest-environment jsdom */
import { createDbTestFixture } from "./test-fixture"
import {
  ProjectMiningRunTransitionError,
  advanceProjectMiningRun,
  claimProjectMiningRun,
  createProjectMiningRun,
  getActiveProjectMiningRun,
  getProjectMiningRun,
  listProjectMiningRuns,
  recordProjectMiningRunClaims,
  transitionProjectMiningRun,
} from "./project-mining-runs"

const ESTIMATE = { sessions: 10, messages: 120, windows: 10, estimatedInputTokens: 26_400 }

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function newRun(id = "r1", projectId = "p1") {
  return createProjectMiningRun({ projectId, estimate: ESTIMATE, id, createdAt: 1_000 })
}

it("creates a run in preconsent, never already running", async () => {
  // The row exists so a person can see the cost before agreeing to it. A
  // constructor that could produce a running sweep would make that guarantee
  // depend on every call site.
  const row = await newRun()
  expect(row.status).toBe("preconsent")
  expect(row.sessionsScanned).toBe(0)
})

it("refuses an illegal transition instead of quietly clamping it", async () => {
  await newRun()
  await transitionProjectMiningRun("r1", "cancelled")
  await expect(transitionProjectMiningRun("r1", "queued")).rejects.toBeInstanceOf(
    ProjectMiningRunTransitionError
  )
})

it("stamps startedAt once and completedAt on the way out", async () => {
  await newRun()
  await transitionProjectMiningRun("r1", "queued")
  await transitionProjectMiningRun("r1", "running", {}, 2_000)
  await transitionProjectMiningRun("r1", "paused", {}, 3_000)
  await transitionProjectMiningRun("r1", "queued", {}, 4_000)
  await transitionProjectMiningRun("r1", "running", {}, 5_000)
  await transitionProjectMiningRun("r1", "succeeded", {}, 6_000)
  const row = await getProjectMiningRun("r1")
  expect(row?.startedAt).toBe(2_000)
  expect(row?.completedAt).toBe(6_000)
})

it("drops the lease whenever the run stops running", async () => {
  // A paused run that still reads as owned would be declined by every window on
  // resume, including the one that paused it.
  await newRun()
  await transitionProjectMiningRun("r1", "queued")
  await claimProjectMiningRun("r1", "w1", 1_000)
  await transitionProjectMiningRun("r1", "paused")
  const row = await getProjectMiningRun("r1")
  expect(row?.leaseOwner).toBeUndefined()
  expect(row?.leaseExpiresAt).toBeUndefined()
})

describe("the lease", () => {
  it("moves a queued run to running and stamps an owner", async () => {
    await newRun()
    await transitionProjectMiningRun("r1", "queued")
    const claimed = await claimProjectMiningRun("r1", "w1", 1_000, 60_000)
    expect(claimed?.status).toBe("running")
    expect(claimed?.leaseOwner).toBe("w1")
    expect(claimed?.leaseExpiresAt).toBe(61_000)
  })

  it("declines a second window while the lease is live", async () => {
    await newRun()
    await transitionProjectMiningRun("r1", "queued")
    await claimProjectMiningRun("r1", "w1", 1_000, 60_000)
    expect(await claimProjectMiningRun("r1", "w2", 2_000, 60_000)).toBeUndefined()
  })

  it("hands the run to another window once the lease lapses", async () => {
    await newRun()
    await transitionProjectMiningRun("r1", "queued")
    await claimProjectMiningRun("r1", "w1", 1_000, 60_000)
    const taken = await claimProjectMiningRun("r1", "w2", 61_000, 60_000)
    expect(taken?.leaseOwner).toBe("w2")
  })

  it("will not claim a run a person has not started", async () => {
    await newRun()
    expect(await claimProjectMiningRun("r1", "w1", 1_000)).toBeUndefined()
  })
})

describe("advancing", () => {
  it("moves the watermark, adds the counters, and renews the lease", async () => {
    await newRun()
    await transitionProjectMiningRun("r1", "queued")
    await claimProjectMiningRun("r1", "w1", 1_000, 60_000)
    const advanced = await advanceProjectMiningRun(
      "r1",
      { cursorCreatedAt: 500, cursorSessionId: "s9", sessionsScanned: 5, jobsEnqueued: 12 },
      30_000,
      60_000
    )
    expect(advanced).toMatchObject({
      cursorCreatedAt: 500,
      cursorSessionId: "s9",
      sessionsScanned: 5,
      jobsEnqueued: 12,
    })
    // Every step is a heartbeat: a long batch must not let the lease lapse
    // under a worker that is plainly still working.
    expect(advanced?.leaseExpiresAt).toBe(90_000)
  })

  it("refuses to advance a run that is not running", async () => {
    await newRun()
    expect(
      await advanceProjectMiningRun("r1", {
        cursorCreatedAt: 1,
        cursorSessionId: "s1",
        sessionsScanned: 1,
        jobsEnqueued: 0,
      })
    ).toBeUndefined()
  })
})

it("accumulates claims attributed by finished mining jobs", async () => {
  await newRun()
  await recordProjectMiningRunClaims("r1", 3)
  await recordProjectMiningRunClaims("r1", 2)
  expect((await getProjectMiningRun("r1"))?.claimsProduced).toBe(5)
})

describe("the active run", () => {
  it("counts preconsent as active, so a second sweep cannot be proposed over it", async () => {
    await newRun()
    expect((await getActiveProjectMiningRun("p1"))?.id).toBe("r1")
  })

  it("is empty once every run for the workspace has ended", async () => {
    await newRun()
    await transitionProjectMiningRun("r1", "cancelled")
    expect(await getActiveProjectMiningRun("p1")).toBeUndefined()
    expect(await listProjectMiningRuns("p1")).toHaveLength(1)
  })

  it("does not see another workspace's run", async () => {
    await newRun("r1", "p1")
    expect(await getActiveProjectMiningRun("p2")).toBeUndefined()
  })
})
