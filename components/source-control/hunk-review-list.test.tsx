/**
 * @jest-environment jsdom
 */
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { HunkReviewList } from "./hunk-review-list"
import { diffReviewFileKey, useDiffReviewStore } from "@/stores/git/diff-review-store"
import { hunkContentHash } from "@/lib/git/hunk-review"
import type { GitDiff, GitFileChange, GitHunk } from "@/types/git"

let mockAiEnabled = false
let mockReviewing = false
const mockReview = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { gitSettings: { reviewAI: { enabled: mockAiEnabled } } } }),
}))
jest.mock("@/hooks/git/use-ai-diff-review", () => ({
  useAiDiffReview: () => ({ reviewing: mockReviewing, error: null, review: mockReview }),
}))

// Test double: surface the props as buttons so list logic is isolated.
jest.mock("./hunk-review-item", () => ({
  HunkReviewItem: ({
    index,
    decision,
    onDecision,
  }: {
    index: number
    decision: string
    onDecision: (i: number, d: string) => void
  }) => (
    <button
      data-testid={`item-${index}`}
      data-decision={decision}
      onClick={() => onDecision(index, "accepted")}
    >
      hunk {index}
    </button>
  ),
}))

function hunk(newStart: number, body: string): GitHunk {
  return {
    header: `@@ ${newStart}`,
    oldStart: newStart,
    oldLines: 1,
    newStart,
    newLines: 1,
    patch: `patch-${newStart}`,
    lines: [{ kind: "add", content: body }],
  }
}

const change: GitFileChange = {
  path: "a.ts",
  origPath: null,
  status: "modified",
  staged: false,
  group: "changes",
}

function diff(hunks: GitHunk[]): GitDiff {
  return { path: "a.ts", oldContent: "", newContent: "", hunks, isBinary: false }
}

beforeEach(() => {
  useDiffReviewStore.setState({ decisions: {}, order: [] })
  mockAiEnabled = false
  mockReviewing = false
  mockReview.mockReset()
})

describe("HunkReviewList", () => {
  it("renders one item per hunk and a 0/N accepted count", () => {
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a"), hunk(5, "b")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("item-0")).toBeInTheDocument()
    expect(screen.getByTestId("item-1")).toBeInTheDocument()
    expect(screen.getByTestId("accepted-count")).toHaveTextContent('"accepted":0,"total":2')
  })

  it("persists a decision and reflects it in the accepted count", async () => {
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a"), hunk(5, "b")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
      />
    )
    await userEvent.click(screen.getByTestId("item-0"))
    expect(screen.getByTestId("accepted-count")).toHaveTextContent('"accepted":1')
  })

  it("applies accepted hunks via onStagePatch (reverse newStart) then clears + invalidates", async () => {
    const user = userEvent.setup()
    const onStagePatch = jest.fn().mockResolvedValue(undefined)
    const onInvalidate = jest.fn()
    const hunks = [hunk(1, "a"), hunk(5, "b")]
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff(hunks)}
        onStagePatch={onStagePatch}
        onInvalidate={onInvalidate}
      />
    )
    // Accept both.
    await user.click(screen.getByTestId("item-0"))
    await user.click(screen.getByTestId("item-1"))
    await user.click(screen.getByTestId("apply-accepted"))
    // Reverse newStart order: patch-5 before patch-1.
    expect(onStagePatch.mock.calls.map((c) => c[0])).toEqual(["patch-5", "patch-1"])
    expect(onInvalidate).toHaveBeenCalled()
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toEqual([])
  })

  it("preserves accepted decisions when staging a reviewed hunk fails", async () => {
    const user = userEvent.setup()
    const onStagePatch = jest
      .fn()
      .mockResolvedValue({ kind: "commandFailed", detail: "patch no longer applies" })
    const onInvalidate = jest.fn()
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a")])}
        onStagePatch={onStagePatch}
        onInvalidate={onInvalidate}
      />
    )
    await user.click(screen.getByTestId("item-0"))
    await user.click(screen.getByTestId("apply-accepted"))

    expect(onInvalidate).not.toHaveBeenCalled()
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toHaveLength(1)
  })

  it("disables Apply when nothing is accepted", () => {
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("apply-accepted")).toBeDisabled()
  })

  it("renders only the header (no hunk items) when collapsed", () => {
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a"), hunk(5, "b")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
        collapsed
        onToggleCollapse={jest.fn()}
      />
    )
    expect(screen.getByTestId("hunk-review-list")).toHaveAttribute("data-collapsed", "true")
    expect(screen.getByTestId("accepted-count")).toBeInTheDocument()
    expect(screen.queryByTestId("item-0")).not.toBeInTheDocument()
    expect(screen.queryByTestId("apply-accepted")).not.toBeInTheDocument()
  })

  it("fires onToggleCollapse when the chevron is clicked", async () => {
    const onToggleCollapse = jest.fn()
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
        onToggleCollapse={onToggleCollapse}
      />
    )
    await userEvent.click(screen.getByTestId("review-collapse-toggle"))
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
  })

  it("shows the remap notice when stored decisions no longer match", () => {
    // Seed a decision whose hash matches nothing in the current diff.
    act(() =>
      useDiffReviewStore.setState({
        decisions: {
          [diffReviewFileKey("/r", "a.ts")]: [
            { hunkIndex: 0, hash: "stale", decision: "accepted" },
          ],
        },
        order: [diffReviewFileKey("/r", "a.ts")],
      })
    )
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("remap-notice")).toHaveTextContent('"count":1')
  })

  it("hides the AI review button when the feature is disabled", () => {
    mockAiEnabled = false
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
      />
    )
    expect(screen.queryByTestId("ai-review-run")).not.toBeInTheDocument()
  })

  it("runs the AI review when the button is clicked", async () => {
    mockAiEnabled = true
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([hunk(1, "a")])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
      />
    )
    await userEvent.click(screen.getByTestId("ai-review-run"))
    expect(mockReview).toHaveBeenCalledTimes(1)
  })

  it("shows a clear button when AI findings exist and clears them", async () => {
    mockAiEnabled = true
    const h = hunk(1, "a")
    act(() =>
      useDiffReviewStore
        .getState()
        .setAiFinding("/r", "a.ts", 0, hunkContentHash(h), { severity: "warning", note: "n" })
    )
    render(
      <HunkReviewList
        rootDir="/r"
        change={change}
        diff={diff([h])}
        onStagePatch={jest.fn()}
        onInvalidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("ai-review-clear")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("ai-review-clear"))
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toEqual([])
    expect(screen.queryByTestId("ai-review-clear")).not.toBeInTheDocument()
  })
})
