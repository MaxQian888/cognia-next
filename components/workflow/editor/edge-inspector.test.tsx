/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

// Mock the Radix Select to a native <select> so `onValueChange` is driveable
// deterministically in jsdom (the real portal/pointer flow is flaky here).
jest.mock("@/components/ui/select", () => {
  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <select
      data-testid="edge-kind-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  )
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    Select,
    SelectItem,
    SelectTrigger: Passthrough,
    SelectContent: Passthrough,
    SelectValue: Passthrough,
  }
})

import { EdgeInspector } from "./edge-inspector"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Sample",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n_a",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Start", params: {} },
      },
      {
        id: "n_b",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt", params: {} },
      },
    ],
    edges: [{ id: "e1", source: "n_a", target: "n_b" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function mount(store: ReturnType<typeof createEditorStore>) {
  return render(
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      <EdgeInspector useStore={store} />
    </NextIntlClientProvider>
  )
}

function edgeById(store: ReturnType<typeof createEditorStore>, id: string) {
  return store.getState().edges.find((e) => e.id === id)!
}

describe("EdgeInspector", () => {
  it("resolves endpoint node labels for the selected edge", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedEdges(["e1"]))
    mount(store)
    expect(screen.getByTestId("edge-source")).toHaveTextContent("Start")
    expect(screen.getByTestId("edge-target")).toHaveTextContent("Prompt")
  })

  it("writes the label to both data.label (live) and top-level label (save)", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedEdges(["e1"]))
    mount(store)
    act(() => {
      fireEvent.change(screen.getByLabelText("Label"), { target: { value: "retry" } })
    })
    const e = edgeById(store, "e1")
    expect(e.label).toBe("retry")
    expect((e.data as { label?: string }).label).toBe("retry")
  })

  it("clearing the label stores undefined", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().setSelectedEdges(["e1"])
      store.getState().updateEdgeData("e1", { label: "x" })
    })
    mount(store)
    act(() => {
      fireEvent.change(screen.getByLabelText("Label"), { target: { value: "  " } })
    })
    const e = edgeById(store, "e1")
    expect(e.label).toBeUndefined()
    expect((e.data as { label?: string }).label).toBeUndefined()
  })

  it("writes the kind to both data.kind (live) and data.workflowKind (save)", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedEdges(["e1"]))
    mount(store)
    act(() => {
      fireEvent.change(screen.getByTestId("edge-kind-select"), { target: { value: "error" } })
    })
    const e = edgeById(store, "e1")
    expect((e.data as { kind?: string }).kind).toBe("error")
    expect((e.data as { workflowKind?: string }).workflowKind).toBe("error")
  })

  it("reverse swaps the edge source and target", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedEdges(["e1"]))
    mount(store)
    act(() => {
      fireEvent.click(screen.getByTestId("edge-reverse"))
    })
    const e = edgeById(store, "e1")
    expect(e.source).toBe("n_b")
    expect(e.target).toBe("n_a")
  })

  it("delete removes the selected edge", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedEdges(["e1"]))
    mount(store)
    act(() => {
      fireEvent.click(screen.getByTestId("edge-delete"))
    })
    expect(store.getState().edges).toHaveLength(0)
  })

  it("defaults kind to error and shows the hint for an error-handle edge", () => {
    const wf = buildWorkflow()
    wf.edges = [{ id: "e1", source: "n_a", sourceHandle: "error", target: "n_b" }]
    const store = createEditorStore(wf)
    act(() => store.getState().setSelectedEdges(["e1"]))
    mount(store)
    expect((screen.getByTestId("edge-kind-select") as HTMLSelectElement).value).toBe("error")
  })

  it("multi-edge selection shows a count and deletes all", () => {
    const wf = buildWorkflow()
    wf.edges = [
      { id: "e1", source: "n_a", target: "n_b" },
      { id: "e2", source: "n_b", target: "n_a" },
    ]
    const store = createEditorStore(wf)
    act(() => store.getState().setSelectedEdges(["e1", "e2"]))
    mount(store)
    expect(screen.getByTestId("workflow-edge-inspector")).toBeInTheDocument()
    act(() => {
      fireEvent.click(screen.getByTestId("edge-delete-all"))
    })
    expect(store.getState().edges).toHaveLength(0)
  })

  it("writes a comment to edge data and clears it to undefined when blanked", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedEdges(["e1"]))
    mount(store)
    act(() => {
      fireEvent.change(screen.getByTestId("edge-comment"), { target: { value: "needs review" } })
    })
    expect((edgeById(store, "e1").data as { comment?: string }).comment).toBe("needs review")
    act(() => {
      fireEvent.change(screen.getByTestId("edge-comment"), { target: { value: "   " } })
    })
    expect((edgeById(store, "e1").data as { comment?: string }).comment).toBeUndefined()
  })
})
