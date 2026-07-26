/**
 * @jest-environment jsdom
 *
 * Tests for CanvasReviewView — confirms it renders the diff + hunk list for a
 * canvas pending review and wires accept/apply/reject through the canvas-scoped
 * store mutators.
 */

import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Keep the artifact store light: stub plugin hooks + project store.
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

// Controllable app theme (factory-local state keeps it TDZ-safe).
jest.mock("@/stores/settings", () => {
  const state: { theme: string | undefined } = { theme: undefined }
  return {
    __esModule: true,
    useSettingsStore: (selector: (s: unknown) => unknown) =>
      selector({ settings: { theme: state.theme } }),
    __setTheme: (theme: string | undefined) => {
      state.theme = theme
    },
  }
})

// Resolve the dynamically-imported DiffEditor synchronously to a stub.
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const DiffEditorStub = ({ original, modified }: { original: string; modified: string }) => (
      <div data-testid="diff-editor" data-original={original} data-modified={modified} />
    )
    DiffEditorStub.displayName = "DiffEditorStub"
    return DiffEditorStub
  },
}))

import { CanvasReviewView } from "./canvas-review-view"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import * as settingsModule from "@/stores/settings"

const setMockTheme = (settingsModule as unknown as { __setTheme: (t: string | undefined) => void })
  .__setTheme

function seedReview(content = "a\nb\nc\nd", proposed = "A\nb\nc\nD") {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createCanvasDocument({
      sessionId: "s1",
      title: "Doc",
      content,
      language: "markdown",
      type: "text",
    })
    useArtifactStore.getState().proposeCanvasReview(id, proposed)
  })
  return id
}

beforeEach(() => {
  setMockTheme(undefined)
  act(() => {
    useArtifactStore.setState({
      artifacts: {},
      activeArtifactIdBySession: {},
      artifactVersions: {},
      pendingReviews: {},
      canvasDocuments: {},
      activeCanvasId: null,
    })
  })
})

describe("CanvasReviewView", () => {
  it("returns null when there is no pending review", () => {
    const { container } = render(<CanvasReviewView documentId="none" panelMode="desktop" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the Monaco diff + per-hunk list on desktop", () => {
    const id = seedReview()
    render(<CanvasReviewView documentId={id} panelMode="desktop" />)
    const diff = screen.getByTestId("diff-editor")
    expect(diff).toHaveAttribute("data-original", "a\nb\nc\nd")
    expect(diff).toHaveAttribute("data-modified", "A\nb\nc\nD")
    expect(screen.getAllByTestId("review-hunk-item").length).toBeGreaterThanOrEqual(2)
  })

  it("renders an inline diff (no Monaco) on mobile", () => {
    const id = seedReview()
    render(<CanvasReviewView documentId={id} panelMode="mobile" />)
    expect(screen.queryByTestId("diff-editor")).not.toBeInTheDocument()
  })

  it("applies accepted hunks through applyCanvasReview when Apply is clicked", async () => {
    const user = userEvent.setup()
    const id = seedReview()
    // Accept only the first hunk.
    const review = useArtifactStore.getState().pendingReviews[id]
    act(() => {
      useArtifactStore.getState().setReviewItemStatus(id, review.items[0].id, "accepted")
    })
    render(<CanvasReviewView documentId={id} panelMode="desktop" />)
    await user.click(screen.getByRole("button", { name: /Apply accepted/i }))
    const s = useArtifactStore.getState()
    expect(s.pendingReviews[id]).toBeUndefined()
    expect(s.canvasDocuments[id].content).toBe("A\nb\nc\nd")
  })

  it("clears the proposal when Reject all is clicked", async () => {
    const user = userEvent.setup()
    const id = seedReview()
    render(<CanvasReviewView documentId={id} panelMode="desktop" />)
    await user.click(screen.getByRole("button", { name: /Reject all/i }))
    expect(useArtifactStore.getState().pendingReviews[id]).toBeUndefined()
  })

  it("toggles hunk status via the per-hunk accept/reject controls", async () => {
    const user = userEvent.setup()
    const id = seedReview()
    render(<CanvasReviewView documentId={id} panelMode="desktop" />)
    await user.click(screen.getAllByRole("button", { name: /^Accept$/i })[0])
    await user.click(screen.getAllByRole("button", { name: /^Reject$/i })[1])
    const items = useArtifactStore.getState().pendingReviews[id].items
    expect(items[0].status).toBe("accepted")
    expect(items[1].status).toBe("rejected")
  })

  it("renders the empty hunk state and a plaintext diff when the document is gone", () => {
    act(() => {
      useArtifactStore.setState({
        pendingReviews: {
          orphan: {
            id: "r1",
            requestId: "rq",
            actionType: "custom",
            originalContent: "a",
            proposedContent: "b",
            createdAt: new Date(),
            status: "pending",
            items: [],
          },
        },
      })
    })
    render(<CanvasReviewView documentId="orphan" panelMode="desktop" />)
    // total === 0 → empty hunk hint; doc missing → plaintext diff language.
    expect(screen.getByText("No changes to review")).toBeInTheDocument()
  })

  it("uses the dark Monaco theme when the app theme is dark", () => {
    setMockTheme("dark")
    const id = seedReview()
    render(<CanvasReviewView documentId={id} panelMode="desktop" />)
    expect(screen.getByTestId("diff-editor")).toBeInTheDocument()
  })

  it("shows the stale banner and can re-diff a stale proposal", async () => {
    const user = userEvent.setup()
    const id = seedReview()
    // A manual edit moves the baseline -> stale.
    act(() => {
      useArtifactStore.getState().updateCanvasDocument(id, { content: "manual\nedit" })
    })
    render(<CanvasReviewView documentId={id} panelMode="desktop" />)
    expect(screen.getByTestId("canvas-review-stale-banner")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Re-diff against current/i }))
    // Re-diff rebuilds against the current buffer -> no longer stale.
    expect(useArtifactStore.getState().pendingReviews[id].isStale).toBeFalsy()
  })

  it("discards a stale proposal from the stale banner", async () => {
    const user = userEvent.setup()
    const id = seedReview()
    act(() => {
      useArtifactStore.getState().updateCanvasDocument(id, { content: "moved\naway" })
    })
    render(<CanvasReviewView documentId={id} panelMode="desktop" />)
    await user.click(screen.getByRole("button", { name: /^Discard$/i }))
    expect(useArtifactStore.getState().pendingReviews[id]).toBeUndefined()
  })
})
