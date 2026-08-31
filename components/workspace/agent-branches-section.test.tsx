/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const gitBranches = jest.fn()
const gitCheckoutBranch = jest.fn()
const gitDeleteBranch = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitBranches: (...a: unknown[]) => gitBranches(...a),
  gitCheckoutBranch: (...a: unknown[]) => gitCheckoutBranch(...a),
  gitDeleteBranch: (...a: unknown[]) => gitDeleteBranch(...a),
  runGitUserAction: (_name: string, run: () => Promise<unknown>) => run(),
}))

let gateVerdict = { available: true, reason: null as string | null }
jest.mock("@/hooks/workspace/use-workspace-command-gate", () => ({
  useWorkspaceCommandGate: () => () => gateVerdict,
}))
jest.mock("@/components/source-control/compare-refs-sheet", () => ({
  CompareRefsSheet: () => null,
}))

import { AgentBranchesSection } from "./agent-branches-section"

describe("AgentBranchesSection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    gateVerdict = { available: true, reason: null }
    gitBranches.mockResolvedValue([
      { name: "dev" },
      { name: "agent/run-1/ada/task-9" },
      { name: "feature/x" },
      { name: "agent/run-2/cleo/task-3" },
    ])
  })

  /**
   * The section is about a repository. A workspace with no root has none, and
   * rendering an empty card would claim a repository exists with no branches.
   */
  it("renders nothing without a root", () => {
    const { container } = render(<AgentBranchesSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists only the branches an isolated run produced", async () => {
    render(<AgentBranchesSection rootDir="/repo" />)
    await waitFor(() =>
      expect(
        screen.getByTestId("workspace-agent-branch-agent/run-1/ada/task-9")
      ).toBeInTheDocument()
    )
    expect(screen.getByTestId("workspace-agent-branch-agent/run-2/cleo/task-3")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-agent-branch-dev")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace-agent-branch-feature/x")).not.toBeInTheDocument()
  })

  /**
   * A workspace root that is not a git repository is the ordinary case, not a
   * failure worth an alert.
   */
  it("degrades to empty when the root is not a repository", async () => {
    gitBranches.mockRejectedValue(new Error("not a git repository"))
    render(<AgentBranchesSection rootDir="/not-a-repo" />)
    await waitFor(() =>
      expect(screen.getByTestId("workspace-agent-branches-empty")).toBeInTheDocument()
    )
  })

  /**
   * Both writes are `approval: "interactive"`. A paired client that calls them
   * bare gets `interactive_approval_required`, so they must go through the
   * lease wrapper, and a client that cannot get one must be told why.
   */
  it("refuses the writes with a reason when the host will not allow them", async () => {
    gateVerdict = { available: false, reason: "Pair a host first" }
    render(<AgentBranchesSection rootDir="/repo" />)
    await waitFor(() =>
      expect(
        screen.getByTestId("workspace-agent-branch-agent/run-1/ada/task-9")
      ).toBeInTheDocument()
    )
    const row = screen.getByTestId("workspace-agent-branch-agent/run-1/ada/task-9")
    for (const button of Array.from(row.querySelectorAll("button"))) {
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute("title", "Pair a host first")
    }
  })
})
