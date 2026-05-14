import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  _clearWorkflowAudit,
  listWorkflowAudit,
  pruneWorkflowAudit,
  recordWorkflowAudit,
} from "./workflow-audit"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await _clearWorkflowAudit()
})

describe("workflow-audit", () => {
  it("records and returns rows by workflow id", async () => {
    await recordWorkflowAudit({
      workflowId: "wf_a",
      runId: "run_1",
      kind: "run_started",
      source: "workflow",
    })
    await recordWorkflowAudit({
      workflowId: "wf_a",
      runId: "run_1",
      kind: "run_completed",
      source: "workflow",
    })
    const rows = await listWorkflowAudit({ workflowId: "wf_a" })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.kind)).toEqual(["run_completed", "run_started"])
  })

  it("filters by source and kind", async () => {
    await recordWorkflowAudit({ workflowId: "x", kind: "run_started", source: "workflow" })
    await recordWorkflowAudit({
      workflowId: "x",
      kind: "step_failed",
      source: "step",
      stepId: "n1",
    })
    await recordWorkflowAudit({
      workflowId: "x",
      kind: "trigger_dispatched",
      source: "trigger",
    })
    expect(
      (await listWorkflowAudit({ workflowId: "x", source: "step" })).map((r) => r.kind)
    ).toEqual(["step_failed"])
    expect(await listWorkflowAudit({ workflowId: "x", kind: "run_started" })).toHaveLength(1)
  })

  it("supports failedOnly filter", async () => {
    await recordWorkflowAudit({ workflowId: "x", kind: "run_started", source: "workflow" })
    await recordWorkflowAudit({ workflowId: "x", kind: "run_failed", source: "workflow" })
    await recordWorkflowAudit({ workflowId: "x", kind: "step_failed", source: "step" })
    const rows = await listWorkflowAudit({ workflowId: "x", failedOnly: true })
    expect(rows.map((r) => r.kind).sort()).toEqual(["run_failed", "step_failed"])
  })

  it("filters by runId index", async () => {
    await recordWorkflowAudit({
      workflowId: "a",
      runId: "r1",
      kind: "run_started",
      source: "workflow",
    })
    await recordWorkflowAudit({
      workflowId: "a",
      runId: "r2",
      kind: "run_started",
      source: "workflow",
    })
    const rows = await listWorkflowAudit({ runId: "r2" })
    expect(rows).toHaveLength(1)
    expect(rows[0].runId).toBe("r2")
  })

  it("orders by ts descending", async () => {
    await recordWorkflowAudit({
      workflowId: "x",
      kind: "run_started",
      source: "workflow",
      ts: 100,
    })
    await recordWorkflowAudit({
      workflowId: "x",
      kind: "run_completed",
      source: "workflow",
      ts: 300,
    })
    await recordWorkflowAudit({
      workflowId: "x",
      kind: "run_failed",
      source: "workflow",
      ts: 200,
    })
    const rows = await listWorkflowAudit({})
    expect(rows.map((r) => r.ts)).toEqual([300, 200, 100])
  })

  it("respects time-range filter", async () => {
    await recordWorkflowAudit({
      workflowId: "x",
      kind: "run_started",
      source: "workflow",
      ts: 100,
    })
    await recordWorkflowAudit({
      workflowId: "x",
      kind: "run_completed",
      source: "workflow",
      ts: 200,
    })
    const rows = await listWorkflowAudit({ fromTs: 150, toTs: 250 })
    expect(rows).toHaveLength(1)
    expect(rows[0].ts).toBe(200)
  })

  it("pruneWorkflowAudit caps the table at 5000 rows", async () => {
    const rows = Array.from({ length: 5100 }, (_, i) => ({
      ts: i + 1,
      kind: "run_started" as const,
      source: "workflow" as const,
    }))
    await getDb().workflowAudit.bulkPut(rows)
    const deleted = await pruneWorkflowAudit()
    expect(deleted).toBe(100)
    expect(await getDb().workflowAudit.count()).toBe(5000)
    const remaining = await getDb().workflowAudit.orderBy("ts").limit(1).toArray()
    // Oldest remaining row's ts is 101 — rows 1..100 were dropped.
    expect(remaining[0].ts).toBe(101)
  })

  it("recordWorkflowAudit never throws on schema errors", async () => {
    // Force the underlying put to throw and confirm the helper returns null.
    const spy = jest.spyOn(getDb().workflowAudit, "put").mockImplementation(() => {
      throw new Error("db gone")
    })
    const out = await recordWorkflowAudit({ kind: "run_started", source: "workflow" })
    expect(out).toBeNull()
    spy.mockRestore()
  })
})
