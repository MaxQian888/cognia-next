/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SquadsSection } from "./squads-section"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"

const replaceMock = jest.fn()
let searchString = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(searchString),
}))

// The template gallery is a whole surface of its own with a store, a plugin
// registry and a router push; this suite is about the library around it.
jest.mock("@/components/settings/agent/agent-team-templates-section", () => ({
  AgentTeamTemplatesSection: () => <div data-testid="templates-gallery" />,
}))

function squad(id: string, name: string): AgentTeam {
  return {
    id,
    name,
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: {},
  } as unknown as AgentTeam
}

function seed(teams: AgentTeam[]) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: {} as never,
  })
}

beforeEach(() => {
  replaceMock.mockClear()
  searchString = ""
  seed([squad("a", "Alpha"), squad("b", "Bravo")])
})

describe("SquadsSection", () => {
  it("opens on the first Squad for someone who has some", () => {
    // The gallery is how you get your first one, not where you live.
    render(<SquadsSection />)
    expect(screen.getByTestId("squad-detail")).toBeInTheDocument()
    expect(screen.queryByTestId("templates-gallery")).not.toBeInTheDocument()
  })

  it("opens on the gallery for someone with none", () => {
    seed([])
    render(<SquadsSection />)
    expect(screen.getByTestId("templates-gallery")).toBeInTheDocument()
  })

  it("honours a deep link to one Squad", () => {
    searchString = "section=squads&squadTab=squad:b"
    render(<SquadsSection />)
    expect(screen.getByLabelText(/name/i)).toHaveValue("Bravo")
  })

  it("lands on a neighbour when the linked Squad is gone", () => {
    searchString = "section=squads&squadTab=squad:deleted"
    render(<SquadsSection />)
    expect(screen.getByLabelText(/name/i)).toHaveValue("Alpha")
  })

  it("keeps the rest of the query when it navigates", async () => {
    // Dropping `?section=squads` would bounce the user out of the section.
    searchString = "section=squads"
    render(<SquadsSection />)
    await userEvent.click(screen.getAllByTestId("squads-nav-squad")[1]!)
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("section=squads"), {
      scroll: false,
    })
    expect(replaceMock.mock.calls[0]![0]).toContain("squadTab=squad%3Ab")
  })

  it("lets `?focus=` win, so the anchor it scrolls to is mounted", () => {
    // `use-setting-focus` queries `[data-setting-id]`, which only exists once
    // the owning panel has rendered.
    searchString = "section=squads&squadTab=squad:a&focus=squad-templates-create"
    render(<SquadsSection />)
    expect(screen.getByTestId("templates-gallery")).toBeInTheDocument()
  })

  it("creates a Squad and goes straight to it", async () => {
    render(<SquadsSection />)
    await userEvent.click(screen.getByTestId("squads-nav-create"))
    expect(replaceMock).toHaveBeenCalledWith(expect.stringMatching(/squadTab=squad%3A/), {
      scroll: false,
    })
    expect(Object.keys(useAgentTeamStore.getState().teams)).toHaveLength(3)
  })

  it("moves the selection off a Squad it just deleted", async () => {
    searchString = "section=squads&squadTab=squad:a"
    render(<SquadsSection />)
    await userEvent.click(screen.getByTestId("squad-delete"))
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    // Onto the neighbour, not onto a pane addressing something that is gone.
    expect(replaceMock.mock.calls.at(-1)![0]).toContain("squadTab=squad%3Ab")
  })
})
