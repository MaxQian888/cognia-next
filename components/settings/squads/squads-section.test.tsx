/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
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

// `deleteTeam` purges the Squad's durable runtime rows before it drops the
// store entry. That is Dexie's job and has its own suite; stubbed here so a
// delete settles the way it does once the purge succeeds.
jest.mock("@/lib/db/agent-team-runtime", () => ({
  purgeAgentTeam: jest.fn(async () => undefined),
}))

// Cold-load detection has its own suite; here it is posed directly.
let mockHydrating = false
jest.mock("@/hooks/squads/use-squad-definitions-hydrating", () => ({
  useSquadDefinitionsHydrating: () => mockHydrating,
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
  mockHydrating = false
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

  // The narrow-pane sheet used to reuse the trigger's verb phrase, so the
  // list opened under a heading that read like a button: "Show Squad list".
  it("titles the list sheet with what it holds, not the button that opened it", async () => {
    render(<SquadsSection />)
    await userEvent.click(screen.getByTestId("squads-nav-sheet-trigger"))
    expect(await screen.findByRole("dialog", { name: "Squads" })).toBeInTheDocument()
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

  it("names the new Squad and its lead from translations, not from defaults", async () => {
    // `CreateTeamInput` takes `leadName`; an excess property is silently
    // ignored, so a typo here shows up as an English "Team Lead" on a
    // Chinese install rather than as an error.
    render(<SquadsSection />)
    await userEvent.click(screen.getByTestId("squads-nav-create"))
    const created = Object.values(useAgentTeamStore.getState().teams).find(
      (t) => !["a", "b"].includes(t.id)
    )!
    expect(created.name).toBe("New Squad")
    const lead = Object.values(useAgentTeamStore.getState().teammates).find(
      (m) => m.teamId === created.id
    )
    expect(lead?.name).toBe("Squad Lead")
  })

  it("moves the selection off a Squad it just deleted", async () => {
    searchString = "section=squads&squadTab=squad:a"
    render(<SquadsSection />)
    await userEvent.click(screen.getByTestId("squad-delete"))
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    // Onto the neighbour, not onto a pane addressing something that is gone.
    // `deleteTeam` is async, so the move lands a tick after the click.
    await waitFor(() => expect(replaceMock.mock.calls.at(-1)?.[0]).toContain("squadTab=squad%3Ab"))
  })

  /** Settings configures, `/squads` runs: the pane links back to what it is doing. */
  it("links the open Squad to its live view, with its status beside the name", () => {
    searchString = "section=squads&squadTab=squad:b"
    seed([{ ...squad("a", "Alpha") }, { ...squad("b", "Bravo"), status: "executing" } as AgentTeam])
    render(<SquadsSection />)
    expect(screen.getByTestId("squad-detail-open-live")).toHaveAttribute("href", "/squads?id=b")
    expect(screen.getByText("Executing")).toBeInTheDocument()
  })

  it("offers no live view on the template gallery", () => {
    searchString = "section=squads&squadTab=templates"
    render(<SquadsSection />)
    expect(screen.queryByTestId("squad-detail-open-live")).not.toBeInTheDocument()
  })

  /**
   * On a cold load the store is empty while Dexie still holds the Squads. The
   * pane used to resolve to the gallery and crossfade to the first Squad.
   */
  it("shows neither the gallery nor an empty claim while definitions load", () => {
    mockHydrating = true
    seed([])
    render(<SquadsSection />)
    expect(screen.queryByTestId("templates-gallery")).not.toBeInTheDocument()
    expect(screen.queryByTestId("squad-detail")).not.toBeInTheDocument()
    expect(screen.getByTestId("squads-nav-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("squads-nav-empty")).not.toBeInTheDocument()
  })
})
