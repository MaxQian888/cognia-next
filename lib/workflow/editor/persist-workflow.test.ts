/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const replaceWorkflow = jest.fn(async (workflow: VisualWorkflow) => ({
  workflow: { ...workflow, updatedAt: 99 },
  publicationInvalidated: false,
}))
jest.mock("@/lib/db/workflows", () => ({
  replaceWorkflow: (...a: unknown[]) => replaceWorkflow(a[0] as VisualWorkflow),
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
})

describe("persistEditorWorkflow", () => {
  it("persists through the canonical database path, marks saved, and reports zero issues", async () => {
    const store = createEditorStore(buildWorkflow("trigger.manual"))
    store.getState().setName("Edited") // mark dirty
    expect(store.getState().dirty).toBe(true)

    const result = await persistEditorWorkflow(store)

    expect(replaceWorkflow).toHaveBeenCalledTimes(1)
    expect(store.getState().dirty).toBe(false)
    expect(store.getState().baseWorkflow.updatedAt).toBe(99)
    expect(result).toEqual({ issueCount: 0, publicationInvalidated: false })
  })

  it("reports the validation issue count for an invalid node", async () => {
    // ai.prompt with empty params is missing its required prompt → 1 issue.
    const store = createEditorStore(buildWorkflow("ai.prompt"))
    const result = await persistEditorWorkflow(store)
    expect(result.issueCount).toBeGreaterThan(0)
    expect(replaceWorkflow).toHaveBeenCalledTimes(1)
  })

  it("syncs an invalidated publication without resetting graph or selection state", async () => {
    const workflow = {
      ...buildWorkflow("trigger.manual"),
      published: { at: 1, toolName: "wf_persist" },
      interface: { inputSchema: { type: "object" } },
    }
    const store = createEditorStore(workflow)
    store.getState().setSelectedNodes(["n1"])
    store.getState().setName("Edited")
    const historyLength = store.temporal.getState().pastStates.length
    replaceWorkflow.mockResolvedValueOnce({
      workflow: {
        ...store.getState().toWorkflow(),
        updatedAt: 100,
        published: undefined,
        interface: undefined,
      },
      publicationInvalidated: true,
    })

    const result = await persistEditorWorkflow(store)

    expect(result.publicationInvalidated).toBe(true)
    expect(store.getState().baseWorkflow.published).toBeUndefined()
    expect(store.getState().baseWorkflow.interface).toBeUndefined()
    expect(store.getState().selectedNodeIds).toEqual(["n1"])
    expect(store.getState().nodes).toHaveLength(1)
    expect(store.temporal.getState().pastStates).toHaveLength(historyLength)
  })
})
