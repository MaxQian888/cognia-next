/**
 * @jest-environment jsdom
 */
import {
  createEditorStore,
  listEditorStores,
  registerEditorStore,
  unregisterEditorStore,
} from "@cognia/plugin-sdk/api/workflow-editor"
import type { VisualWorkflow } from "@cognia/plugin-sdk"
import type { PluginTool, PluginToolContext } from "@cognia/plugin-sdk"
import { buildDiagnosticTools } from "./diagnostic-tools"

const EMPTY_CTX: PluginToolContext = { config: {} }

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

function findTool(tools: PluginTool[], name: string): PluginTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

beforeEach(() => {
  for (const { workflowId } of listEditorStores()) unregisterEditorStore(workflowId)
})

describe("wf_explain_validation", () => {
  it("returns an empty issues list when the canvas is clean", async () => {
    const store = createEditorStore(workflow("wf_a"))
    store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildDiagnosticTools(), "wf_explain_validation")
    const result = (await tool.execute({ workflowId: "wf_a" }, EMPTY_CTX)) as {
      ok: true
      issues: unknown[]
    }
    expect(result).toEqual({ ok: true, workflowId: "wf_a", issues: [] })
  })

  it("surfaces per-node issues with jumpToNodeId and suggestion", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("trigger.cron", { x: 0, y: 0 }, { label: "Hourly" })
    store.getState().setValidation(id, {
      fields: { cron: { key: "cronExpr" } },
      summary: ["Invalid cron expression"],
      hasErrors: true,
    })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildDiagnosticTools(), "wf_explain_validation")
    const result = (await tool.execute({ workflowId: "wf_a" }, EMPTY_CTX)) as {
      ok: true
      issues: Array<{
        nodeId: string
        nodeLabel: string
        nodeKind: string
        severity: string
        blocking: boolean
        suggestion: string
        jumpToNodeId: string
      }>
    }
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      nodeId: id,
      nodeLabel: "Hourly",
      nodeKind: "trigger.cron",
      severity: "error",
      blocking: true,
      jumpToNodeId: id,
    })
    expect(result.issues[0].suggestion).toMatch(/cron/i)
  })

  it("returns ok:false when no editor is open", async () => {
    const tool = findTool(buildDiagnosticTools(), "wf_explain_validation")
    const result = (await tool.execute({}, EMPTY_CTX)) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("editor-not-open")
  })
})

describe("wf_explain_last_run", () => {
  it("reports 'no-run' when the workflow has not been executed", async () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    const tool = findTool(buildDiagnosticTools(), "wf_explain_last_run")
    const result = (await tool.execute({ workflowId: "wf_a" }, EMPTY_CTX)) as {
      ok: true
      status: string
      counts: { succeeded: number; failed: number; skipped: number }
    }
    expect(result.ok).toBe(true)
    expect(result.status).toBe("no-run")
    expect(result.counts).toEqual({ succeeded: 0, failed: 0, skipped: 0 })
  })

  it("pinpoints the failing step with errorSummary + suggestion", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("ai.prompt", { x: 0, y: 0 }, { label: "Fetch" })
    store.getState().setLastRunByStepId({
      [id]: {
        status: "failed",
        startedAt: 0,
        finishedAt: 10,
        durationMs: 10,
        attempt: 1,
        errorMessage: "Request timeout after 30s",
      },
    })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildDiagnosticTools(), "wf_explain_last_run")
    const result = (await tool.execute({ workflowId: "wf_a" }, EMPTY_CTX)) as {
      ok: true
      status: string
      failedStepId?: string
      failedStepLabel?: string
      errorSummary?: string
      suggestion?: string
      jumpToNodeId?: string
    }
    expect(result.status).toBe("failed")
    expect(result.failedStepId).toBe(id)
    expect(result.failedStepLabel).toBe("Fetch")
    expect(result.errorSummary).toBe("Request timeout after 30s")
    expect(result.suggestion).toMatch(/timeout/i)
    expect(result.jumpToNodeId).toBe(id)
  })
})
