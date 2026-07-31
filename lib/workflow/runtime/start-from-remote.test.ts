import { startWorkflowFromRemote } from "./start-from-remote"

const runWorkflow = jest.fn()
jest.mock("./orchestrator", () => ({ runWorkflow: (...a: unknown[]) => runWorkflow(...a) }))
const getWorkflow = jest.fn()
jest.mock("@/lib/db/workflows", () => ({ getWorkflow: (...a: unknown[]) => getWorkflow(...a) }))

describe("startWorkflowFromRemote", () => {
  beforeEach(() => jest.clearAllMocks())

  it("returns not-found when the workflow is missing", async () => {
    getWorkflow.mockResolvedValue(undefined)
    const r = await startWorkflowFromRemote({ workflowId: "wf_x", runParams: {} })
    expect(r).toEqual({ ok: false, reason: "workflow-not-found", workflowId: "wf_x" })
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it("fires runWorkflow with source api and returns a runId synchronously", async () => {
    getWorkflow.mockResolvedValue({ id: "wf_1", nodes: [], edges: [] })
    const r = await startWorkflowFromRemote({ workflowId: "wf_1", runParams: { a: 1 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(typeof r.runId).toBe("string")
    expect(runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeredBy: expect.objectContaining({ source: "api" }),
        trigger: expect.objectContaining({ kind: "trigger.manual", payload: { a: 1 } }),
      })
    )
  })

  it("stamps the caller deviceId into triggeredBy when provided (ADR-0060)", async () => {
    getWorkflow.mockResolvedValue({ id: "wf_1", nodes: [], edges: [] })
    await startWorkflowFromRemote({ workflowId: "wf_1", deviceId: "dev-42" })
    expect(runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: { source: "api", deviceId: "dev-42" } })
    )
  })

  it("omits deviceId from triggeredBy when the dispatch layer doesn't know it", async () => {
    getWorkflow.mockResolvedValue({ id: "wf_1", nodes: [], edges: [] })
    await startWorkflowFromRemote({ workflowId: "wf_1" })
    expect(runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: { source: "api" } })
    )
  })

  it("honors a caller-supplied runId so the audit layer can correlate", async () => {
    getWorkflow.mockResolvedValue({ id: "wf_1", nodes: [], edges: [] })
    const r = await startWorkflowFromRemote({ workflowId: "wf_1", runId: "run_fixed" })
    expect(r).toEqual({ ok: true, runId: "run_fixed" })
    expect(runWorkflow).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_fixed" }))
  })
})
