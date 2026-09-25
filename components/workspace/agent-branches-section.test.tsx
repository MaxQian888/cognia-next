/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
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

  /**
   * Before the first read lands the list is unknown, not empty. Saying "no
   * agent branches" for a beat on a repository that has some is a small lie
   * the reader has no way to tell from the real answer.
   */
  it("shows a skeleton until the first read lands, then the answer", async () => {
    let answer: (branches: { name: string }[]) => void = () => {}
    gitBranches.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    render(<AgentBranchesSection rootDir="/repo" />)
    expect(screen.getByTestId("workspace-agent-branches-loading")).toHaveAttribute(
      "aria-busy",
      "true"
    )
    expect(screen.queryByTestId("workspace-agent-branches-empty")).not.toBeInTheDocument()

    await act(async () => answer([{ name: "dev" }]))
    expect(screen.getByTestId("workspace-agent-branches-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-agent-branches-loading")).not.toBeInTheDocument()
  })

  it("spins and refuses the refresh button while a read is out", async () => {
    render(<AgentBranchesSection rootDir="/repo" />)
    await screen.findByTestId("workspace-agent-branch-agent/run-1/ada/task-9")
    const refresh = screen.getByTestId("workspace-agent-branches-refresh")
    expect(refresh).toBeEnabled()
    expect(refresh.querySelector("svg")).not.toHaveClass("animate-spin")

    let answer: (branches: { name: string }[]) => void = () => {}
    gitBranches.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    fireEvent.click(refresh)
    expect(refresh).toBeDisabled()
    expect(refresh.querySelector("svg")).toHaveClass("animate-spin")
    fireEvent.click(refresh)
    expect(gitBranches).toHaveBeenCalledTimes(2)

    await act(async () => answer([]))
    expect(refresh).toBeEnabled()
    expect(refresh.querySelector("svg")).not.toHaveClass("animate-spin")
  })

  /**
   * Delete is a forced `-D`, and after a run has settled the branch is the only
   * trace of what it did. It asks first, and names the branch it will remove.
   */
  it("deletes a branch only after a confirmation that names it", async () => {
    gitDeleteBranch.mockResolvedValue(undefined)
    render(<AgentBranchesSection rootDir="/repo" />)
    const name = "agent/run-1/ada/task-9"
    fireEvent.click(await screen.findByTestId(`workspace-agent-branch-delete-${name}`))
    expect(gitDeleteBranch).not.toHaveBeenCalled()

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent(`deleteDescription:${name}`)
    fireEvent.click(screen.getByTestId("workspace-agent-branch-delete-confirm"))

    await waitFor(() => expect(gitDeleteBranch).toHaveBeenCalledWith("/repo", name, true))
    // The list re-reads after the delete, so the row goes away on the host's word.
    await waitFor(() => expect(gitBranches).toHaveBeenCalledTimes(2))
  })

  it("leaves the branch alone when the confirmation is cancelled", async () => {
    render(<AgentBranchesSection rootDir="/repo" />)
    fireEvent.click(
      await screen.findByTestId("workspace-agent-branch-delete-agent/run-2/cleo/task-3")
    )
    fireEvent.click(await screen.findByRole("button", { name: "cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(gitDeleteBranch).not.toHaveBeenCalled()
  })
})
