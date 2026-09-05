/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const actionsRef = {
  current: {
    running: false,
    actionType: null as string | null,
    output: "",
    error: null as string | null,
    errorKind: null as string | null,
    cancellable: false,
    retryable: false,
    run: jest.fn(),
    stream: jest.fn(),
    cancel: jest.fn(),
    retry: jest.fn(async () => ""),
    reset: jest.fn(),
  },
}
jest.mock("./canvas-actions-context", () => ({
  useSharedCanvasActions: () => actionsRef.current,
}))

import { CanvasAiPanel } from "./canvas-ai-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

function seedDoc() {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "body",
      language: "markdown",
      type: "text",
    })
  })
  return id
}

function resetActions() {
  actionsRef.current = {
    ...actionsRef.current,
    running: false,
    actionType: null,
    output: "",
    error: null,
    errorKind: null,
    cancellable: false,
    retryable: false,
  }
  actionsRef.current.cancel = jest.fn()
  actionsRef.current.retry = jest.fn(async () => "")
}

beforeEach(() => {
  window.localStorage.clear()
  act(() => {
    for (const id of Object.keys(useArtifactStore.getState().canvasDocuments)) {
      useArtifactStore.getState().deleteCanvasDocument(id)
    }
  })
  resetActions()
})

describe("CanvasAiPanel", () => {
  it("persists the draft instruction on the document", async () => {
    // The draft used to live in component state and vanish on every document
    // switch, even though `CanvasAIWorkbenchState.promptDraft` existed.
    const user = userEvent.setup()
    const id = seedDoc()
    render(<CanvasAiPanel documentId={id} />)

    await user.type(screen.getByTestId("canvas-ai-prompt"), "tighten this")

    expect(useArtifactStore.getState().canvasDocuments[id]?.aiWorkbench?.promptDraft).toBe(
      "tighten this"
    )
  })

  it("does not reorder the rail when the draft changes", async () => {
    // Writing the draft through `updateCanvasDocument` would bump `updatedAt`
    // on every keystroke and move the document to the top of the rail.
    const user = userEvent.setup()
    const id = seedDoc()
    const before = useArtifactStore.getState().canvasDocuments[id]!.updatedAt
    render(<CanvasAiPanel documentId={id} />)

    await user.type(screen.getByTestId("canvas-ai-prompt"), "x")

    expect(useArtifactStore.getState().canvasDocuments[id]!.updatedAt).toEqual(before)
  })

  it("records the chosen preset and dispatches the action", async () => {
    const user = userEvent.setup()
    const id = seedDoc()
    const dispatched: Array<{ type?: string }> = []
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<{ type?: string }>).detail)
    }
    window.addEventListener("canvas-action", handler)
    render(<CanvasAiPanel documentId={id} />)

    await user.click(screen.getByTestId("canvas-ai-preset-explain"))

    window.removeEventListener("canvas-action", handler)
    expect(dispatched[0]).toMatchObject({ type: "explain", proposalFirst: true })
    expect(useArtifactStore.getState().canvasDocuments[id]?.aiWorkbench?.selectedPresetAction).toBe(
      "explain"
    )
  })

  it("sends a bare instruction as the custom action", async () => {
    const user = userEvent.setup()
    const id = seedDoc()
    const dispatched: Array<{ type?: string; prompt?: string }> = []
    const handler = (event: Event) => {
      dispatched.push((event as CustomEvent<{ type?: string; prompt?: string }>).detail)
    }
    window.addEventListener("canvas-action", handler)
    render(<CanvasAiPanel documentId={id} />)

    await user.type(screen.getByTestId("canvas-ai-prompt"), "make it shorter")
    await user.click(screen.getByTestId("canvas-ai-submit"))

    window.removeEventListener("canvas-action", handler)
    expect(dispatched[0]).toMatchObject({ type: "custom", prompt: "make it shorter" })
  })

  it("renders the narrative output that used to be discarded", () => {
    // `explain` and `review` returned text into a `useState` in the editor pane
    // that nothing read.
    const id = seedDoc()
    actionsRef.current.output = "Here is what the code does."
    render(<CanvasAiPanel documentId={id} />)

    expect(screen.getByTestId("canvas-ai-output")).toHaveTextContent("Here is what the code does.")
  })

  it("offers a stop while a run is cancellable", async () => {
    const user = userEvent.setup()
    const id = seedDoc()
    actionsRef.current.running = true
    actionsRef.current.cancellable = true
    render(<CanvasAiPanel documentId={id} />)

    await user.click(screen.getByTestId("canvas-ai-cancel"))

    expect(actionsRef.current.cancel).toHaveBeenCalled()
  })

  it("offers a retry only for a failure a retry could fix", () => {
    const id = seedDoc()
    actionsRef.current.error = "network"
    actionsRef.current.errorKind = "failed"
    actionsRef.current.retryable = true
    const { rerender } = render(<CanvasAiPanel documentId={id} />)
    expect(screen.getByTestId("canvas-ai-retry")).toBeInTheDocument()

    actionsRef.current = {
      ...actionsRef.current,
      errorKind: "pii-blocked",
      retryable: false,
    }
    rerender(<CanvasAiPanel documentId={id} />)
    expect(screen.queryByTestId("canvas-ai-retry")).not.toBeInTheDocument()
  })

  it("explains a redaction refusal instead of showing the raw message", () => {
    const id = seedDoc()
    actionsRef.current.error = "Canvas action blocked by PII gate"
    actionsRef.current.errorKind = "pii-blocked"
    render(<CanvasAiPanel documentId={id} />)

    expect(screen.getByTestId("canvas-ai-error")).toHaveTextContent(/personal or secret data/i)
  })

  it("lists staged attachments and can drop one", async () => {
    const user = userEvent.setup()
    const id = seedDoc()
    act(() => {
      useArtifactStore.getState().updateCanvasWorkbench(id, {
        attachments: [
          {
            id: "a1",
            sourceType: "artifact",
            sourceId: "art_1",
            label: "Spec",
            snapshot: "s",
          },
        ],
      })
    })
    render(<CanvasAiPanel documentId={id} />)
    expect(screen.getByTestId("canvas-ai-attachments")).toHaveTextContent("Spec")

    await user.click(screen.getByRole("button", { name: /Remove Spec/i }))

    expect(useArtifactStore.getState().canvasDocuments[id]?.aiWorkbench?.attachments).toEqual([])
  })

  it("replays a past instruction from the history", async () => {
    const user = userEvent.setup()
    const id = seedDoc()
    act(() => {
      useArtifactStore.getState().appendCanvasActionHistory(id, {
        id: "h1",
        requestId: "h1",
        actionType: "improve",
        prompt: "make it friendlier",
        scope: "document",
        entryPoint: "toolbar",
        createdAt: new Date(),
        status: "completed",
        attachmentSummary: [],
      })
    })
    render(<CanvasAiPanel documentId={id} />)

    await user.click(screen.getByText("make it friendlier"))

    const workbench = useArtifactStore.getState().canvasDocuments[id]?.aiWorkbench
    expect(workbench?.promptDraft).toBe("make it friendlier")
    expect(workbench?.selectedPresetAction).toBe("improve")
  })

  it("disables the presets while a run is in flight", () => {
    const id = seedDoc()
    actionsRef.current.running = true
    render(<CanvasAiPanel documentId={id} />)
    expect(screen.getByTestId("canvas-ai-preset-fix")).toBeDisabled()
  })
})
