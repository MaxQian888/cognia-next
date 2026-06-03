import { fireEvent, render, screen } from "@testing-library/react"
import { CommitGraphView } from "./commit-graph-view"
import type { GitCommit, GitRef } from "@/types/git"

function c(hash: string, parents: string[]): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    summary: `summary ${hash}`,
    body: "",
    authorName: "Tester",
    authorEmail: "t@e.com",
    authoredAtMs: 0,
    parents,
  }
}

const commits = [c("aaaaaaa1", ["bbbbbbb2"]), c("bbbbbbb2", ["ccccccc3"]), c("ccccccc3", [])]
const refs: GitRef[] = [
  { name: "main", kind: "branch", targetHash: "aaaaaaa1" },
  { name: "v1", kind: "tag", targetHash: "ccccccc3" },
]

describe("CommitGraphView", () => {
  it("renders a node row per commit", () => {
    render(
      <CommitGraphView commits={commits} refs={refs} selectedCommit={null} onSelect={() => {}} />
    )
    expect(screen.getByTestId("commit-graph")).toBeInTheDocument()
    expect(screen.getByTestId("graph-commit-aaaaaaa1")).toBeInTheDocument()
    expect(screen.getByTestId("graph-commit-bbbbbbb2")).toBeInTheDocument()
    expect(screen.getByTestId("graph-commit-ccccccc3")).toBeInTheDocument()
    expect(screen.getAllByText(/summary/)).toHaveLength(3)
  })

  it("renders ref badges on the right rows", () => {
    render(
      <CommitGraphView commits={commits} refs={refs} selectedCommit={null} onSelect={() => {}} />
    )
    expect(screen.getByTestId("graph-ref-main")).toBeInTheDocument()
    expect(screen.getByTestId("graph-ref-v1")).toBeInTheDocument()
  })

  it("selects a commit on click", () => {
    const onSelect = jest.fn()
    render(
      <CommitGraphView commits={commits} refs={refs} selectedCommit={null} onSelect={onSelect} />
    )
    fireEvent.click(screen.getByTestId("graph-commit-bbbbbbb2"))
    expect(onSelect).toHaveBeenCalledWith("bbbbbbb2")
  })

  it("draws a node circle per commit", () => {
    const { container } = render(
      <CommitGraphView commits={commits} refs={[]} selectedCommit={null} onSelect={() => {}} />
    )
    expect(container.querySelectorAll("circle")).toHaveLength(3)
  })

  it("renders nothing but the container for an empty history", () => {
    render(<CommitGraphView commits={[]} refs={[]} selectedCommit={null} onSelect={() => {}} />)
    expect(screen.getByTestId("commit-graph")).toBeEmptyDOMElement()
  })
})
