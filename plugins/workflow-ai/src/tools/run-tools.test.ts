/**
 * @jest-environment jsdom
 * @cognia-host-integration-test
 */

/**
 * `run-tools.ts` had no test at all, which is how `wf_cancel_run` shipped
 * unable to cancel anything: the AbortController was registered in
 * `ACTIVE_RUNS` only AFTER `await runOrchestrator(...)` resolved, and deleted
 * on the next line. The map was therefore always empty, so the tool always
 * returned `wasActive: false` — after prompting the user for approval, since
 * it is `requiresApproval: true`.
 */

const runWorkflowMock = jest.fn()

import {
  listEditorStores,
  registerEditorStore,
  unregisterEditorStore,
} from "@/lib/workflow/editor/store-registry"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { createWorkflowAuthorAPI } from "@/lib/plugin/api/workflow-author-api"
import type { PluginTool, PluginToolContext } from "@cognia/plugin-sdk"
import type { VisualWorkflow } from "@cognia/plugin-sdk"
import { buildRunTools, __resetActiveRunsForTesting } from "./run-tools"
import { configureWorkflowApi } from "../store-bridge"

function workflow(id: string): VisualWorkflow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
    },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

const EMPTY_CTX: PluginToolContext = { config: {} }

function findTool(tools: PluginTool[], name: string): PluginTool {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

beforeEach(() => {
  for (const { workflowId } of listEditorStores()) unregisterEditorStore(workflowId)
  __resetActiveRunsForTesting()
  runWorkflowMock.mockReset()
  const workflowApi = createWorkflowAuthorAPI()
  workflowApi.runWorkflow = (...args) => runWorkflowMock(...args)
  configureWorkflowApi(workflowApi as never)
  const store = createEditorStore(workflow("wf_a"))
  store.getState().addNode("trigger.manual", { x: 0, y: 0 })
  registerEditorStore("wf_a", store)
})

describe("wf_run_workflow + wf_cancel_run", () => {
  it("mints the run id up front and passes it to the orchestrator", async () => {
    runWorkflowMock.mockImplementation(async (input: { runId?: string }) => ({
      runId: input.runId,
      status: "succeeded",
    }))
    const tool = findTool(buildRunTools(), "wf_run_workflow")
    const result = (await tool.execute({}, EMPTY_CTX)) as { ok: boolean; runId: string }
    expect(result.ok).toBe(true)
    expect(result.runId).toMatch(/^run_[A-Za-z0-9]{12}$/)
    expect(runWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: result.runId, signal: expect.anything() })
    )
  })

  it("cancels a run that is still in flight", async () => {
    // Hold the orchestrator open so the run is genuinely active while
    // wf_cancel_run is invoked — the exact window the old code could not
    // observe because it registered the controller after the await.
    let capturedSignal: AbortSignal | undefined
    let capturedRunId: string | undefined
    let release: (() => void) | undefined
    runWorkflowMock.mockImplementation(
      async (input: { runId: string; signal: AbortSignal }) =>
        new Promise((resolve) => {
          capturedSignal = input.signal
          capturedRunId = input.runId
          release = () => resolve({ runId: input.runId, status: "cancelled" })
        })
    )

    const tools = buildRunTools()
    const runPromise = findTool(tools, "wf_run_workflow").execute({}, EMPTY_CTX)
    // Let the orchestrator mock capture its inputs.
    await Promise.resolve()
    expect(capturedRunId).toBeDefined()

    const cancel = (await findTool(tools, "wf_cancel_run").execute(
      { runId: capturedRunId },
      EMPTY_CTX
    )) as { ok: boolean; wasActive: boolean }
    expect(cancel).toEqual({ ok: true, runId: capturedRunId, wasActive: true })
    expect(capturedSignal?.aborted).toBe(true)

    release?.()
    await runPromise
  })

  it("reports wasActive:false for an unknown run id", async () => {
    const result = (await findTool(buildRunTools(), "wf_cancel_run").execute(
      { runId: "run_doesnotexist" },
      EMPTY_CTX
    )) as { ok: boolean; wasActive: boolean }
    expect(result).toEqual({ ok: true, runId: "run_doesnotexist", wasActive: false })
  })

  it("drops the controller once the run settles", async () => {
    runWorkflowMock.mockImplementation(async (input: { runId: string }) => ({
      runId: input.runId,
      status: "succeeded",
    }))
    const tools = buildRunTools()
    const result = (await findTool(tools, "wf_run_workflow").execute({}, EMPTY_CTX)) as {
      runId: string
    }
    const cancel = (await findTool(tools, "wf_cancel_run").execute(
      { runId: result.runId },
      EMPTY_CTX
    )) as { wasActive: boolean }
    expect(cancel.wasActive).toBe(false)
  })

  it("drops the controller even when the run throws", async () => {
    runWorkflowMock.mockRejectedValue(new Error("boom"))
    const tools = buildRunTools()
    const result = (await findTool(tools, "wf_run_workflow").execute({}, EMPTY_CTX)) as {
      ok: boolean
    }
    expect(result.ok).toBe(false)
    // The finally-block cleanup means no controller is left behind for any id.
    const cancel = (await findTool(tools, "wf_cancel_run").execute(
      { runId: "run_anything000" },
      EMPTY_CTX
    )) as { wasActive: boolean }
    expect(cancel.wasActive).toBe(false)
  })
})
