/**
 * @jest-environment jsdom
 */

import { act, render, renderHook, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Team } from "@cognia/agent-config-types"

let orderedTeams: Team[] | undefined = []
jest.mock("@/hooks/shell/use-ordered-teams", () => ({
  useOrderedTeams: () => ({ teams: orderedTeams }),
}))

const switchToTeamMock = jest.fn()
jest.mock("@/components/shell/use-shell-nav", () => ({
  useShellNav: () => ({ switchToTeam: (id: string) => switchToTeamMock(id) }),
}))

const duplicateTeamMock = jest.fn(async (_id: string): Promise<Team> => {
  throw new Error("unset")
})
jest.mock("@/lib/db/teams", () => ({
  duplicateTeam: (id: string) => duplicateTeamMock(id),
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/squads",
  useSearchParams: () => new URLSearchParams(),
}))

type ToastOptions = { description?: string; action?: { label: string; onClick: () => void } }
const toastSuccessMock = jest.fn((_msg: string, _opts?: ToastOptions) => undefined)
const toastErrorMock = jest.fn((_msg: string, _opts?: ToastOptions) => undefined)
jest.mock("sonner", () => ({
  toast: {
    success: (msg: string, opts?: ToastOptions) => toastSuccessMock(msg, opts),
    error: (msg: string, opts?: ToastOptions) => toastErrorMock(msg, opts),
  },
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode; href?: string }) => (
    <a {...props}>{children}</a>
  ),
}))

import { BuiltInTeamsSection, filterBuiltInTeams, useBuiltInTeams } from "./built-in-teams"

function team(over: Partial<Team>): Team {
  return {
    id: "team_x",
    name: "Team",
    members: [{ characterId: "c1" }, { characterId: "c2" }],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Team
}

const brainstorm = team({
  id: "team_builtin_brainstorm",
  name: "Brainstorm Squad",
  description: "Diverge, then converge",
  isBuiltIn: true,
})
const research = team({ id: "team_builtin_research_squad", name: "Research", isBuiltIn: true })
const mine = team({ id: "team_mine", name: "My team", isBuiltIn: false })

beforeEach(() => {
  orderedTeams = []
  switchToTeamMock.mockClear()
  duplicateTeamMock.mockReset()
  pushMock.mockClear()
  toastSuccessMock.mockClear()
  toastErrorMock.mockClear()
})

describe("useBuiltInTeams", () => {
  it("keeps only built-in Teams, in the sidebar's order", () => {
    orderedTeams = [research, mine, brainstorm]
    const { result } = renderHook(() => useBuiltInTeams())
    expect(result.current.teams.map((t) => t.id)).toEqual([
      "team_builtin_research_squad",
      "team_builtin_brainstorm",
    ])
    expect(result.current.loading).toBe(false)
  })

  it("reports loading until the first read resolves", () => {
    orderedTeams = undefined
    const { result } = renderHook(() => useBuiltInTeams())
    expect(result.current.teams).toEqual([])
    expect(result.current.loading).toBe(true)
  })
})

describe("filterBuiltInTeams", () => {
  it("matches name and description case-insensitively and keeps all on a blank query", () => {
    expect(filterBuiltInTeams([brainstorm, research], "  ")).toHaveLength(2)
    expect(filterBuiltInTeams([brainstorm, research], "CONVERGE").map((t) => t.id)).toEqual([
      "team_builtin_brainstorm",
    ])
    expect(filterBuiltInTeams([brainstorm, research], "resea").map((t) => t.id)).toEqual([
      "team_builtin_research_squad",
    ])
    expect(filterBuiltInTeams([brainstorm], "nothing")).toEqual([])
  })
})

describe("<BuiltInTeamsSection />", () => {
  it("renders nothing without Teams to show", () => {
    const { container } = render(<BuiltInTeamsSection teams={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists each Team labelled built-in, with its members and a way to manage them", () => {
    render(<BuiltInTeamsSection teams={[brainstorm, research]} />)
    const section = screen.getByRole("region", { name: "Built-in teams" })
    expect(section).toBeInTheDocument()
    expect(screen.getAllByText("Built-in")).toHaveLength(2)
    expect(screen.getByText(/2 members · Diverge, then converge/)).toBeInTheDocument()
    expect(screen.getByTestId("squad-builtin-manage")).toHaveAttribute(
      "href",
      "/settings?section=teams"
    )
    // Read-only: no edit or delete affordance on a built-in row.
    expect(screen.queryByRole("button", { name: /^(delete|edit)\b/i })).not.toBeInTheDocument()
  })

  it("narrows with the Squad search", () => {
    render(<BuiltInTeamsSection teams={[brainstorm, research]} query="research" />)
    expect(screen.queryByTestId("squad-builtin-row-team_builtin_brainstorm")).toBeNull()
    expect(screen.getByTestId("squad-builtin-row-team_builtin_research_squad")).toBeInTheDocument()
  })

  it("opens a Team by switching the chat scope to it", async () => {
    const user = userEvent.setup()
    render(<BuiltInTeamsSection teams={[brainstorm]} />)
    await user.click(screen.getByRole("button", { name: "Open Brainstorm Squad conversations" }))
    expect(switchToTeamMock).toHaveBeenCalledWith("team_builtin_brainstorm")
  })

  it("duplicates a Team into an editable copy and links to where it is edited", async () => {
    const user = userEvent.setup()
    duplicateTeamMock.mockResolvedValueOnce(
      team({ id: "team_copy", name: "Brainstorm Squad (copy)", isBuiltIn: false })
    )
    render(<BuiltInTeamsSection teams={[brainstorm]} />)
    await user.click(
      screen.getByRole("button", { name: "Duplicate Brainstorm Squad into an editable team" })
    )
    expect(duplicateTeamMock).toHaveBeenCalledWith("team_builtin_brainstorm")
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Created Brainstorm Squad (copy)",
      expect.objectContaining({ action: expect.objectContaining({ label: "Edit" }) })
    )
    act(() => toastSuccessMock.mock.calls[0]?.[1]?.action?.onClick())
    expect(pushMock).toHaveBeenCalledWith("/settings?section=teams")
    expect(screen.getByTestId("squad-builtin-duplicate-team_builtin_brainstorm")).not.toBeDisabled()
  })

  it("reports a failed duplicate and re-enables the button", async () => {
    const user = userEvent.setup()
    duplicateTeamMock.mockRejectedValueOnce(new Error("Team team_builtin_brainstorm not found"))
    render(<BuiltInTeamsSection teams={[brainstorm]} />)
    await user.click(screen.getByTestId("squad-builtin-duplicate-team_builtin_brainstorm"))
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't duplicate Brainstorm Squad", {
      description: "Team team_builtin_brainstorm not found",
    })
    expect(screen.getByTestId("squad-builtin-duplicate-team_builtin_brainstorm")).not.toBeDisabled()
  })
})
