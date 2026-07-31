/**
 * @jest-environment jsdom
 *
 * Tests for CanvasPreviewPane — confirms the document is projected to an
 * Artifact and handed to the (mocked) ArtifactPreview, and that empty /
 * unsupported documents show the right hint instead.
 */

import { act, render, screen } from "@testing-library/react"
import { CanvasPreviewPane } from "./canvas-preview-pane"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

// Isolate the wrapper from the heavy sandboxed preview stack.
jest.mock("@/components/artifacts/artifact-preview", () => ({
  ArtifactPreview: ({ artifact }: { artifact: { type: string; content: string } }) => (
    <div data-testid="mock-artifact-preview" data-type={artifact.type}>
      {artifact.content}
    </div>
  ),
}))

function resetStore() {
  act(() => {
    Object.keys(useArtifactStore.getState().canvasDocuments).forEach((id) =>
      useArtifactStore.getState().deleteCanvasDocument(id)
    )
    useArtifactStore.getState().setActiveCanvas(null)
  })
}

function seedDoc(
  overrides: Parameters<ReturnType<typeof useArtifactStore.getState>["createCanvasDocument"]>[0]
) {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createCanvasDocument(overrides)
  })
  return id
}

describe("CanvasPreviewPane", () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetStore()
  })

  it("projects a markdown document and renders ArtifactPreview as a document", () => {
    const id = seedDoc({ title: "Notes", content: "# Hi", language: "markdown", type: "text" })
    render(<CanvasPreviewPane documentId={id} />)
    const preview = screen.getByTestId("mock-artifact-preview")
    expect(preview).toHaveAttribute("data-type", "document")
    expect(preview).toHaveTextContent("# Hi")
  })

  it("renders an html document as an html preview", () => {
    const id = seedDoc({
      title: "Page",
      content: "<b>hi</b>",
      language: "html",
      type: "code",
    })
    render(<CanvasPreviewPane documentId={id} />)
    expect(screen.getByTestId("mock-artifact-preview")).toHaveAttribute("data-type", "html")
  })

  it("shows the empty hint when the document has no content", () => {
    const id = seedDoc({ title: "Empty", content: "   ", language: "markdown", type: "text" })
    render(<CanvasPreviewPane documentId={id} />)
    expect(screen.getByTestId("canvas-preview-empty")).toBeInTheDocument()
    expect(screen.getByText(/Nothing to preview yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId("mock-artifact-preview")).not.toBeInTheDocument()
  })

  it("shows an unsupported hint for a non-previewable language", () => {
    const id = seedDoc({ title: "Script", content: "print(1)", language: "python", type: "code" })
    render(<CanvasPreviewPane documentId={id} />)
    expect(screen.getByText(/No live preview for python/i)).toBeInTheDocument()
  })

  it("shows the empty hint for an unknown document id", () => {
    render(<CanvasPreviewPane documentId="missing" />)
    expect(screen.getByTestId("canvas-preview-empty")).toBeInTheDocument()
  })
})
