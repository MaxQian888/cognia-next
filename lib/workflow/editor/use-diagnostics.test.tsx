/**
 * @jest-environment jsdom
 */
import type { ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import { createEditorStore } from "./store"
import { EditorStoreProvider } from "./store-context"
import {
  useDiagnosticsSummary,
  useDiagnosticsList,
  useNodeDiagnostics,
  useEdgeDiagnostics,
} from "./use-diagnostics"
import type { EditorStore } from "./store"
import type { VisualWorkflow } from "@/types/workflow/visual"

function workflowWithUnknownRef(): VisualWorkflow {
  return {
    id: "wf_diag",
    schemaVersion: 1,
    name: "Diag",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "t",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Run", params: {} },
      },
      {
        id: "p",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt", params: { userPrompt: "{{ $node['ghost'].out.x }}" } },
      },
    ],
    edges: [{ id: "e1", source: "t", target: "p" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function wrapperFor(store: EditorStore) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EditorStoreProvider store={store}>{children}</EditorStoreProvider>
  }
}

describe("use-diagnostics hooks", () => {
  it("returns empty/zeroed values without a provider", () => {
    expect(renderHook(() => useDiagnosticsSummary()).result.current).toEqual({
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
    })
    expect(renderHook(() => useDiagnosticsList()).result.current).toEqual([])
    expect(renderHook(() => useNodeDiagnostics("x")).result.current).toEqual([])
    expect(renderHook(() => useEdgeDiagnostics("x")).result.current).toEqual([])
  })

  it("surfaces the seeded diagnostics through the summary and list", () => {
    const store = createEditorStore(workflowWithUnknownRef())
    const wrapper = wrapperFor(store)
    const { result: summary } = renderHook(() => useDiagnosticsSummary(), { wrapper })
    expect(summary.current.errorCount).toBeGreaterThanOrEqual(1)
    const { result: list } = renderHook(() => useDiagnosticsList(), { wrapper })
    expect(list.current.some((d) => d.code === "exprUnknownNode")).toBe(true)
  })

  it("scopes node diagnostics to the referencing node", () => {
    const store = createEditorStore(workflowWithUnknownRef())
    const wrapper = wrapperFor(store)
    const { result } = renderHook(() => useNodeDiagnostics("p"), { wrapper })
    expect(result.current.some((d) => d.code === "exprUnknownNode")).toBe(true)
    const { result: clean } = renderHook(() => useNodeDiagnostics("t"), { wrapper })
    expect(clean.current).toEqual([])
  })
})
