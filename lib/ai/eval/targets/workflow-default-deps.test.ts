jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: jest.fn(async (id: string) => ({ id, nodes: [], edges: [] })),
}))
jest.mock("@/lib/db/workflow-deployments", () => ({
  getWorkflowVersion: jest.fn(async (id: string) => ({
    id,
    workflowId: "wf1",
    definition: { id: "wf1", name: "Pinned", nodes: [], edges: [] },
  })),
}))
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: jest.fn(async () => ({
    runId: "wfrun_1",
    status: "succeeded",
    output: { ok: true },
  })),
}))
jest.mock("@/lib/db/agent-traces", () => ({ queryByTrace: jest.fn(async () => []) }))
jest.mock("@/lib/workflow/definition/migrate", () => ({
  migrateWorkflow: (workflow: unknown) => workflow,
}))

import { defaultWorkflowTargetDeps } from "./workflow-default-deps"
import { getWorkflow } from "@/lib/db/workflows"
import { getWorkflowVersion } from "@/lib/db/workflow-deployments"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { queryByTrace } from "@/lib/db/agent-traces"
import type { EvalPersistenceScope } from "@/lib/db/eval-lab"

const mockGetWorkflow = getWorkflow as jest.Mock
const mockGetWorkflowVersion = getWorkflowVersion as jest.Mock
const mockRunWorkflow = runWorkflow as jest.Mock
const mockQueryByTrace = queryByTrace as jest.Mock

describe("defaultWorkflowTargetDeps.runWorkflow", () => {
  beforeEach(() => jest.clearAllMocks())

  it("does not dispatch when the account changes during workflow resolution", async () => {
    let active = true
    const scope = {
      db: { workflows: { get: mockGetWorkflow } },
      assertActive: () => {
        if (!active) throw new Error("Evaluation scope changed")
      },
    } as unknown as EvalPersistenceScope
    mockGetWorkflow.mockImplementationOnce(async () => {
      active = false
      return { id: "wf1", nodes: [], edges: [] }
    })
    await expect(
      defaultWorkflowTargetDeps(scope).runWorkflow({
        workflowId: "wf1",
        payload: {},
        traceId: "tr",
      })
    ).rejects.toThrow("Evaluation scope changed")
    expect(mockRunWorkflow).not.toHaveBeenCalled()
  })

  it("does not resolve a workflow or dispatch when imports finish after cancellation", async () => {
    const controller = new AbortController()
    const run = defaultWorkflowTargetDeps().runWorkflow({
      workflowId: "wf1",
      payload: {},
      traceId: "tr",
      signal: controller.signal,
    })
    controller.abort()
    await expect(run).rejects.toThrow()
    expect(mockGetWorkflow).not.toHaveBeenCalled()
    expect(mockRunWorkflow).not.toHaveBeenCalled()
  })

  it("loads the workflow, runs it with a manual trigger + threaded trace id", async () => {
    const deps = defaultWorkflowTargetDeps()
    const out = await deps.runWorkflow({
      workflowId: "wf1",
      payload: { input: "go" },
      traceId: "tr",
    })
    expect(out.runId).toBe("wfrun_1")
    expect(out.status).toBe("succeeded")
    expect(out.output).toEqual({ ok: true })
    expect(out.traceId).toBe("tr")
    const passed = mockRunWorkflow.mock.calls[0][0] as {
      traceId: string
      trigger: { kind: string; payload: unknown }
    }
    expect(passed.traceId).toBe("tr")
    expect(passed.trigger.kind).toBe("trigger.manual")
    expect(passed.trigger.payload).toEqual({ input: "go" })
  })

  it("throws on a missing workflow", async () => {
    mockGetWorkflow.mockResolvedValueOnce(undefined as never)
    const deps = defaultWorkflowTargetDeps()
    await expect(
      deps.runWorkflow({ workflowId: "nope", payload: {}, traceId: "tr" })
    ).rejects.toThrow(/not found/)
  })

  it("loads an exact immutable workflow version when the eval target pins one", async () => {
    const deps = defaultWorkflowTargetDeps()
    await deps.runWorkflow({
      workflowId: "wf1",
      versionId: "version_1",
      payload: {},
      traceId: "tr-version",
    })

    expect(mockGetWorkflowVersion).toHaveBeenCalledWith("version_1")
    expect(mockGetWorkflow).not.toHaveBeenCalled()
    expect(mockRunWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ workflow: expect.objectContaining({ name: "Pinned" }) })
    )
  })

  it("delegates fetchSpansByTrace to queryByTrace", async () => {
    const deps = defaultWorkflowTargetDeps()
    await deps.fetchSpansByTrace("tr")
    expect(mockQueryByTrace).toHaveBeenCalledWith("tr")
  })

  it("uses the pinned workflow version and trace database without global reads", async () => {
    const version = {
      workflowId: "wf1",
      definition: { id: "wf1", name: "Scoped", nodes: [], edges: [] },
    }
    const get = jest.fn(async () => version)
    const toArray = jest.fn(async () => [])
    const between = jest.fn(() => ({ toArray }))
    const where = jest.fn(() => ({ between }))
    const scope = {
      db: { workflowVersions: { get }, agentTraces: { where } },
      assertActive: jest.fn(),
    } as unknown as EvalPersistenceScope
    const deps = defaultWorkflowTargetDeps(scope)
    await deps.runWorkflow({ workflowId: "wf1", versionId: "v1", payload: {}, traceId: "tr" })
    await deps.fetchSpansByTrace("tr")
    expect(get).toHaveBeenCalledWith("v1")
    expect(mockGetWorkflowVersion).not.toHaveBeenCalled()
    expect(mockGetWorkflow).not.toHaveBeenCalled()
    expect(mockQueryByTrace).not.toHaveBeenCalled()
    expect(where).toHaveBeenCalledWith("[traceId+startTime]")
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: version.definition })
    )
  })
})
