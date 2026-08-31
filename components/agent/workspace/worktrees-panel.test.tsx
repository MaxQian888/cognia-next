/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const gitBranchesMock = jest.fn()
const gitCheckoutBranchMock = jest.fn(async (..._a: unknown[]) => {})
const gitDeleteBranchMock = jest.fn(async (..._a: unknown[]) => {})
const runGitUserActionMock = jest.fn((_command: string, operation: () => Promise<unknown>) =>
  operation()
)
jest.mock("@/lib/git/commands", () => ({
  gitBranches: (...a: unknown[]) => gitBranchesMock(...a),
  gitCheckoutBranch: (...a: unknown[]) => gitCheckoutBranchMock(...a),
  gitDeleteBranch: (...a: unknown[]) => gitDeleteBranchMock(...a),
  runGitUserAction: (...a: unknown[]) =>
    (runGitUserActionMock as unknown as (...args: unknown[]) => unknown)(...a),
}))

// The panel now shows the live inventory above the reclaimed branches. Stubbed
// here so this suite stays about the branch list; the inventory has its own.
const inventoryRender = jest.fn()
jest.mock("@/components/workspace/workspace-environment-list", () => ({
  WorkspaceEnvironmentList: (props: { rootDir?: string; showCreate?: boolean }) => {
    inventoryRender(props)
    return <div data-testid="live-environments" data-root-dir={props.rootDir} />
  },
}))

const gateMock = jest.fn(() => ({ available: true, reason: null as string | null }))
jest.mock("@/hooks/workspace/use-workspace-command-gate", () => ({
  useWorkspaceCommandGate: () => gateMock,
}))

jest.mock("@/components/source-control/compare-refs-sheet", () => ({
  CompareRefsSheet: () => null,
}))
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }),
}))

import { WorktreesPanel } from "./worktrees-panel"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { GitBranch } from "@/types/git"

function branch(name: string): GitBranch {
  return { name, isCurrent: false, isRemote: false, upstream: null, ahead: 0, behind: 0 }
}

function makeTeam(workingDir?: string): AgentTeam {
  return {
    id: "t1",
    name: "T",
    config: { maxTeammates: 5, maxConcurrentTeammates: 3, ...(workingDir ? { workingDir } : {}) },
  } as unknown as AgentTeam
}

beforeEach(() => {
  jest.clearAllMocks()
  gateMock.mockReturnValue({ available: true, reason: null })
  runGitUserActionMock.mockImplementation((_command, operation) => operation())
  gitBranchesMock.mockReset()
  gitCheckoutBranchMock.mockClear()
  gitDeleteBranchMock.mockClear()
  gitBranchesMock.mockResolvedValue([])
})

describe("WorktreesPanel", () => {
  it("shows the live worktree inventory above the reclaimed branches", async () => {
    // The tab was named Worktrees and listed only branches, so it could read as
    // empty on a machine with live worktrees on disk.
    gitBranchesMock.mockResolvedValue([])
    render(<WorktreesPanel team={makeTeam("/repo")} />)

    expect(await screen.findByTestId("live-environments")).toHaveAttribute("data-root-dir", "/repo")
    expect(inventoryRender).toHaveBeenCalledWith(
      expect.objectContaining({ rootDir: "/repo", showCreate: true })
    )
  })

  it("only refuses when the team has no working directory", () => {
    // Previously this also refused off Tauri, so the whole tab was blank on a
    // paired phone or browser even though the host could answer.
    render(<WorktreesPanel team={makeTeam(undefined)} />)
    expect(screen.getByTestId("worktrees-desktop-only")).toBeInTheDocument()
    expect(gitBranchesMock).not.toHaveBeenCalled()
  })

  it("disables branch actions with a reason instead of hiding the tab", async () => {
    gateMock.mockReturnValue({ available: false, reason: "needs host.admin" })
    gitBranchesMock.mockResolvedValue([branch("agent/run1/Alice/t1")])
    render(<WorktreesPanel team={makeTeam("/repo")} />)

    const checkout = await screen.findByText("actions.checkout")
    expect(checkout.closest("button")).toBeDisabled()
    expect(checkout.closest("button")).toHaveAttribute("title", "needs host.admin")
  })

  it("shows the empty state when there are no agent branches", async () => {
    gitBranchesMock.mockResolvedValue([branch("main"), branch("dev")])
    render(<WorktreesPanel team={makeTeam("/repo")} />)
    expect(await screen.findByTestId("worktrees-empty")).toBeInTheDocument()
    // Only agent/* branches are listed — plain branches are filtered out.
    expect(screen.queryByText("main")).not.toBeInTheDocument()
  })

  it("lists only agent branches and can delete one", async () => {
    gitBranchesMock.mockResolvedValue([branch("agent/run1/Alice/t1"), branch("main")])
    render(<WorktreesPanel team={makeTeam("/repo")} />)

    expect(await screen.findByText("agent/run1/Alice/t1")).toBeInTheDocument()
    expect(screen.queryByText("main")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("actions.checkout"))
    expect(gitCheckoutBranchMock).toHaveBeenCalledWith("/repo", "agent/run1/Alice/t1")
    // Both writes are `approval: "interactive"`, so they must carry a lease.
    expect(runGitUserActionMock).toHaveBeenCalledWith("git_checkout_branch", expect.any(Function))

    fireEvent.click(screen.getByText("actions.delete"))
    await waitFor(() =>
      expect(gitDeleteBranchMock).toHaveBeenCalledWith("/repo", "agent/run1/Alice/t1", true)
    )
    expect(runGitUserActionMock).toHaveBeenCalledWith("git_delete_branch", expect.any(Function))
  })
})
