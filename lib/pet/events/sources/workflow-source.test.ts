import { runStatusToEmit, wireWorkflowSource } from "./workflow-source"
import type { RowObserver } from "./goal-source"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"
import type { PetEvent } from "@/types/pet"

function run(id: string, status: RunStatus): WorkflowRunRow {
  return { id, status, startedAt: 1 } as WorkflowRunRow
}

describe("runStatusToEmit", () => {
  it("maps running/succeeded/failed and ignores the rest", () => {
    expect(runStatusToEmit("running")).toMatchObject({ kind: "workflowRun" })
    expect(runStatusToEmit("succeeded")).toMatchObject({ kind: "success", xp: 6 })
    expect(runStatusToEmit("failed")).toMatchObject({ kind: "error" })
    expect(runStatusToEmit("pending")).toBeNull()
    expect(runStatusToEmit("paused")).toBeNull()
  })
})

describe("wireWorkflowSource", () => {
  it("detects in-place status flips and new runs after the initial row", () => {
    let push: (rows: WorkflowRunRow[]) => void = () => {}
    const observe: RowObserver<WorkflowRunRow> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireWorkflowSource((e) => events.push({ ...e, at: 0 }), observe)

    push([run("r1", "running")]) // pre-existing → ignored
    push([run("r1", "succeeded")]) // in-place flip → success
    push([run("r1", "succeeded")]) // unchanged → ignored
    push([run("r2", "running")]) // new run → workflowRun
    push([run("r2", "failed")]) // → error
    push([]) // empty → ignored

    expect(events.map((e) => e.kind)).toEqual(["success", "workflowRun", "error"])
  })
})
