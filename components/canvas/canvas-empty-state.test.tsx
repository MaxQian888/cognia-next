/**
 * @jest-environment jsdom
 *
 * Tests for CanvasEmptyState — confirms the Empty primitive shell is used
 * and the CTA creates a new canvas document via the store.
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CanvasEmptyState } from "./canvas-empty-state"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

function resetStore() {
  act(() => {
    const docs = Object.keys(useArtifactStore.getState().canvasDocuments)
    docs.forEach((id) => useArtifactStore.getState().deleteCanvasDocument(id))
    useArtifactStore.getState().setActiveCanvas(null)
  })
}

describe("CanvasEmptyState", () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetStore()
  })

  it("renders the welcome title and description from canvas.empty", () => {
    render(<CanvasEmptyState />)
    expect(screen.getByText(/Welcome to Canvas/i)).toBeInTheDocument()
    expect(screen.getByText(/Monaco-powered editor/i)).toBeInTheDocument()
  })

  it("renders inside the Empty primitive (data-slot=empty)", () => {
    const { container } = render(<CanvasEmptyState />)
    expect(container.querySelector('[data-slot="empty"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="empty-header"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="empty-icon"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="empty-title"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="empty-description"]')).toBeInTheDocument()
    expect(container.querySelector('[data-slot="empty-content"]')).toBeInTheDocument()
  })

  it("creates a new canvas document when the CTA is clicked", async () => {
    const user = userEvent.setup()
    render(<CanvasEmptyState />)
    expect(Object.values(useArtifactStore.getState().canvasDocuments)).toHaveLength(0)

    // The CTA raises the new-document dialog, which is where the document's
    // type, language, starter and import source are chosen.
    await user.click(screen.getByRole("button", { name: /Create your first document/i }))
    expect(screen.getByTestId("canvas-new-document-dialog")).toBeInTheDocument()

    await user.click(screen.getByTestId("canvas-new-create"))
    const docs = Object.values(useArtifactStore.getState().canvasDocuments)
    expect(docs).toHaveLength(1)
    expect(useArtifactStore.getState().activeCanvasId).toBe(docs[0]!.id)
  })
})
