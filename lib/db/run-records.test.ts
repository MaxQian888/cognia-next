/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import {
  upsertRunRecord,
  getLatestRunRecord,
  listRunRecords,
  pruneRunRecords,
  deleteRunRecordsForSession,
  runRecordRowFromView,
  type RunRecordRow,
} from "./run-records"
import type { RunRecordView } from "@/lib/claude/run-record"
import { getDb } from "./schema"

function row(sessionId: string, runId: number, startedAt: number): RunRecordRow {
  return {
    sessionId,
    runId,
    startedAt,
    status: "done",
    tools: [],
    subagents: [],
    todos: [],
    todoCounts: { done: 0, total: 0 },
    counts: { tools: 0, subagents: 0 },
  }
}

beforeEach(async () => {
  await getDb().runRecords.clear()
})

describe("run-records CRUD", () => {
  it("upserts by [sessionId+runId] (a second write replaces the first)", async () => {
    await upsertRunRecord(row("s1", 1, 100))
    await upsertRunRecord({ ...row("s1", 1, 100), status: "interrupted" })
    const all = await listRunRecords("s1")
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe("interrupted")
  })

  it("getLatestRunRecord returns the highest startedAt for the session", async () => {
    await upsertRunRecord(row("s1", 1, 100))
    await upsertRunRecord(row("s1", 2, 300))
    await upsertRunRecord(row("s1", 3, 200))
    await upsertRunRecord(row("s2", 1, 999))
    const latest = await getLatestRunRecord("s1")
    expect(latest?.runId).toBe(2)
  })

  it("getLatestRunRecord returns undefined when the session has no records", async () => {
    expect(await getLatestRunRecord("ghost")).toBeUndefined()
  })

  it("listRunRecords returns a session's rows newest-first", async () => {
    await upsertRunRecord(row("s1", 1, 100))
    await upsertRunRecord(row("s1", 2, 300))
    await upsertRunRecord(row("s1", 3, 200))
    expect((await listRunRecords("s1")).map((r) => r.runId)).toEqual([2, 3, 1])
  })

  it("pruneRunRecords keeps only the newest N per session", async () => {
    for (let i = 1; i <= 5; i++) await upsertRunRecord(row("s1", i, i * 10))
    await pruneRunRecords("s1", 2)
    expect((await listRunRecords("s1")).map((r) => r.runId)).toEqual([5, 4])
  })

  it("deleteRunRecordsForSession clears just that session", async () => {
    await upsertRunRecord(row("s1", 1, 100))
    await upsertRunRecord(row("s2", 1, 100))
    await deleteRunRecordsForSession("s1")
    expect(await listRunRecords("s1")).toHaveLength(0)
    expect(await listRunRecords("s2")).toHaveLength(1)
  })
})

describe("runRecordRowFromView", () => {
  const view = (overrides: Partial<RunRecordView> = {}): RunRecordView => ({
    sessionId: "s1",
    runId: 3,
    status: "running",
    timing: { startedAt: 500, pausedAt: null, pausedAccumMs: 0 },
    tools: [],
    runningTools: [],
    subagentParts: [],
    subagentIds: [],
    todos: [],
    todoCounts: { done: 0, total: 0 },
    counts: { tools: 0, subagents: 0 },
    ...overrides,
  })

  it("returns null when the view has no runId", () => {
    expect(runRecordRowFromView(view({ runId: null }), 1000)).toBeNull()
  })

  it("does not stamp settledAt for a running run", () => {
    const r = runRecordRowFromView(view({ status: "running" }), 1000)
    expect(r?.settledAt).toBeUndefined()
    expect(r?.startedAt).toBe(500)
  })

  it("stamps settledAt for a terminal status and falls back to now for startedAt", () => {
    const r = runRecordRowFromView(
      view({ status: "done", timing: { startedAt: null, pausedAt: null, pausedAccumMs: 0 } }),
      1000
    )
    expect(r?.settledAt).toBe(1000)
    expect(r?.startedAt).toBe(1000)
  })

  it("slims tools and subagent parts into serializable snapshots", () => {
    const r = runRecordRowFromView(
      view({
        tools: [
          {
            id: "t1",
            toolName: "Bash",
            part: { type: "tool-Bash" } as never,
            status: "output-available",
            startedAt: 10,
            endedAt: 40,
            resultSummary: null,
          },
        ],
        subagentParts: [{ subagentId: "sa1", name: "reviewer", status: "running" } as never],
        counts: { tools: 1, subagents: 1 },
      }),
      1000
    )
    expect(r?.tools).toEqual([
      { id: "t1", toolName: "Bash", status: "output-available", startedAt: 10, endedAt: 40 },
    ])
    expect(r?.subagents).toEqual([{ subagentId: "sa1", name: "reviewer", status: "running" }])
  })
})
