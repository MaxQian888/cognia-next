jest.mock("@/lib/git/commands", () => ({
  gitRefs: jest.fn(),
  gitDiffRefsFiles: jest.fn(),
  gitDiffRefsFile: jest.fn(),
}))
jest.mock("./diff-viewer", () => ({
  DiffViewer: ({ diff }: { diff: unknown }) => (
    <div data-testid="diff-viewer-stub" data-has-diff={diff ? "yes" : "no"} />
  ),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { gitDiffRefsFile, gitDiffRefsFiles, gitRefs } from "@/lib/git/commands"
import { CompareRefsSheet } from "./compare-refs-sheet"
import type { GitFileChange, GitRef } from "@/types/git"

const refsMock = gitRefs as jest.Mock
const filesMock = gitDiffRefsFiles as jest.Mock
const fileDiffMock = gitDiffRefsFile as jest.Mock

const refs: GitRef[] = [
  { name: "main", kind: "branch", targetHash: "aaa" },
  { name: "feature", kind: "branch", targetHash: "bbb" },
]
const changed: GitFileChange[] = [
  { path: "src/a.ts", origPath: null, status: "modified", staged: false, group: "changes" },
]

beforeEach(() => {
  refsMock.mockReset().mockResolvedValue(refs)
  filesMock.mockReset().mockResolvedValue(changed)
  fileDiffMock.mockReset().mockResolvedValue({
    path: "src/a.ts",
    oldContent: "o",
    newContent: "n",
    hunks: [],
    isBinary: false,
    language: "typescript",
  })
})

async function pickBoth() {
  fireEvent.click(screen.getByTestId("compare-base"))
  fireEvent.click(await screen.findByTestId("compare-base-main"))
  fireEvent.click(screen.getByTestId("compare-target"))
  fireEvent.click(await screen.findByTestId("compare-target-feature"))
  await screen.findByTestId("compare-file-src/a.ts")
}

describe("CompareRefsSheet", () => {
  it("loads refs into both pickers when opened", async () => {
    render(<CompareRefsSheet open onOpenChange={() => {}} rootDir="/r" />)
    await waitFor(() => expect(refsMock).toHaveBeenCalledWith("/r"))
    fireEvent.click(screen.getByTestId("compare-base"))
    expect(await screen.findByTestId("compare-base-feature")).toBeInTheDocument()
  })

  it("does not load refs while closed", () => {
    render(<CompareRefsSheet open={false} onOpenChange={() => {}} rootDir="/r" />)
    expect(refsMock).not.toHaveBeenCalled()
  })

  it("lists changed files once both refs are picked", async () => {
    render(<CompareRefsSheet open onOpenChange={() => {}} rootDir="/r" />)
    await waitFor(() => expect(refsMock).toHaveBeenCalled())
    await pickBoth()
    await waitFor(() => expect(filesMock).toHaveBeenCalledWith("/r", "main", "feature"))
    expect(await screen.findByTestId("compare-file-src/a.ts")).toBeInTheDocument()
  })

  it("renders the diff for a selected file", async () => {
    render(<CompareRefsSheet open onOpenChange={() => {}} rootDir="/r" />)
    await waitFor(() => expect(refsMock).toHaveBeenCalled())
    await pickBoth()
    fireEvent.click(await screen.findByTestId("compare-file-src/a.ts"))
    await waitFor(() =>
      expect(fileDiffMock).toHaveBeenCalledWith("/r", "main", "feature", "src/a.ts")
    )
    await waitFor(() =>
      expect(screen.getByTestId("diff-viewer-stub")).toHaveAttribute("data-has-diff", "yes")
    )
  })

  it("shows the pick-both hint before refs are selected", async () => {
    render(<CompareRefsSheet open onOpenChange={() => {}} rootDir="/r" />)
    expect(await screen.findByTestId("compare-empty")).toBeInTheDocument()
    expect(filesMock).not.toHaveBeenCalled()
  })
})
