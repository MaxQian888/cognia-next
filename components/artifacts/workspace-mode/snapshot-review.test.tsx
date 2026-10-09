/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/hooks/ui/use-resizable-layout", () => ({
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
}))
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="split-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))
jest.mock("@/components/shared/file-type-icon", () => ({ FileTypeIcon: () => null }))
jest.mock("@/components/source-control/diff-viewer", () => ({
  DiffViewer: ({
    diff,
    readOnly,
    toolbarStart,
  }: {
    diff: { path: string } | null
    readOnly?: boolean
    toolbarStart?: ReactNode
  }) => (
    <div data-testid="diff" data-path={diff?.path ?? ""} data-readonly={String(Boolean(readOnly))}>
      {toolbarStart}
    </div>
  ),
}))

const listReviewScopeFiles = jest.fn()
const loadReviewScopeDiff = jest.fn()
jest.mock("@/lib/review/scope", () => ({
  ...jest.requireActual("@/lib/review/scope"),
  listReviewScopeFiles: (...args: unknown[]) => listReviewScopeFiles(...args),
  loadReviewScopeDiff: (...args: unknown[]) => loadReviewScopeDiff(...args),
}))

import { isSnapshotSelection, SnapshotReview, type SnapshotSelection } from "./snapshot-review"

const ref = (path: string, status = "modified") => ({
  repositoryRoot: "/repo",
  path,
  source: "lastTurn",
  status,
  reviewKey: path,
})
const turn: SnapshotSelection = { scope: "lastTurn", runId: "run:1" }

function renderSnapshot(props: Partial<Parameters<typeof SnapshotReview>[0]> = {}) {
  return render(
    <SnapshotReview
      rootPath="/repo"
      selection={turn}
      stacked={false}
      touch={false}
      header={<div data-testid="header" />}
      {...props}
    />
  )
}

async function settle() {
  await act(async () => {})
}

beforeEach(() => {
  listReviewScopeFiles.mockReset().mockResolvedValue({
    files: [ref("src/a.ts"), ref("b.ts", "added")],
    unavailable: [],
  })
  loadReviewScopeDiff
    .mockReset()
    .mockImplementation(async (_request: unknown, file: { path: string }) => ({
      path: file.path,
      hunks: [],
    }))
})

describe("isSnapshotSelection", () => {
  it("is true for turn, commit and branch only", () => {
    expect(isSnapshotSelection(turn)).toBe(true)
    expect(isSnapshotSelection({ scope: "commit", commitSha: "s" })).toBe(true)
    expect(isSnapshotSelection({ scope: "branch", baseRef: "m", targetRef: "HEAD" })).toBe(true)
    expect(isSnapshotSelection({ scope: "staged" })).toBe(false)
    expect(isSnapshotSelection({ scope: "conversation" })).toBe(false)
  })
})

describe("SnapshotReview", () => {
  it("lists the scope's files with the refs it needs and opens the first one read-only", async () => {
    renderSnapshot()
    expect(screen.getByTestId("snapshot-review-loading")).toBeInTheDocument()
    await settle()
    expect(listReviewScopeFiles).toHaveBeenCalledWith({
      scope: "lastTurn",
      repositoryRoots: ["/repo"],
      defaults: { lastTurnRunId: "run:1" },
    })
    expect(screen.getByTestId("header")).toBeInTheDocument()
    expect(screen.getByTestId("snapshot-review-file-b.ts")).toHaveTextContent("A")
    expect(screen.getByTestId("diff")).toHaveAttribute("data-path", "src/a.ts")
    expect(screen.getByTestId("diff")).toHaveAttribute("data-readonly", "true")
  })

  it("opens the focused file and steps between files", async () => {
    renderSnapshot({ focusPath: "b.ts" })
    await settle()
    expect(screen.getByTestId("diff")).toHaveAttribute("data-path", "b.ts")
    expect(screen.getByTestId("snapshot-review-next-file")).toBeDisabled()
    fireEvent.click(screen.getByTestId("snapshot-review-prev-file"))
    await settle()
    expect(screen.getByTestId("diff")).toHaveAttribute("data-path", "src/a.ts")
  })

  it("takes turns when stacked: list first, then the picked file's diff and back", async () => {
    renderSnapshot({ stacked: true })
    await settle()
    expect(screen.queryByTestId("diff")).toBeNull()
    fireEvent.click(screen.getByTestId("snapshot-review-file-b.ts"))
    await settle()
    expect(screen.getByTestId("diff")).toHaveAttribute("data-path", "b.ts")
    fireEvent.click(screen.getByTestId("snapshot-review-back"))
    expect(screen.getByTestId("snapshot-review-files")).toBeInTheDocument()
  })

  it("says so when the scope has no files", async () => {
    listReviewScopeFiles.mockResolvedValue({ files: [], unavailable: [] })
    renderSnapshot()
    await settle()
    expect(screen.getByTestId("snapshot-review-empty")).toHaveTextContent("snapshot.empty")
  })

  it("explains a root the scope could not be applied to", async () => {
    listReviewScopeFiles.mockResolvedValue({
      files: [],
      unavailable: [{ repositoryRoot: "/repo", reason: "missing-run" }],
    })
    renderSnapshot()
    await settle()
    expect(screen.getByTestId("snapshot-review-unavailable")).toHaveTextContent(
      "snapshot.unavailable.missing-run"
    )
  })

  it("reports a listing failure and a diff failure", async () => {
    listReviewScopeFiles.mockRejectedValueOnce(new Error("git broke"))
    const { unmount } = renderSnapshot()
    await settle()
    expect(screen.getByTestId("snapshot-review-error")).toHaveTextContent("git broke")
    unmount()

    loadReviewScopeDiff.mockRejectedValue(new Error("no diff"))
    renderSnapshot()
    await settle()
    expect(screen.getByTestId("snapshot-review-diff-error")).toHaveTextContent("no diff")
  })

  it("reads a commit's diff with the commit's refs", async () => {
    renderSnapshot({ selection: { scope: "commit", commitSha: "abc" } })
    await settle()
    expect(loadReviewScopeDiff).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "commit", defaults: { commitSha: "abc" } }),
      expect.objectContaining({ path: "src/a.ts" })
    )
  })
})
