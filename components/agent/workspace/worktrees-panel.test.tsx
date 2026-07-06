/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const gitBranchesMock = jest.fn()
const gitCheckoutBranchMock = jest.fn(async (..._a: unknown[]) => {})
const gitDeleteBranchMock = jest.fn(async (..._a: unknown[]) => {})
jest.mock("@/lib/git/commands", () => ({
  gitBranches: (...a: unknown[]) => gitBranchesMock(...a),
  gitCheckoutBranch: (...a: unknown[]) => gitCheckoutBranchMock(...a),
  gitDeleteBranch: (...a: unknown[]) => gitDeleteBranchMock(...a),
}))

jest.mock("@/components/source-control/compare-refs-sheet", () => ({
  CompareRefsSheet: () => null,
}))
jest.mock("@/lib/logging", () => ({
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
  isTauriMock.mockReturnValue(true)
  gitBranchesMock.mockReset()
  gitCheckoutBranchMock.mockClear()
  gitDeleteBranchMock.mockClear()
  gitBranchesMock.mockResolvedValue([])
})

describe("WorktreesPanel", () => {
  it("renders the desktop-only placeholder on web", () => {
    isTauriMock.mockReturnValue(false)
    render(<WorktreesPanel team={makeTeam("/repo")} />)
    expect(screen.getByTestId("worktrees-desktop-only")).toBeInTheDocument()
    expect(gitBranchesMock).not.toHaveBeenCalled()
  })

  it("renders the desktop-only placeholder when the team has no workingDir", () => {
    render(<WorktreesPanel team={makeTeam(undefined)} />)
    expect(screen.getByTestId("worktrees-desktop-only")).toBeInTheDocument()
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

    fireEvent.click(screen.getByText("actions.delete"))
    await waitFor(() =>
      expect(gitDeleteBranchMock).toHaveBeenCalledWith("/repo", "agent/run1/Alice/t1", true)
    )
  })
})
