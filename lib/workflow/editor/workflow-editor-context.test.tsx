/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { act } from "react"
import type { EditorStore } from "./store"
import {
  WorkflowEditorProvider,
  useWorkflowEditor,
  type WorkflowEditorContextValue,
  type WorkflowQuickActionKind,
} from "./workflow-editor-context"

// A minimal stand-in for the editor store hook. The real EditorStore is a
// Zustand hook with a `temporal` slice attached; for context plumbing we
// only need the function reference identity to survive the round-trip.
const makeFakeStore = (): EditorStore =>
  (() => {
    /* fake selector — never invoked in these tests */
  }) as unknown as EditorStore

function Probe({ tag }: { tag: string }) {
  const ctx = useWorkflowEditor()
  if (!ctx) {
    return <div data-testid={`probe-${tag}`}>null</div>
  }
  return (
    <div data-testid={`probe-${tag}`}>
      <button
        type="button"
        onClick={() => void ctx.onQuickAction("validate")}
        data-testid={`probe-${tag}-validate`}
      >
        validate
      </button>
      <span data-testid={`probe-${tag}-has-store`}>{typeof ctx.useEditorStore}</span>
    </div>
  )
}

describe("WorkflowEditorContext", () => {
  it("returns null when consumed outside the provider", () => {
    render(<Probe tag="outside" />)
    expect(screen.getByTestId("probe-outside").textContent).toBe("null")
  })

  it("exposes the editor store + quick-action dispatcher inside the provider", () => {
    const onQuickAction = jest.fn<void, [WorkflowQuickActionKind]>()
    const useEditorStore = makeFakeStore()
    const value: WorkflowEditorContextValue = { useEditorStore, onQuickAction }
    render(
      <WorkflowEditorProvider value={value}>
        <Probe tag="inside" />
      </WorkflowEditorProvider>
    )
    expect(screen.getByTestId("probe-inside-has-store").textContent).toBe("function")
    act(() => {
      screen.getByTestId("probe-inside-validate").click()
    })
    expect(onQuickAction).toHaveBeenCalledTimes(1)
    expect(onQuickAction).toHaveBeenCalledWith("validate")
  })

  it("supports an async onQuickAction handler", async () => {
    const onQuickAction = jest.fn<Promise<void>, [WorkflowQuickActionKind]>().mockResolvedValue()
    const value: WorkflowEditorContextValue = { useEditorStore: makeFakeStore(), onQuickAction }
    render(
      <WorkflowEditorProvider value={value}>
        <Probe tag="async" />
      </WorkflowEditorProvider>
    )
    await act(async () => {
      screen.getByTestId("probe-async-validate").click()
    })
    expect(onQuickAction).toHaveBeenCalledWith("validate")
  })
})
