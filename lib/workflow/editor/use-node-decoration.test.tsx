/**
 * @jest-environment jsdom
 */
import { render, screen, act } from "@testing-library/react"
import { useNodeDecoration } from "./use-node-decoration"
import { createEditorStore, type EditorStore } from "./store"
import { EditorStoreProvider } from "./store-context"
import type { VisualWorkflow } from "@/types/workflow/visual"

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Test",
    description: "",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
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

function Probe({ nodeId, onRender }: { nodeId: string; onRender: (renders: number) => void }) {
  const decoration = useNodeDecoration(nodeId)
  // Re-renders are tracked by incrementing the parent's counter ref.
  onRender(1)
  return (
    <div data-testid={`probe-${nodeId}`}>
      <span data-testid="status">{decoration.runStatus ?? "none"}</span>
      <span data-testid="hasValidation">{decoration.validation ? "yes" : "no"}</span>
      <span data-testid="lastRunStatus">{decoration.lastRun?.status ?? "none"}</span>
    </div>
  )
}

describe("useNodeDecoration", () => {
  it("returns the empty decoration when no provider is mounted", () => {
    render(<Probe nodeId="n1" onRender={() => {}} />)
    expect(screen.getByTestId("status")).toHaveTextContent("none")
    expect(screen.getByTestId("hasValidation")).toHaveTextContent("no")
    expect(screen.getByTestId("lastRunStatus")).toHaveTextContent("none")
  })

  it("reads runStatus / validation / lastRun for the matching node id", () => {
    const store: EditorStore = createEditorStore(makeWorkflow())
    act(() => {
      store.setState({
        runStatusByStepId: { n1: "running" },
        validationByStepId: {
          n1: {
            fields: { name: { key: "required" } },
            summary: ["name required"],
            hasErrors: true,
          },
        },
        lastRunByStepId: {
          n1: { status: "succeeded", startedAt: 1, finishedAt: 2, durationMs: 1, attempt: 1 },
        },
      })
    })
    render(
      <EditorStoreProvider store={store}>
        <Probe nodeId="n1" onRender={() => {}} />
      </EditorStoreProvider>
    )
    expect(screen.getByTestId("status")).toHaveTextContent("running")
    expect(screen.getByTestId("hasValidation")).toHaveTextContent("yes")
    expect(screen.getByTestId("lastRunStatus")).toHaveTextContent("succeeded")
  })

  it("only re-renders when one of THIS node's three keys changes", () => {
    const store: EditorStore = createEditorStore(makeWorkflow())
    let renders = 0
    render(
      <EditorStoreProvider store={store}>
        <Probe nodeId="n1" onRender={() => renders++} />
      </EditorStoreProvider>
    )
    const initial = renders

    // Touching ANOTHER node's status MUST NOT re-render this probe.
    act(() => {
      store.setState({ runStatusByStepId: { n2: "running" } })
    })
    expect(renders).toBe(initial)

    // Touching unrelated state (e.g., dirty flag) MUST NOT re-render.
    act(() => {
      store.setState({ dirty: !store.getState().dirty })
    })
    expect(renders).toBe(initial)

    // Touching THIS node's status MUST re-render exactly once.
    act(() => {
      store.setState({ runStatusByStepId: { n1: "succeeded", n2: "running" } })
    })
    expect(renders).toBe(initial + 1)
    expect(screen.getByTestId("status")).toHaveTextContent("succeeded")
  })
})
