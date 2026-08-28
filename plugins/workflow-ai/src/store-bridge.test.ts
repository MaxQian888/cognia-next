import { EditorNotOpenError, formatToolError, resolveStore } from "./store-bridge"
import {
  createEditorStore,
  listEditorStores,
  registerEditorStore,
  unregisterEditorStore,
} from "@cognia/plugin-sdk/api/workflow-editor"
import type { VisualWorkflow } from "@cognia/plugin-sdk"
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

// Unregister what is actually registered rather than wiping the registry: the
// host's reset is not on the author surface, and `unregisterEditorStore` is
// what an editor calls when it closes.
beforeEach(() => {
  for (const { workflowId } of listEditorStores()) unregisterEditorStore(workflowId)
})

describe("resolveStore", () => {
  it("returns the explicitly-named store when present", () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    expect(resolveStore({ workflowId: "wf_a" }).store).toBe(store)
  })

  it("falls back to the sole open editor when workflowId is omitted", () => {
    const store = createEditorStore(workflow("wf_only"))
    registerEditorStore("wf_only", store)
    const resolved = resolveStore({})
    expect(resolved.store).toBe(store)
    expect(resolved.workflowId).toBe("wf_only")
  })

  it("throws not-open when no editor is registered", () => {
    expect(() => resolveStore({ workflowId: "wf_missing" })).toThrow(EditorNotOpenError)
  })

  it("throws ambiguous when multiple editors are open without an explicit id", () => {
    registerEditorStore("wf_a", createEditorStore(workflow("wf_a")))
    registerEditorStore("wf_b", createEditorStore(workflow("wf_b")))
    expect(() => resolveStore({})).toThrow(EditorNotOpenError)
  })
})

describe("formatToolError", () => {
  it("normalizes EditorNotOpenError into the structured payload", () => {
    const err = new EditorNotOpenError({ kind: "not-open", requestedId: "wf_x" })
    expect(formatToolError(err)).toMatchObject({
      ok: false,
      error: { code: "editor-not-open" },
    })
  })

  it("normalizes thrown Error into tool-execution-failed", () => {
    expect(formatToolError(new Error("oops"))).toEqual({
      ok: false,
      error: { code: "tool-execution-failed", message: "oops" },
    })
  })

  it("normalizes thrown primitives into tool-execution-failed", () => {
    expect(formatToolError("string thrown")).toEqual({
      ok: false,
      error: { code: "tool-execution-failed", message: "string thrown" },
    })
  })
})
