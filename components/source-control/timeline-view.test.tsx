jest.mock("@/lib/git/commands", () => ({
  gitLog: jest.fn(),
  gitFileHistory: jest.fn(),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { gitFileHistory, gitLog } from "@/lib/git/commands"
import { TimelineView } from "./timeline-view"
import { useGitStore } from "@/stores/git/git-store"
import type { GitCommit } from "@/types/git"

const gitLogMock = gitLog as jest.Mock
const gitFileHistoryMock = gitFileHistory as jest.Mock

const commit = (hash: string, summary: string): GitCommit => ({
  hash,
  shortHash: hash.slice(0, 7),
  summary,
  body: "",
  authorName: "Tester",
  authorEmail: "t@e.com",
  authoredAtMs: 0,
  parents: [],
})

beforeEach(() => {
  gitLogMock
    .mockReset()
    .mockResolvedValue([commit("aaaaaaa1", "first"), commit("bbbbbbb2", "second")])
  gitFileHistoryMock.mockReset().mockResolvedValue([commit("ccccccc3", "file commit")])
  act(() => {
    useGitStore.getState().reset()
    useGitStore.getState().setTimelineScope("repo")
  })
})

describe("TimelineView", () => {
  it("loads repo history when open", async () => {
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    await waitFor(() => expect(gitLogMock).toHaveBeenCalledWith("/r", 50, 0))
    expect(await screen.findByText("first")).toBeInTheDocument()
  })

  it("selects a commit on click", async () => {
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    const item = await screen.findByTestId("timeline-commit-aaaaaaa1")
    fireEvent.click(item)
    expect(useGitStore.getState().selectedCommit).toBe("aaaaaaa1")
  })

  it("offers the file tab and loads file history when a path is set", async () => {
    act(() => useGitStore.getState().setTimelineScope("file"))
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath="a.ts" />)
    expect(screen.getByTestId("timeline-tab-file")).toBeInTheDocument()
    await waitFor(() => expect(gitFileHistoryMock).toHaveBeenCalledWith("/r", "a.ts", 50))
  })

  it("does not load when closed", () => {
    render(<TimelineView open={false} onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    expect(gitLogMock).not.toHaveBeenCalled()
  })
})
