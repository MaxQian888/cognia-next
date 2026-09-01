/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { WorkspaceContextBar } from "./workspace-context-bar"

// The workspace half is exercised by workspace-picker-list's own suite. Here it
// only has to be present, so the switcher is stubbed rather than seeded with a
// project store, a Dexie trust read and a set of dialogs.
jest.mock("@/components/shell/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-testid="workspace-switcher" />,
}))

// Same reasoning for the branch picker: the chip's own suite covers checkout,
// create, delete and rename. This one is about whether the chip is reachable.
jest.mock("@/components/source-control/branch-header", () => ({
  BranchHeader: ({ branch, className }: { branch: string | null; className?: string }) => (
    <div data-testid="branch-header" data-class={className}>
      {branch}
    </div>
  ),
}))

let available = true
jest.mock("@/lib/git/commands", () => ({
  isSourceControlUiAvailable: () => available,
}))
jest.mock("@/lib/git/load", () => ({ loadGitRepo: jest.fn(async () => undefined) }))
jest.mock("@/hooks/git/use-git-actions", () => ({
  useGitActions: () => ({ can: () => true }),
}))

interface GitState {
  rootDir: string | null
  status: { branch: string | null; ahead: number; behind: number } | null
  branches: unknown[]
}
let gitState: GitState = {
  rootDir: "/repo",
  status: { branch: "feature/auth", ahead: 1, behind: 0 },
  branches: [],
}
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: <T,>(selector: (s: GitState) => T) => selector(gitState),
}))

beforeEach(() => {
  available = true
  gitState = {
    rootDir: "/repo",
    status: { branch: "feature/auth", ahead: 1, behind: 0 },
    branches: [],
  }
})

describe("WorkspaceContextBar", () => {
  it("puts the branch next to the workspace it is inside", () => {
    render(<WorkspaceContextBar />)
    expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument()
    expect(screen.getByTestId("branch-header")).toHaveTextContent("feature/auth")
  })

  it("drops the branch and its separator where Source Control cannot run", () => {
    available = false
    const { container } = render(<WorkspaceContextBar />)
    expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument()
    expect(screen.queryByTestId("branch-header")).toBeNull()
    // No chevron pointing at nothing. A dead slot in permanent chrome teaches
    // the user to stop reading the bar.
    expect(container.querySelector("svg")).toBeNull()
  })

  it("drops the branch when no repository is bound yet", () => {
    gitState = { ...gitState, rootDir: null }
    render(<WorkspaceContextBar />)
    expect(screen.queryByTestId("branch-header")).toBeNull()
  })

  it("drops the branch before the first status has arrived", () => {
    gitState = { ...gitState, status: null }
    render(<WorkspaceContextBar />)
    expect(screen.queryByTestId("branch-header")).toBeNull()
  })

  it("lets the branch give up width before the workspace name does", () => {
    render(<WorkspaceContextBar />)
    expect(screen.getByTestId("branch-header").getAttribute("data-class")).toContain("shrink")
  })

  it("stacks into full-width rows on a phone, without repeating the switcher", () => {
    render(<WorkspaceContextBar layout="stacked" />)
    const bar = screen.getByTestId("workspace-context-bar")
    expect(bar).toHaveAttribute("data-layout", "stacked")
    // The drawer already renders the workspace list above this.
    expect(screen.queryByTestId("workspace-switcher")).toBeNull()
    expect(screen.getByTestId("branch-header").getAttribute("data-class")).toContain("w-full")
  })

  it("renders an empty stack rather than a heading with nothing under it", () => {
    available = false
    render(<WorkspaceContextBar layout="stacked" />)
    expect(screen.getByTestId("workspace-context-bar")).toBeEmptyDOMElement()
  })
})
