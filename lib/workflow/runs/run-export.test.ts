/** @jest-environment jsdom */
import { downloadRunExport, downloadRunsCsv, downloadRunsJson, runsToCsv } from "./run-export"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type WorkflowRunEventRow,
  type WorkflowRunRow,
} from "@/types/workflow/visual"

function run(patch: Partial<WorkflowRunRow> & Pick<WorkflowRunRow, "id">): WorkflowRunRow {
  return {
    workflowId: "wf",
    status: "succeeded",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 0,
    workflowSnapshot: {
      id: "wf",
      schemaVersion: 2,
      name: "wf",
      createdAt: 0,
      updatedAt: 0,
      nodes: [],
      edges: [],
      settings: DEFAULT_WORKFLOW_SETTINGS,
    },
    ...patch,
  }
}

describe("runsToCsv", () => {
  it("emits a header and one row per run", () => {
    const csv = runsToCsv([
      run({ id: "r1", status: "succeeded", startedAt: 0, completedAt: 1500 }),
      run({ id: "r2", status: "failed", startedAt: 0, error: { message: "boom" } }),
    ])
    const lines = csv.split("\n")
    expect(lines[0]).toBe("id,status,triggerKind,startedAt,completedAt,durationMs,error")
    expect(lines[1]).toBe(
      "r1,succeeded,trigger.manual,1970-01-01T00:00:00.000Z,1970-01-01T00:00:01.500Z,1500,"
    )
    expect(lines[2]).toBe("r2,failed,trigger.manual,1970-01-01T00:00:00.000Z,,,boom")
  })

  it("quotes cells containing commas, quotes, or newlines", () => {
    const csv = runsToCsv([run({ id: "r1", error: { message: 'a,b "c"\nd' } })])
    expect(csv.split("\n").slice(1).join("\n")).toContain('"a,b ""c""')
  })

  it("handles an empty run set (header only)", () => {
    expect(runsToCsv([])).toBe("id,status,triggerKind,startedAt,completedAt,durationMs,error")
  })
})

describe("download helpers", () => {
  let clickSpy: jest.SpyInstance
  let revoked: string[]
  const created: string[] = []
  const origCreate = (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL
  const origRevoke = (URL as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL

  beforeEach(() => {
    created.length = 0
    revoked = []
    // jsdom lacks object-URL APIs — install fakes for the duration of the test.
    ;(URL as { createObjectURL: unknown }).createObjectURL = jest.fn(() => "blob:mock")
    ;(URL as { revokeObjectURL: unknown }).revokeObjectURL = jest.fn((u: string) => revoked.push(u))
    clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      created.push(this.download)
    })
  })
  afterEach(() => {
    ;(URL as { createObjectURL?: unknown }).createObjectURL = origCreate
    ;(URL as { revokeObjectURL?: unknown }).revokeObjectURL = origRevoke
    clickSpy.mockRestore()
  })

  it("downloadRunsCsv triggers a .csv download with a safe name", () => {
    downloadRunsCsv([run({ id: "r1" })], "My Flow!")
    expect(created).toEqual(["My_Flow_-runs.csv"])
    expect(revoked).toEqual(["blob:mock"])
  })

  it("downloadRunsJson triggers a .json download", () => {
    downloadRunsJson([run({ id: "r1" })], "Flow")
    expect(created).toEqual(["Flow-runs.json"])
  })

  it("downloadRunExport names the file after the run id", () => {
    const events: WorkflowRunEventRow[] = [
      { id: "e1", runId: "r1", ts: 1, type: "step_started", stepId: "s1" },
    ]
    downloadRunExport(run({ id: "r1" }), events, "Flow")
    expect(created).toEqual(["Flow-run-r1.json"])
  })
})
