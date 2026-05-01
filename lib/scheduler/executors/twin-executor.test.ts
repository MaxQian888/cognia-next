import "fake-indexeddb/auto"
import { executeTwinTask } from "./twin-executor"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinSource } from "@/lib/db/twin-sources"
import { listJobsByTwinAndKind } from "@/lib/db/twin-jobs"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  const db = getDb()
  await Promise.all([db.twinSources.clear(), db.twinJobs.clear()])
})

function makeTask(payload: Record<string, unknown>): ScheduledTask {
  return {
    id: "task_1",
    name: "twin task",
    description: "",
    type: "twin",
    payload,
    schedule: { kind: "manual" },
    config: { enabled: true, timezone: "UTC" },
    state: { status: "idle" },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as ScheduledTask
}

const execution = { id: "exec_1" } as unknown as TaskExecution

describe("executeTwinTask", () => {
  it("rejects payloads missing twinId", async () => {
    const result = await executeTwinTask(makeTask({}), execution)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/twinId/)
  })

  it("enqueues a distill job when kind is omitted (defaults to distill)", async () => {
    const result = await executeTwinTask(makeTask({ twinId: "twin_alice" }), execution)
    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({ kind: "distill" })
    const jobs = await listJobsByTwinAndKind("twin_alice", "distill")
    expect(jobs).toHaveLength(1)
  })

  it("supports re-distill kind", async () => {
    const result = await executeTwinTask(
      makeTask({ twinId: "twin_alice", kind: "re-distill" }),
      execution
    )
    expect(result.success).toBe(true)
    const jobs = await listJobsByTwinAndKind("twin_alice", "re-distill")
    expect(jobs).toHaveLength(1)
  })

  it("ingest kind skips when nothing is pending", async () => {
    const result = await executeTwinTask(
      makeTask({ twinId: "twin_alice", kind: "ingest" }),
      execution
    )
    expect(result.success).toBe(true)
    expect(result.output?.skipped).toBeDefined()
    const jobs = await listJobsByTwinAndKind("twin_alice", "ingest")
    expect(jobs).toEqual([])
  })

  it("ingest kind enqueues every pending source by default", async () => {
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "n",
      bytes: 1,
      fingerprint: "f1",
      redacted: false,
    })
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/other.md",
      title: "o",
      bytes: 1,
      fingerprint: "f2",
      redacted: false,
    })
    const result = await executeTwinTask(
      makeTask({ twinId: "twin_alice", kind: "ingest" }),
      execution
    )
    expect(result.success).toBe(true)
    expect(result.output?.sourceCount).toBe(2)
    const jobs = await listJobsByTwinAndKind("twin_alice", "ingest")
    expect(jobs).toHaveLength(1)
    expect(jobs[0].sourceIds).toHaveLength(2)
  })

  it("ingest kind respects an explicit sourceIds list", async () => {
    const a = await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "n",
      bytes: 1,
      fingerprint: "f1",
      redacted: false,
    })
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/other.md",
      title: "o",
      bytes: 1,
      fingerprint: "f2",
      redacted: false,
    })
    const result = await executeTwinTask(
      makeTask({ twinId: "twin_alice", kind: "ingest", sourceIds: [a.id] }),
      execution
    )
    expect(result.success).toBe(true)
    expect(result.output?.sourceCount).toBe(1)
    const jobs = await listJobsByTwinAndKind("twin_alice", "ingest")
    expect(jobs[0].sourceIds).toEqual([a.id])
  })
})
