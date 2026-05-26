/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const replaceWorkflow = jest.fn(async (..._a: unknown[]) => {})
jest.mock("@/lib/db/workflows", () => ({
  replaceWorkflow: (...a: unknown[]) => replaceWorkflow(...a),
}))

const syncWorkflowTriggers = jest.fn(async (..._a: unknown[]) => {})
jest.mock("@/lib/workflow/runtime/webhook-bridge", () => ({
  syncWorkflowTriggers: (...a: unknown[]) => syncWorkflowTriggers(...a),
}))

import { persistEditorWorkflow } from "./persist-workflow"
import { createEditorStore } from "./store"
import type { VisualWorkflow } from "@/types/workflow/visual"

function buildWorkflow(nodeType: string): VisualWorkflow {
  return {
    id: "wf_persist",
    schemaVersion: 1,
    name: "Persist",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n1",
        type: nodeType as VisualWorkflow["nodes"][number]["type"],
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "N1", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

beforeEach(() => {
  replaceWorkflow.mockClear()
  syncWorkflowTriggers.mockClear()
})

describe("persistEditorWorkflow", () => {
  it("persists, syncs triggers, marks saved, and reports zero issues for a valid graph", async () => {
    const store = createEditorStore(buildWorkflow("trigger.manual"))
    store.getState().setName("Edited") // mark dirty
    expect(store.getState().dirty).toBe(true)

    const issueCount = await persistEditorWorkflow(store)

    expect(replaceWorkflow).toHaveBeenCalledTimes(1)
    expect(syncWorkflowTriggers).toHaveBeenCalledTimes(1)
    expect(store.getState().dirty).toBe(false)
    expect(issueCount).toBe(0)
  })

  it("reports the validation issue count for an invalid node", async () => {
    // ai.prompt with empty params is missing its required prompt → 1 issue.
    const store = createEditorStore(buildWorkflow("ai.prompt"))
    const issueCount = await persistEditorWorkflow(store)
    expect(issueCount).toBeGreaterThan(0)
    expect(replaceWorkflow).toHaveBeenCalledTimes(1)
  })

  it("does not throw when trigger sync fails", async () => {
    syncWorkflowTriggers.mockRejectedValueOnce(new Error("offline"))
    const store = createEditorStore(buildWorkflow("trigger.manual"))
    await expect(persistEditorWorkflow(store)).resolves.toBe(0)
  })
})
