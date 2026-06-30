/**
 * @jest-environment jsdom
 */
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { HunkReviewList } from "./hunk-review-list"
import { diffReviewFileKey, useDiffReviewStore } from "@/stores/git/diff-review-store"
import type { GitDiff, GitFileChange, GitHunk } from "@/types/git"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
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

beforeEach(() => useDiffReviewStore.setState({ decisions: {}, order: [] }))

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
    await userEvent.click(screen.getByTestId("item-0"))
    await userEvent.click(screen.getByTestId("item-1"))
    await act(async () => {
      await userEvent.click(screen.getByTestId("apply-accepted"))
    })
    // Reverse newStart order: patch-5 before patch-1.
    expect(onStagePatch.mock.calls.map((c) => c[0])).toEqual(["patch-5", "patch-1"])
    expect(onInvalidate).toHaveBeenCalled()
    expect(useDiffReviewStore.getState().getFileDecisions("/r", "a.ts")).toEqual([])
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
})
