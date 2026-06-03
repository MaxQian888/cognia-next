jest.mock("@/lib/git/commands", () => ({ gitDiffFile: jest.fn() }))
// Stub the Monaco-backed viewer; expose hunk actions as buttons so we can
// exercise DiffPane's action routing without mounting Monaco.
jest.mock("./diff-viewer", () => ({
  DiffViewer: ({
    diff,
    hunkActions,
  }: {
    diff: unknown
    hunkActions?: { icon: string; onClick: (h: unknown) => void }[]
  }) => (
    <div data-testid="diff-viewer-stub" data-has-diff={diff ? "yes" : "no"}>
      {(hunkActions ?? []).map((a) => (
        <button key={a.icon} data-testid={`stub-hunk-${a.icon}`} onClick={() => a.onClick(hunk)}>
          {a.icon}
        </button>
      ))}
    </div>
  ),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { gitDiffFile } from "@/lib/git/commands"
import { DiffPane } from "./diff-pane"
import { useGitStore } from "@/stores/git/git-store"
import type { GitHunk } from "@/types/git"

const gitDiffFileMock = gitDiffFile as jest.Mock

const hunk: GitHunk = {
  header: "@@",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  patch: "PATCH",
  lines: [],
}

function makeActions() {
  return {
    stage: jest.fn().mockResolvedValue(undefined),
    unstage: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  gitDiffFileMock.mockReset().mockResolvedValue({
    path: "a.ts",
    oldContent: "",
    newContent: "",
    hunks: [hunk],
    isBinary: false,
  })
  act(() => useGitStore.getState().reset())
})

describe("DiffPane", () => {
  it("loads the working diff and shows stage + discard hunk actions", async () => {
    const actions = makeActions()
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={actions} />)
    await waitFor(() => expect(gitDiffFileMock).toHaveBeenCalledWith("/r", "a.ts", false))
    expect(screen.getByTestId("stub-hunk-stage")).toBeInTheDocument()
    expect(screen.getByTestId("stub-hunk-discard")).toBeInTheDocument()
  })

  it("stage-hunk sends the hunk patch", async () => {
    const actions = makeActions()
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={actions} />)
    await screen.findByTestId("stub-hunk-stage")
    await act(async () => {
      fireEvent.click(screen.getByTestId("stub-hunk-stage"))
    })
    expect(actions.stage).toHaveBeenCalledWith([], "PATCH")
  })

  it("shows an unstage action for staged diffs", async () => {
    const actions = makeActions()
    render(<DiffPane rootDir="/r" path="a.ts" staged actions={actions} />)
    await waitFor(() => expect(gitDiffFileMock).toHaveBeenCalledWith("/r", "a.ts", true))
    await screen.findByTestId("stub-hunk-unstage")
    await act(async () => {
      fireEvent.click(screen.getByTestId("stub-hunk-unstage"))
    })
    expect(actions.unstage).toHaveBeenCalledWith([], "PATCH")
  })

  it("serves a cached diff without re-fetching", async () => {
    const key = "w:a.ts"
    act(() =>
      useGitStore.getState().cacheDiff(key, {
        path: "a.ts",
        oldContent: "",
        newContent: "",
        hunks: [],
        isBinary: false,
      })
    )
    render(<DiffPane rootDir="/r" path="a.ts" staged={false} actions={makeActions()} />)
    await screen.findByTestId("diff-viewer-stub")
    expect(gitDiffFileMock).not.toHaveBeenCalled()
  })
})
