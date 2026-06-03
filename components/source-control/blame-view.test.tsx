import { render, screen, waitFor } from "@testing-library/react"
import { BlameView } from "./blame-view"
import type { GitBlameLine } from "@/types/git"

const gitBlame = jest.fn<Promise<GitBlameLine[]>, [string, string, string?]>()
jest.mock("@/lib/git/commands", () => ({
  gitBlame: (rp: string, p: string, rev?: string) => gitBlame(rp, p, rev),
}))
// Keep content as plain text nodes (shiki doesn't run in jsdom); the view's
// fallback renders the raw line so authorship + content stay assertable.
jest.mock("@/components/ai-elements/code-block", () => ({
  highlightCode: () => null,
}))

function bl(lineNumber: number, hash: string, author: string, content: string): GitBlameLine {
  return {
    lineNumber,
    commitHash: hash,
    shortHash: hash.slice(0, 7),
    authorName: author,
    authoredAtMs: 1_000_000,
    summary: `commit ${hash.slice(0, 4)}`,
    content,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("BlameView", () => {
  it("shows a loading state then the blamed lines", async () => {
    gitBlame.mockResolvedValue([
      bl(1, "a".repeat(40), "Alice", "line one"),
      bl(2, "a".repeat(40), "Alice", "line two"),
      bl(3, "b".repeat(40), "Bob", "line three"),
    ])
    render(<BlameView rootDir="/repo" path="a.ts" />)
    expect(screen.getByTestId("blame-loading")).toBeInTheDocument()
    expect(await screen.findByTestId("blame-line-1")).toBeInTheDocument()
    expect(screen.getByTestId("blame-line-3")).toBeInTheDocument()
    expect(screen.getByText("line one")).toBeInTheDocument()
    expect(screen.getByText("line three")).toBeInTheDocument()
    expect(gitBlame).toHaveBeenCalledWith("/repo", "a.ts", undefined)
  })

  it("blames a pinned revision when rev is given", async () => {
    gitBlame.mockResolvedValue([bl(1, "a".repeat(40), "Alice", "x")])
    render(<BlameView rootDir="/repo" path="a.ts" rev="abc123" />)
    await screen.findByTestId("blame-line-1")
    expect(gitBlame).toHaveBeenCalledWith("/repo", "a.ts", "abc123")
  })

  it("collapses the annotation for consecutive lines of the same commit", async () => {
    gitBlame.mockResolvedValue([
      bl(1, "a".repeat(40), "Alice", "one"),
      bl(2, "a".repeat(40), "Alice", "two"),
      bl(3, "b".repeat(40), "Bob", "three"),
    ])
    render(<BlameView rootDir="/repo" path="a.ts" />)
    await screen.findByTestId("blame-line-1")
    // Alice's shortHash appears once (line 1), not repeated on line 2.
    expect(screen.getAllByText("aaaaaaa")).toHaveLength(1)
    expect(screen.getAllByText("bbbbbbb")).toHaveLength(1)
  })

  it("labels uncommitted lines", async () => {
    gitBlame.mockResolvedValue([bl(1, "0".repeat(40), "Not Committed Yet", "wip")])
    render(<BlameView rootDir="/repo" path="a.ts" />)
    expect(await screen.findByTestId("blame-uncommitted-1")).toBeInTheDocument()
  })

  it("shows an empty state when there is no blame", async () => {
    gitBlame.mockResolvedValue([])
    render(<BlameView rootDir="/repo" path="a.ts" />)
    await waitFor(() => expect(screen.getByTestId("blame-empty")).toBeInTheDocument())
  })
})
