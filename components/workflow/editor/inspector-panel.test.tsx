/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

// The dedicated per-kind config form would mount heavy UI (Monaco for the
// raw-JSON editor, scheme-form etc.); stub it with a button that just
// forwards `onChange` so we can drive the debounce path deterministically.
const mockConfigChanges = jest.fn()
jest.mock("./inspector/node-config-registry", () => ({
  getNodeConfigComponentForEntry: () =>
    function MockNodeConfig({
      params,
      onChange,
    }: {
      params: Record<string, unknown>
      onChange: (next: Record<string, unknown>) => void
    }) {
      mockConfigChanges(params)
      return (
        <button
          type="button"
          data-testid="mock-node-config-trigger"
          onClick={() => onChange({ ...params, hit: (Number(params.hit) || 0) + 1 })}
        >
          edit-config
        </button>
      )
    },
  hasDedicatedConfigForEntry: () => true,
}))

// Imported after the mock so the InspectorPanel resolves to the stubbed
// registry above.
import { InspectorPanel } from "./inspector-panel"

const MESSAGES = {
  workflows: {
    inspector: {
      empty: "Pick a node",
      closeAria: "Close inspector",
      label: "Label",
      notes: "Notes",
      notesHint: "Optional",
      disabled: "Disabled",
      disabledHint: "Skip during runs",
      deleteNode: "Delete node",
      categoryBadge: {
        trigger: "Trigger",
        action: "Action",
        ai: "AI",
        flow: "Flow",
        data: "Data",
        io: "I/O",
        annotation: "Note",
      },
      errorBadge: "{count} issue(s)",
      noConfigYet: "No config yet",
    },
    nodes: {},
  },
}

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
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Prompt A", params: {} },
      },
      {
        id: "n_b",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt B", params: {} },
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

function mountInspector(store: ReturnType<typeof createEditorStore>) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never} timeZone="UTC">
      <InspectorPanel useStore={store} />
    </NextIntlClientProvider>
  )
}

describe("InspectorPanel", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockConfigChanges.mockClear()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it("renders the empty placeholder when no node is selected", () => {
    const store = createEditorStore(buildWorkflow())
    mountInspector(store)
    expect(screen.getByTestId("workflow-inspector-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("workflow-inspector")).toBeNull()
  })

  it("renders the form for the selected node", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)
    expect(screen.getByTestId("workflow-inspector")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Prompt A")).toBeInTheDocument()
  })

  it("debounces revalidate across multiple keystrokes (single trailing fire)", () => {
    const store = createEditorStore(buildWorkflow())
    const revalidateSpy = jest.spyOn(store.getState(), "revalidateNode")
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)

    const trigger = screen.getByTestId("mock-node-config-trigger")
    act(() => {
      trigger.click()
      trigger.click()
      trigger.click()
    })
    // Three "keystrokes" — debouncer hasn't fired yet.
    expect(revalidateSpy).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(150)
    })
    expect(revalidateSpy).toHaveBeenCalledTimes(1)
    expect(revalidateSpy).toHaveBeenCalledWith("n_a")
  })

  it("flushes the pending revalidate when the user picks a different node", () => {
    const store = createEditorStore(buildWorkflow())
    const revalidateSpy = jest.spyOn(store.getState(), "revalidateNode")
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)

    const trigger = screen.getByTestId("mock-node-config-trigger")
    act(() => {
      trigger.click()
    })
    expect(revalidateSpy).not.toHaveBeenCalled()

    // Selection switches before the 150ms window closes → flush must fire
    // for the previous node so its in-flight validation isn't lost.
    act(() => {
      store.getState().setSelectedNodes(["n_b"])
    })
    expect(revalidateSpy).toHaveBeenCalledTimes(1)
    expect(revalidateSpy).toHaveBeenCalledWith("n_a")
  })

  it("does not re-render the memoized config form when an unrelated node is mutated", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().setSelectedNodes(["n_a"])
    })
    mountInspector(store)

    // Initial mount already renders the form once.
    const initialRenderCount = mockConfigChanges.mock.calls.length
    expect(initialRenderCount).toBeGreaterThan(0)

    // Mutate the *other* node — selectedId stays "n_a", n_a's data stays
    // identical, so the InspectorPanel's narrow selectors stay shallow-
    // equal and the memoized NodeConfigFormSection must not re-render.
    act(() => {
      store.getState().updateNodeData("n_b", { label: "Renamed B" })
    })

    expect(mockConfigChanges.mock.calls.length).toBe(initialRenderCount)
  })

  it("is wrapped in React.memo so identical-prop parent renders are bailed out", () => {
    const memoMarker = Symbol.for("react.memo")
    expect((InspectorPanel as { $$typeof?: symbol }).$$typeof).toBe(memoMarker)
  })
})
