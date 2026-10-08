/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Keep the artifact store light: stub the plugin hook surface + project store.
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => new Proxy({}, { get: () => jest.fn() }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

// Resolve the dynamically-imported DiffEditor synchronously to a stub (the
// real next/dynamic defers, so the stub would never mount during the test).
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useEffect } = require("react") as typeof import("react")
    const DiffEditorStub = ({
      original,
      modified,
      options,
      onMount,
    }: {
      original: string
      modified: string
      options?: Record<string, unknown>
      onMount?: (editor: unknown, monaco: unknown) => void
    }) => {
      // Hand the view a fake diff editor so hunk reveals can be observed.
      useEffect(() => {
        onMount?.(
          {
            getModel: () => null,
            setModel: () => {},
            getModifiedEditor: () =>
              (globalThis as { __modifiedEditor?: unknown }).__modifiedEditor,
          },
          {}
        )
      }, [onMount])
      return (
        <div
          data-testid="diff-editor"
          data-original={original}
          data-modified={modified}
          data-options={JSON.stringify(options ?? {})}
        />
      )
    }
    DiffEditorStub.displayName = "DiffEditorStub"
    return DiffEditorStub
  },
}))

import { ArtifactReviewView } from "./artifact-review-view"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { Artifact } from "@/types"

function seedArtifact(content = "a\nb\nc\nd"): Artifact {
  return useArtifactStore.getState().createArtifact({
    sessionId: "s1",
    messageId: "m1",
    type: "code",
    title: "Snippet",
    content,
    language: "javascript",
  })
}

beforeEach(() => {
  act(() => {
    useArtifactStore.setState({
      artifacts: {},
      activeArtifactIdBySession: {},
      artifactVersions: {},
      pendingReviews: {},
    })
  })
})

describe("ArtifactReviewView", () => {
  it("explains itself when there is no pending review instead of rendering nothing", () => {
    const a = seedArtifact()
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)

    // This panel is permanently registered on the artifact surface, so the
    // Review activity is reachable whether or not a proposal exists. Returning
    // null handed the user a blank panel with no hint of what it was for.
    expect(screen.getByTestId("artifact-review-empty")).toBeInTheDocument()
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.getByText("emptyDescription")).toBeInTheDocument()
    expect(screen.queryByTestId("diff-editor")).not.toBeInTheDocument()
  })

  it("renders the Monaco DiffEditor and one row per hunk on desktop", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)
    const diff = screen.getByTestId("diff-editor")
    expect(diff).toHaveAttribute("data-original", "a\nb\nc\nd")
    expect(diff).toHaveAttribute("data-modified", "A\nb\nc\nD")
    expect(screen.getAllByTestId("review-hunk-item").length).toBeGreaterThanOrEqual(2)
  })

  it("uses the inline diff fallback on mobile (no Monaco)", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    })
    render(<ArtifactReviewView artifact={a} panelMode="mobile" />)
    expect(screen.queryByTestId("diff-editor")).not.toBeInTheDocument()
    expect(screen.getByTestId("artifact-review-view")).toBeInTheDocument()
    // The virtualized line diff, wrapped for a narrow screen.
    expect(screen.getByTestId("artifact-review-inline-diff")).toHaveAttribute("data-wrap", "true")
  })

  it("folds unchanged regions and adapts to narrow space in the Monaco diff", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)
    const options = JSON.parse(screen.getByTestId("diff-editor").getAttribute("data-options")!)
    expect(options.hideUnchangedRegions).toEqual({ enabled: true })
    expect(options.useInlineViewWhenSpaceIsLimited).toBe(true)
    expect(options.renderSideBySide).toBe(true)
  })

  it("reveals a hunk in the modified editor from its line range", () => {
    const modified = { revealLineInCenter: jest.fn(), setPosition: jest.fn() }
    ;(globalThis as { __modifiedEditor?: unknown }).__modifiedEditor = modified
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)
    const reveals = screen.getAllByTestId("review-hunk-reveal")
    // Second hunk replaces line 4 ("d" → "D").
    fireEvent.click(reveals[reveals.length - 1])
    expect(modified.revealLineInCenter).toHaveBeenCalledWith(4)
    expect(modified.setPosition).toHaveBeenCalledWith({ lineNumber: 4, column: 1 })
    delete (globalThis as { __modifiedEditor?: unknown }).__modifiedEditor
  })

  it("apply is disabled until a hunk is accepted, then applies accepted hunks", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)

    const applyBtn = screen.getByText("applyAccepted").closest("button")!
    expect(applyBtn).toBeDisabled()

    // Accept the first hunk.
    const acceptButtons = screen.getAllByText("accept")
    fireEvent.click(acceptButtons[0])
    expect(applyBtn).not.toBeDisabled()

    fireEvent.click(applyBtn)
    // Proposal cleared; only the accepted hunk applied.
    expect(useArtifactStore.getState().pendingReviews[a.id]).toBeUndefined()
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("A\nb\nc\nd")
  })

  it("'reject all' clears the proposal without changing content", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)
    fireEvent.click(screen.getByText("rejectAll"))
    expect(useArtifactStore.getState().pendingReviews[a.id]).toBeUndefined()
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("a\nb\nc\nd")
  })

  it("shows the stale banner and disables apply when the baseline moved", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      // Accept a hunk, then move the baseline → stale.
      const review = useArtifactStore.getState().pendingReviews[a.id]
      useArtifactStore.getState().setReviewItemStatus(a.id, review.items[0].id, "accepted")
      useArtifactStore.getState().updateArtifact(a.id, { content: "manual\nedit" })
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)
    expect(screen.getByTestId("review-stale-banner")).toBeInTheDocument()
    expect(screen.getByText("applyAccepted").closest("button")!).toBeDisabled()
  })

  it("shows the empty state when a proposal has no hunks", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      const review = useArtifactStore.getState().pendingReviews[a.id]
      useArtifactStore.setState({
        pendingReviews: { [a.id]: { ...review, items: [] } },
      })
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.queryAllByTestId("review-hunk-item")).toHaveLength(0)
  })

  it("re-diff rebuilds the proposal against current content (clears stale)", () => {
    const a = seedArtifact()
    act(() => {
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().updateArtifact(a.id, { content: "x\ny\nz\nw" })
    })
    render(<ArtifactReviewView artifact={a} panelMode="desktop" />)
    fireEvent.click(screen.getByText("reDiff"))
    const review = useArtifactStore.getState().pendingReviews[a.id]
    expect(review).toBeDefined()
    expect(review.isStale).toBeFalsy()
    expect(review.originalContent).toBe("x\ny\nz\nw")
  })
})
