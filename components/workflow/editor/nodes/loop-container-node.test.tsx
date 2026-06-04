/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { LoopContainerNode } from "./loop-container-node"

// Stub React Flow's DOM-measuring pieces (same approach as workflow-node.test).
jest.mock("@xyflow/react", () => ({
  __esModule: true,
  Handle: ({ className, ...rest }: { className?: string; "data-testid"?: string }) => (
    <span className={className} {...rest} />
  ),
  Position: { Left: "left", Right: "right" },
  NodeResizer: ({ isVisible }: { isVisible?: boolean }) => (
    <span data-testid="node-resizer" data-visible={isVisible ? "true" : "false"} />
  ),
}))

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 2,
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

function renderContainer({
  id = "loop1",
  selected = false,
  params = { mode: "forEach", source: "{{ $trigger.payload.items }}" } as Record<string, unknown>,
  store,
}: {
  id?: string
  selected?: boolean
  params?: Record<string, unknown>
  store?: EditorStore
} = {}) {
  const ui = (
    <LoopContainerNode
      id={id}
      type="loopContainer"
      selected={selected}
      data={{ label: "My Loop", params, kind: "flow.loop", typeVersion: 2 }}
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      dragging={false}
      zIndex={0}
      isConnectable={true}
      deletable={true}
      selectable={true}
      draggable={true}
    />
  )
  return render(store ? <EditorStoreProvider store={store}>{ui}</EditorStoreProvider> : ui)
}

describe("LoopContainerNode", () => {
  it("renders the label, mode badge, and drop-zone hint", () => {
    renderContainer()
    expect(screen.getByText("My Loop")).toBeInTheDocument()
    expect(screen.getByTestId("loop-container-mode")).toHaveTextContent(/for each/i)
    expect(screen.getByTestId("loop-container-dropzone")).toBeInTheDocument()
  })

  it("renders input and output handles", () => {
    renderContainer()
    expect(screen.getByTestId("loop-container-target-loop1")).toBeInTheDocument()
    expect(screen.getByTestId("loop-container-source-loop1")).toBeInTheDocument()
  })

  it("shows the resizer only when selected", () => {
    renderContainer({ selected: false })
    expect(screen.getByTestId("node-resizer").getAttribute("data-visible")).toBe("false")
  })

  it("shows the resizer when selected", () => {
    renderContainer({ selected: true })
    expect(screen.getByTestId("node-resizer").getAttribute("data-visible")).toBe("true")
  })

  it("renders the iteration badge for times mode", () => {
    renderContainer({ params: { mode: "times", times: 5 } })
    expect(screen.getByTestId("loop-container-mode")).toHaveTextContent("5")
  })

  it("works inside a store provider too", () => {
    const store = createEditorStore(makeWorkflow())
    renderContainer({ store })
    expect(screen.getByText("My Loop")).toBeInTheDocument()
  })
})
