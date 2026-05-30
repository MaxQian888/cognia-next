/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { BulkNodeInspector } from "./bulk-node-inspector"

const MESSAGES = {
  workflows: {
    inspector: {
      bulk: {
        title: "{count} nodes selected",
        disabled: "Disabled",
        disabledHint: "Skip during runs",
        disabledMixed: "Some on, some off",
        notes: "Notes",
        notesHint: "Applies to all",
        notesPlaceholder: "Shared note…",
        notesApply: "Apply to all",
        notesClear: "Clear all",
        deleteAll: "Delete {count}",
        deleteAllConfirm: "Delete {count} nodes? This cannot be undone in one step.",
        cancel: "Cancel",
        clearSelection: "Clear selection",
      },
    },
    validation: {},
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
        data: { label: "A", params: {} },
      },
      {
        id: "n_b",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "B", params: {} },
      },
      {
        id: "n_c",
        type: "data.code",
        typeVersion: 1,
        position: { x: 400, y: 0 },
        data: { label: "C", params: {} },
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

function mount(store: ReturnType<typeof createEditorStore>) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never} timeZone="UTC">
      <BulkNodeInspector useStore={store} />
    </NextIntlClientProvider>
  )
}

describe("BulkNodeInspector", () => {
  it("shows the selection count", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedNodes(["n_a", "n_b"]))
    mount(store)
    expect(screen.getByText("2 nodes selected")).toBeInTheDocument()
  })

  it("toggling disabled patches the whole selection in one undo entry", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedNodes(["n_a", "n_b"]))
    mount(store)
    const before = store.temporal.getState().pastStates.length

    act(() => {
      fireEvent.click(screen.getByTestId("bulk-disabled-switch"))
    })

    const byId = (id: string) => store.getState().nodes.find((n) => n.id === id)!
    expect(byId("n_a").data.disabled).toBe(true)
    expect(byId("n_b").data.disabled).toBe(true)
    expect(byId("n_c").data.disabled).toBeUndefined()
    expect(store.temporal.getState().pastStates.length).toBe(before + 1)
  })

  it("shows the mixed hint when the selection has mixed disabled state", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => {
      store.getState().updateNodeData("n_a", { disabled: true })
      store.getState().setSelectedNodes(["n_a", "n_b"])
    })
    mount(store)
    expect(
      screen.getByText("Some selected nodes are disabled — toggle to set all the same.")
    ).toBeInTheDocument()
  })

  it("applies and clears notes across the selection", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedNodes(["n_a", "n_b"]))
    mount(store)

    act(() => {
      fireEvent.change(
        screen.getByTestId("workflow-bulk-inspector").querySelector("#bulk-notes")!,
        {
          target: { value: "shared" },
        }
      )
    })
    act(() => {
      fireEvent.click(screen.getByTestId("bulk-notes-apply"))
    })
    const byId = (id: string) => store.getState().nodes.find((n) => n.id === id)!
    expect(byId("n_a").data.notes).toBe("shared")
    expect(byId("n_b").data.notes).toBe("shared")

    act(() => {
      fireEvent.click(screen.getByTestId("bulk-notes-clear"))
    })
    expect(byId("n_a").data.notes).toBeUndefined()
    expect(byId("n_b").data.notes).toBeUndefined()
  })

  it("bulk delete removes every selected node after confirmation", () => {
    const store = createEditorStore(buildWorkflow())
    act(() => store.getState().setSelectedNodes(["n_a", "n_b"]))
    mount(store)

    act(() => {
      fireEvent.click(screen.getByTestId("bulk-delete-all"))
    })
    act(() => {
      fireEvent.click(screen.getByTestId("bulk-delete-all-confirm"))
    })
    expect(store.getState().nodes.map((n) => n.id)).toEqual(["n_c"])
  })
})
