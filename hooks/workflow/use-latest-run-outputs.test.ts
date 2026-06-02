/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getLatestRunOutputs, useLatestRunOutputs } from "./use-latest-run-outputs"
import type { WorkflowRunRow } from "@/types/workflow/visual"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeRun(
  id: string,
  workflowId: string,
  startedAt: number,
  status: WorkflowRunRow["status"]
): WorkflowRunRow {
  return {
    id,
    workflowId,
    status,
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt,
    workflowSnapshot: {} as WorkflowRunRow["workflowSnapshot"],
  }
}

async function seedRunWithStep(
  runId: string,
  workflowId: string,
  startedAt: number,
  status: WorkflowRunRow["status"],
  stepId: string,
  output: unknown
) {
  await getDb().workflowRuns.put(makeRun(runId, workflowId, startedAt, status))
  await getDb().workflowRunEvents.put({
    id: `evt_${runId}`,
    runId,
    ts: startedAt + 1,
    type: "step_completed",
    stepId,
    payload: { output },
  })
}

describe("getLatestRunOutputs", () => {
  it("returns {} when there is no workflow id", async () => {
    expect(await getLatestRunOutputs(undefined)).toEqual({})
  })

  it("returns {} when the workflow has no runs", async () => {
    expect(await getLatestRunOutputs("wf_none")).toEqual({})
  })

  it("default mode picks the latest SUCCEEDED run", async () => {
    await seedRunWithStep("run_ok", "wf_a", 100, "succeeded", "n_a", { v: 1 })
    await seedRunWithStep("run_fail", "wf_a", 200, "failed", "n_a", { v: 2 })
    const out = await getLatestRunOutputs("wf_a")
    expect(out).toEqual({ n_a: { v: 1 } })
  })

  it("anyStatus mode picks the latest run regardless of status", async () => {
    await seedRunWithStep("run_ok", "wf_a", 100, "succeeded", "n_a", { v: 1 })
    await seedRunWithStep("run_fail", "wf_a", 200, "failed", "n_a", { v: 2 })
    const out = await getLatestRunOutputs("wf_a", { anyStatus: true })
    expect(out).toEqual({ n_a: { v: 2 } })
  })

  it("only includes step_completed payloads carrying an output", async () => {
    await getDb().workflowRuns.put(makeRun("run_x", "wf_b", 50, "succeeded"))
    await getDb().workflowRunEvents.bulkPut([
      {
        id: "e1",
        runId: "run_x",
        ts: 51,
        type: "step_started",
        stepId: "n_a",
        payload: { params: {} },
      },
      {
        id: "e2",
        runId: "run_x",
        ts: 52,
        type: "step_completed",
        stepId: "n_a",
        payload: { output: { ok: true } },
      },
      { id: "e3", runId: "run_x", ts: 53, type: "run_log", payload: { message: "hi" } },
    ])
    expect(await getLatestRunOutputs("wf_b")).toEqual({ n_a: { ok: true } })
  })
})

describe("useLatestRunOutputs", () => {
  it("resolves the latest run outputs when enabled", async () => {
    await seedRunWithStep("run_ok", "wf_h", 10, "succeeded", "n_a", { hello: "world" })
    const { result } = renderHook(() => useLatestRunOutputs("wf_h", true, { anyStatus: true }))
    await waitFor(() => expect(result.current).toEqual({ n_a: { hello: "world" } }))
  })

  it("returns the default empty map while disabled", async () => {
    await seedRunWithStep("run_ok", "wf_h", 10, "succeeded", "n_a", { hello: "world" })
    const { result } = renderHook(() => useLatestRunOutputs("wf_h", false))
    expect(result.current).toEqual({})
  })
})
