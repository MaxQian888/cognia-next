import { render, renderHook } from "@testing-library/react"
import { EditorStoreProvider, useEditorStore, useEditorStoreOrNull } from "./store-context"
import { createEditorStore, type EditorStore } from "./store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { __resetRegistryForTesting, getEditorStore } from "./store-registry"

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

beforeEach(() => {
  __resetRegistryForTesting()
})

describe("EditorStoreProvider / useEditorStore", () => {
  it("exposes the store via useEditorStore inside the provider", () => {
    const realStore: EditorStore = createEditorStore(workflow("wf_ctx_a"))
    const { result } = renderHook(() => useEditorStore(), {
      wrapper: ({ children }) => (
        <EditorStoreProvider store={realStore}>{children}</EditorStoreProvider>
      ),
    })
    expect(result.current).toBe(realStore)
    // Side-effect contract: the provider also registers the store in
    // the out-of-React registry so plugin tools can reach it.
    expect(getEditorStore("wf_ctx_a")).toBe(realStore)
  })

  it("returns null from useEditorStoreOrNull outside the provider", () => {
    const { result } = renderHook(() => useEditorStoreOrNull())
    expect(result.current).toBeNull()
  })

  it("throws from useEditorStore when no provider is mounted", () => {
    // jsdom + React 19 surfaces hook errors via the rendered tree; suppress
    // the noisy console output and assert on the thrown error directly.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    function Probe(): null {
      useEditorStore()
      return null
    }
    expect(() => render(<Probe />)).toThrow(
      /useEditorStore must be used inside <EditorStoreProvider>/
    )
    spy.mockRestore()
  })
})
