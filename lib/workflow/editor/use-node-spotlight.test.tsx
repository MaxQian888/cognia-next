/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

import { useNodeSpotlight } from "./use-node-spotlight"

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Test",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

function seed(): { store: EditorStore; ids: Record<string, string> } {
  const store = createEditorStore(makeWorkflow())
  const ai = store.getState().addNode("ai.prompt", { x: 100, y: 200 })
  store.getState().updateNodeData(ai, { label: "Summarise email" })
  const action = store.getState().addNode("action.skill.invoke", { x: 800, y: 200 })
  store.getState().updateNodeData(action, { label: "Send Slack message" })
  return { store, ids: { ai, action } }
}

function renderSpotlight(store: EditorStore, animationsEnabled = true) {
  const setCenter = jest.fn()
  const hook = renderHook(() =>
    useNodeSpotlight({ store, reactFlowInstance: { setCenter }, animationsEnabled })
  )
  return { hook, setCenter }
}

describe("useNodeSpotlight", () => {
  it("flattens id, label and kind into one haystack", () => {
    const { store, ids } = seed()
    const { hook } = renderSpotlight(store)

    const row = hook.result.current.rows.find((r) => r.id === ids.ai)!
    expect(row.value).toContain("summarise email")
    expect(row.value).toContain("ai.prompt")
    expect(row.value).toContain(ids.ai.toLowerCase())
  })

  it("filters case-insensitively and keeps everything on an empty query", () => {
    const { store, ids } = seed()
    const { hook } = renderSpotlight(store)

    expect(hook.result.current.filterRows("")).toHaveLength(2)
    expect(hook.result.current.filterRows("  ")).toHaveLength(2)
    expect(hook.result.current.filterRows("SLACK").map((r) => r.id)).toEqual([ids.action])
  })

  it("names the smallest group that contains a node", () => {
    const { store, ids } = seed()
    store
      .getState()
      .addNode(
        "annotation.group",
        { x: 0, y: 0 },
        { label: "Outer", params: { title: "Outer", width: 700, height: 700 } }
      )
    store
      .getState()
      .addNode(
        "annotation.group",
        { x: 0, y: 0 },
        { label: "Inner", params: { title: "Inner", width: 400, height: 400 } }
      )

    const { hook } = renderSpotlight(store)

    // The AI node sits at (100,200) with the default 240x80 box, so its centre
    // (220,240) is inside both groups. The tighter one wins.
    expect(hook.result.current.rows.find((r) => r.id === ids.ai)?.groupLabel).toBe("Inner")
    // The action node's centre is (920,240), outside both, so it gets no
    // breadcrumb at all rather than a misleading one.
    expect(hook.result.current.rows.find((r) => r.id === ids.action)?.groupLabel).toBe("")
  })

  it("centres, selects and pulses the revealed node", () => {
    const { store, ids } = seed()
    const { hook, setCenter } = renderSpotlight(store)

    act(() => hook.result.current.reveal(ids.ai))

    // Centre of a 240x80 node placed at (100, 200).
    expect(setCenter).toHaveBeenCalledWith(220, 240, { zoom: 1.2, duration: 240 })
    expect(store.getState().selectedNodeIds).toEqual([ids.ai])
    expect(store.getState().spotlightedNodeId).toBe(ids.ai)
  })

  it("skips animation entirely when the perf tier says so", () => {
    const { store, ids } = seed()
    const { hook, setCenter } = renderSpotlight(store, false)

    act(() => hook.result.current.reveal(ids.ai))

    expect(setCenter).toHaveBeenCalledWith(220, 240, { zoom: 1.2, duration: 0 })
  })

  it("does nothing for a node id that is no longer on the canvas", () => {
    const { store } = seed()
    const { hook, setCenter } = renderSpotlight(store)

    act(() => hook.result.current.reveal("node_gone"))

    expect(setCenter).not.toHaveBeenCalled()
    expect(store.getState().selectedNodeIds).toEqual([])
  })
})
