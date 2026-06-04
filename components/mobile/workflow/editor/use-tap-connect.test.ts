/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { act, renderHook } from "@testing-library/react"

import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { useTapConnect } from "./use-tap-connect"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_tap",
    schemaVersion: 1,
    name: "Tap",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "trigger",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Trigger", params: {} },
      },
      {
        id: "ai_a",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "AI A", params: {} },
      },
      {
        id: "ai_b",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 400, y: 0 },
        data: { label: "AI B", params: {} },
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

function setup(): { store: EditorStore; result: { current: ReturnType<typeof useTapConnect> } } {
  const store = createEditorStore(buildWorkflow())
  const { result } = renderHook(() => useTapConnect(store))
  return { store, result }
}

describe("useTapConnect", () => {
  it("starts inactive", () => {
    const { result } = setup()
    expect(result.current.active).toBe(false)
    expect(result.current.sourceId).toBeNull()
  })

  it("enters connect mode and sets connectionState on the store", () => {
    const { store, result } = setup()
    act(() => result.current.start("trigger"))
    expect(result.current.active).toBe(true)
    expect(result.current.sourceId).toBe("trigger")
    expect(store.getState().connectionState?.sourceId).toBe("trigger")
  })

  it("creates an edge and exits when completing a valid connection", () => {
    const { store, result } = setup()
    act(() => result.current.start("trigger"))
    let outcome: { valid: boolean } = { valid: false }
    act(() => {
      outcome = result.current.completeTo("ai_a")
    })
    expect(outcome.valid).toBe(true)
    const edges = store.getState().edges
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: "trigger", target: "ai_a" })
    // Connect mode cleared + connectionState torn down.
    expect(result.current.active).toBe(false)
    expect(store.getState().connectionState).toBeNull()
  })

  it("rejects connecting INTO a trigger and creates no edge", () => {
    const { store, result } = setup()
    act(() => result.current.start("ai_a"))
    let outcome: ReturnType<typeof result.current.completeTo> = { valid: false, reason: "", reasonKey: "" }
    act(() => {
      outcome = result.current.completeTo("trigger")
    })
    expect(outcome.valid).toBe(false)
    if (!outcome.valid) expect(outcome.reason).toMatch(/trigger/i)
    expect(store.getState().edges).toHaveLength(0)
    expect(result.current.active).toBe(false)
  })

  it("rejects a self-loop", () => {
    const { store, result } = setup()
    act(() => result.current.start("ai_a"))
    let outcome: ReturnType<typeof result.current.completeTo> = { valid: false, reason: "", reasonKey: "" }
    act(() => {
      outcome = result.current.completeTo("ai_a")
    })
    expect(outcome.valid).toBe(false)
    expect(store.getState().edges).toHaveLength(0)
  })

  it("cancel exits connect mode without creating an edge", () => {
    const { store, result } = setup()
    act(() => result.current.start("ai_a"))
    act(() => result.current.cancel())
    expect(result.current.active).toBe(false)
    expect(store.getState().connectionState).toBeNull()
    expect(store.getState().edges).toHaveLength(0)
  })

  it("completeTo is a no-op when not in connect mode", () => {
    const { store, result } = setup()
    let outcome: { valid: boolean } = { valid: true }
    act(() => {
      outcome = result.current.completeTo("ai_a")
    })
    expect(outcome.valid).toBe(false)
    expect(store.getState().edges).toHaveLength(0)
  })
})
