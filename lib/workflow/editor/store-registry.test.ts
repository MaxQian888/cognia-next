import {
  __resetRegistryForTesting,
  getEditorStore,
  listEditorStores,
  registerEditorStore,
  subscribeEditorStores,
  unregisterEditorStore,
} from "./store-registry"
import { createEditorStore, type EditorStore } from "./store"
import type { VisualWorkflow } from "@/types/workflow/visual"

function makeWorkflow(id: string): VisualWorkflow {
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

beforeEach(() => {
  __resetRegistryForTesting()
})

describe("store-registry", () => {
  it("returns null when no editor is registered", () => {
    expect(getEditorStore("wf_missing")).toBeNull()
  })

  it("registers, retrieves, and unregisters a store", () => {
    const store: EditorStore = createEditorStore(makeWorkflow("wf_a"))
    registerEditorStore("wf_a", store)
    expect(getEditorStore("wf_a")).toBe(store)
    unregisterEditorStore("wf_a")
    expect(getEditorStore("wf_a")).toBeNull()
  })

  it("listEditorStores returns every currently-registered pair", () => {
    const a = createEditorStore(makeWorkflow("wf_a"))
    const b = createEditorStore(makeWorkflow("wf_b"))
    registerEditorStore("wf_a", a)
    registerEditorStore("wf_b", b)
    const pairs = listEditorStores()
    expect(pairs.map((p) => p.workflowId).sort()).toEqual(["wf_a", "wf_b"])
  })

  it("re-registering the same store is a no-op (no listener churn)", () => {
    const store = createEditorStore(makeWorkflow("wf_a"))
    let fired = 0
    const unsubscribe = subscribeEditorStores(() => {
      fired++
    })
    registerEditorStore("wf_a", store)
    expect(fired).toBe(1)
    registerEditorStore("wf_a", store)
    expect(fired).toBe(1)
    unsubscribe()
  })

  it("re-registering a DIFFERENT store overwrites and notifies", () => {
    const first = createEditorStore(makeWorkflow("wf_a"))
    const second = createEditorStore(makeWorkflow("wf_a"))
    registerEditorStore("wf_a", first)
    let fired = 0
    const unsubscribe = subscribeEditorStores(() => {
      fired++
    })
    registerEditorStore("wf_a", second)
    expect(getEditorStore("wf_a")).toBe(second)
    expect(fired).toBe(1)
    unsubscribe()
  })

  it("subscribeEditorStores receives mutations and the unsubscribe stops them", () => {
    const store = createEditorStore(makeWorkflow("wf_a"))
    const events: string[] = []
    const unsubscribe = subscribeEditorStores(() => events.push("change"))
    registerEditorStore("wf_a", store)
    unregisterEditorStore("wf_a")
    expect(events.length).toBe(2)
    unsubscribe()
    registerEditorStore("wf_a", store)
    expect(events.length).toBe(2)
  })

  it("unregister of an unknown id is a no-op (no notify)", () => {
    let fired = 0
    const unsubscribe = subscribeEditorStores(() => {
      fired++
    })
    unregisterEditorStore("wf_never_registered")
    expect(fired).toBe(0)
    unsubscribe()
  })
})
