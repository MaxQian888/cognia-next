jest.mock("@/lib/git/commands", () => ({
  gitLog: jest.fn(),
  gitFileHistory: jest.fn(),
  gitRefs: jest.fn(),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { gitFileHistory, gitLog, gitRefs } from "@/lib/git/commands"
import { TimelineView } from "./timeline-view"
import { useGitStore } from "@/stores/git/git-store"
import type { GitCommit } from "@/types/git"

const gitLogMock = gitLog as jest.Mock
const gitFileHistoryMock = gitFileHistory as jest.Mock
const gitRefsMock = gitRefs as jest.Mock

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
  gitRefsMock.mockReset().mockResolvedValue([])
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

  it("filters loaded commits by summary substring", async () => {
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    await screen.findByText("first")
    fireEvent.change(screen.getByTestId("timeline-filter"), { target: { value: "SECOND" } })
    expect(screen.queryByText("first")).not.toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
  })

  it("filters by author name case-insensitively", async () => {
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    await screen.findByText("first")
    fireEvent.change(screen.getByTestId("timeline-filter"), { target: { value: "tester" } })
    // Both commits share the author — both stay visible.
    expect(screen.getByText("first")).toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
  })

  it("filters by hash prefix and shows empty state on no match", async () => {
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    await screen.findByText("first")
    fireEvent.change(screen.getByTestId("timeline-filter"), { target: { value: "bbbb" } })
    expect(screen.queryByText("first")).not.toBeInTheDocument()
    expect(screen.getByText("second")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("timeline-filter"), { target: { value: "zzzz" } })
    expect(screen.queryByText("second")).not.toBeInTheDocument()
  })

  it("says it is loading, not that there is no history, before the first answer", () => {
    gitLogMock.mockReturnValue(new Promise(() => {}))
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    expect(screen.getByTestId("timeline-loading")).toBeInTheDocument()
    expect(screen.queryByText("No history")).not.toBeInTheDocument()
  })

  it("does not show another file's history while this file's loads", async () => {
    act(() => {
      useGitStore.getState().setTimeline("file", [commit("ddddddd4", "other file commit")])
      useGitStore.getState().setTimelineScope("file")
    })
    gitFileHistoryMock.mockReturnValue(new Promise(() => {}))
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath="b.ts" />)
    expect(screen.queryByText("other file commit")).not.toBeInTheDocument()
    expect(screen.getByTestId("timeline-loading")).toBeInTheDocument()
  })

  it("shows a failed read with a retry that reads again", async () => {
    gitLogMock.mockRejectedValueOnce({ kind: "commandFailed", detail: "bad revision" })
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    expect(await screen.findByTestId("timeline-load-error")).toHaveTextContent("bad revision")
    fireEvent.click(screen.getByTestId("timeline-load-error-retry"))
    expect(await screen.findByText("first")).toBeInTheDocument()
  })

  it("hands a picked commit to the host so it can close the sheet", async () => {
    const onPickCommit = jest.fn()
    render(
      <TimelineView
        open
        onOpenChange={() => {}}
        rootDir="/r"
        filePath={null}
        onPickCommit={onPickCommit}
      />
    )
    fireEvent.click(await screen.findByTestId("timeline-commit-bbbbbbb2"))
    expect(onPickCommit).toHaveBeenCalledWith("bbbbbbb2")
    expect(useGitStore.getState().selectedCommit).toBe("bbbbbbb2")
  })

  it("offers no graph toggle when the host disallows the graph", async () => {
    render(
      <TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} allowGraph={false} />
    )
    await screen.findByText("first")
    expect(screen.queryByTestId("timeline-view-toggle")).not.toBeInTheDocument()
  })

  it("reports a failed load-more and retries it", async () => {
    const page = Array.from({ length: 50 }, (_, i) => commit(`${i}`.padStart(8, "a"), `c${i}`))
    gitLogMock
      .mockReset()
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce([commit("zzzzzzz9", "older")])
    render(<TimelineView open onOpenChange={() => {}} rootDir="/r" filePath={null} />)
    fireEvent.click(await screen.findByTestId("timeline-load-more"))
    expect(await screen.findByTestId("timeline-more-error")).toHaveTextContent("network down")
    fireEvent.click(screen.getByTestId("timeline-more-error-retry"))
    expect(await screen.findByText("older")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId("timeline-more-error")).not.toBeInTheDocument())
  })

  describe("graph view", () => {
    async function openGraph(onPickCommit = jest.fn()) {
      render(
        <TimelineView
          open
          onOpenChange={() => {}}
          rootDir="/r"
          filePath={null}
          onPickCommit={onPickCommit}
        />
      )
      await screen.findByText("first")
      fireEvent.click(screen.getByTestId("timeline-view-graph"))
      return onPickCommit
    }

    it("reads ref decorations and hands a graph pick to the host", async () => {
      const onPickCommit = await openGraph()
      await waitFor(() => expect(gitRefsMock).toHaveBeenCalledWith("/r"))
      fireEvent.click(await screen.findByTestId("graph-commit-aaaaaaa1"))
      expect(onPickCommit).toHaveBeenCalledWith("aaaaaaa1")
      expect(useGitStore.getState().selectedCommit).toBe("aaaaaaa1")
    })

    it("keeps the graph when its decorations fail, and says so", async () => {
      gitRefsMock
        .mockReset()
        .mockRejectedValueOnce(new Error("refs unreadable"))
        .mockResolvedValue([])
      await openGraph()
      expect(await screen.findByTestId("timeline-refs-error")).toHaveTextContent("refs unreadable")
      expect(screen.getByTestId("graph-commit-aaaaaaa1")).toBeInTheDocument()
      fireEvent.click(screen.getByTestId("timeline-refs-error-retry"))
      await waitFor(() =>
        expect(screen.queryByTestId("timeline-refs-error")).not.toBeInTheDocument()
      )
    })
  })
})
