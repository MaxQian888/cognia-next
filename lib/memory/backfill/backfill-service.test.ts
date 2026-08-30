/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getProjectMiningRun, listProjectMiningRuns } from "@/lib/db/project-mining-runs"
import {
  cancelWorkspaceBackfill,
  confirmWorkspaceBackfill,
  estimateWorkspaceBackfill,
  proposeWorkspaceBackfill,
  tickWorkspaceBackfill,
} from "./backfill-service"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

async function seedSession(id: string, projectId: string, createdAt: number) {
  await getDb().sessions.put({
    id,
    projectId,
    title: id,
    createdAt,
    updatedAt: createdAt,
  } as never)
}

async function seedMessage(id: string, sessionId: string, projectId: string, createdAt: number) {
  await getDb().messages.put({
    id,
    sessionId,
    projectId,
    role: "user",
    parts: [{ type: "text", text: "we standardised on pnpm workspaces" }],
    createdAt,
  } as never)
}

describe("the preconsent estimate", () => {
  it("counts the workspace's own sessions and messages", async () => {
    await seedSession("s1", "p1", 100)
    await seedSession("s2", "p1", 200)
    await seedSession("other", "p2", 300)
    await seedMessage("m1", "s1", "p1", 100)
    await seedMessage("m2", "s2", "p1", 200)
    await seedMessage("m3", "other", "p2", 300)
    const estimate = await estimateWorkspaceBackfill("p1")
    expect(estimate.sessions).toBe(2)
    expect(estimate.messages).toBe(2)
  })
})

describe("proposing", () => {
  it("creates one run in preconsent", async () => {
    await seedSession("s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    expect(run.status).toBe("preconsent")
  })

  it("hands back the run already in flight rather than starting a rival", async () => {
    // Two runs over one workspace would fight over the same cursor and mine
    // everything twice.
    await seedSession("s1", "p1", 100)
    const first = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(first.id)
    const second = await proposeWorkspaceBackfill("p1")
    expect(second.id).toBe(first.id)
    expect(await listProjectMiningRuns("p1")).toHaveLength(1)
  })

  it("allows a fresh run once the previous one ended", async () => {
    await seedSession("s1", "p1", 100)
    const first = await proposeWorkspaceBackfill("p1")
    await cancelWorkspaceBackfill(first.id)
    const second = await proposeWorkspaceBackfill("p1")
    expect(second.id).not.toBe(first.id)
  })
})

describe("the background tick", () => {
  it("will not move a run a person has not agreed to", async () => {
    await seedSession("s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "idle" })
    expect((await getProjectMiningRun(run.id))?.status).toBe("preconsent")
  })

  it("walks the workspace newest first and moves the watermark", async () => {
    await seedSession("s1", "p1", 100)
    await seedSession("s2", "p1", 300)
    await seedMessage("m1", "s1", "p1", 100)
    await seedMessage("m2", "s2", "p1", 300)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    const outcome = await tickWorkspaceBackfill("p1")
    expect(outcome.kind).toBe("advanced")
    const after = await getProjectMiningRun(run.id)
    // The page is newest-first, so the watermark lands on the OLDEST row it saw.
    expect(after?.cursorSessionId).toBe("s1")
    expect(after?.sessionsScanned).toBe(2)
  })

  it("finishes when nothing older remains", async () => {
    await seedSession("s1", "p1", 100)
    await seedMessage("m1", "s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    await tickWorkspaceBackfill("p1")
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "finished" })
    expect((await getProjectMiningRun(run.id))?.status).toBe("succeeded")
  })

  it("is a no-op for a workspace with no run", async () => {
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "idle" })
  })

  it("stops touching a workspace once its run is cancelled", async () => {
    await seedSession("s1", "p1", 100)
    await seedMessage("m1", "s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    await confirmWorkspaceBackfill(run.id)
    await cancelWorkspaceBackfill(run.id)
    expect(await tickWorkspaceBackfill("p1")).toEqual({ kind: "idle" })
  })
})

describe("cancelling", () => {
  it("withdraws the run's still-queued mining jobs by dedupe-key prefix", async () => {
    const db = getDb()
    await seedSession("s1", "p1", 100)
    const run = await proposeWorkspaceBackfill("p1")
    await db.memoryJobs.put({
      id: "j1",
      dedupeKey: `project-mining:${run.id}:s1:m1:m9:9`,
      kind: "project-mining",
      status: "queued",
      queuedAt: 1,
      retryCount: 0,
    } as never)
    // A live-mined window shares the kind but not the prefix, and must survive.
    await db.memoryJobs.put({
      id: "j2",
      dedupeKey: "project-mining:s1:m1:m9:9",
      kind: "project-mining",
      status: "queued",
      queuedAt: 1,
      retryCount: 0,
    } as never)
    const cancelled = await cancelWorkspaceBackfill(run.id)
    expect(cancelled).toBe(1)
    expect((await db.memoryJobs.get("j1"))?.status).toBe("cancelled")
    expect((await db.memoryJobs.get("j2"))?.status).toBe("queued")
  })
})
