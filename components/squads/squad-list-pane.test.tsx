/** @jest-environment jsdom */

// The shared list. Both hosts render this component, so its cases are about
// what a row says and what an empty list offers, not about either layout.

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Team } from "@cognia/agent-config-types"

// The built-in rows open a chat scope; the shell nav is not under test here.
const switchToTeamMock = jest.fn()
jest.mock("@/components/shell/use-shell-nav", () => ({
  useShellNav: () => ({ switchToTeam: (id: string) => switchToTeamMock(id) }),
}))
jest.mock("@/lib/db/teams", () => ({ duplicateTeam: jest.fn() }))

import { SquadListPane } from "./squad-list-pane"
import type { SquadFleetRow, SquadFleetSnapshot } from "@/hooks/squads/use-squad-fleet"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"

const setSelectedId = jest.fn()
const setQuery = jest.fn()
const setFilter = jest.fn()
const clearFilters = jest.fn()

function route(over: Partial<SquadRouteState> = {}): SquadRouteState {
  return {
    selectedId: undefined,
    runId: undefined,
    runStatus: "all",
    tab: undefined,
    query: "",
    filter: "all",
    narrowed: false,
    runHref: (runId) => `/squads?tab=runs&run=${runId}`,
    setSelectedId,
    setRunId: jest.fn(),
    setRunStatus: jest.fn(),
    setTab: jest.fn(),
    setQuery,
    setFilter,
    clearFilters,
    ...over,
  }
}

function row(over: Partial<SquadFleetRow> = {}): SquadFleetRow {
  return {
    id: "a",
    name: "Alpha",
    status: "idle",
    memberCount: 2,
    waiting: false,
    live: false,
    ...over,
  }
}

function fleet(over: Partial<SquadFleetSnapshot> = {}): SquadFleetSnapshot {
  const squads = over.squads ?? [row()]
  return {
    squads,
    total: squads.length,
    live: squads.filter((s) => s.live).length,
    waiting: squads.filter((s) => s.waiting).length,
    loading: false,
    ...over,
  }
}

beforeEach(() => jest.clearAllMocks())

describe("layout", () => {
  // Radix sizes the viewport's child as a table that grows to its widest
  // `truncate` line; on a phone that pushed the empty state off-centre and
  // the built-in cards past the right edge.
  it("keeps the scroll content to the pane width", () => {
    render(<SquadListPane fleet={fleet()} route={route()} />)
    expect(screen.getByTestId("squad-fleet-scroll").className).toContain(
      "[&_[data-slot=scroll-area-viewport]>div]:!block"
    )
  })
})

describe("rows", () => {
  it("names the Squad and its roster size", () => {
    render(<SquadListPane fleet={fleet()} route={route()} />)
    expect(screen.getByTestId("squad-fleet-row")).toHaveTextContent("Alpha")
    expect(screen.getByTestId("squad-fleet-row")).toHaveTextContent("2 members")
  })

  /**
   * A `role="listitem"` on a `<button>` inside a plain `<div role="list">` is
   * not a list to a screen reader. Real `<ul>` / `<li>` is, and the row itself
   * stays the button.
   */
  it("is a real list, not a div wearing a list role", () => {
    render(<SquadListPane fleet={fleet()} route={route()} />)
    const list = screen.getByRole("list")
    expect(list.tagName).toBe("UL")
    expect(screen.getAllByRole("listitem")[0]!.tagName).toBe("LI")
  })

  it("marks the selected row for assistive tech, not only in colour", () => {
    render(<SquadListPane fleet={fleet()} route={route({ selectedId: "a" })} />)
    expect(screen.getByTestId("squad-fleet-row")).toHaveAttribute("aria-current", "true")
  })

  it("toggles the selection off when the open row is clicked again", async () => {
    render(<SquadListPane fleet={fleet()} route={route({ selectedId: "a" })} />)
    await userEvent.click(screen.getByTestId("squad-fleet-row"))
    expect(setSelectedId).toHaveBeenCalledWith(undefined)
  })

  /** A blocked Squad's badge replaces its status: needing you IS its status. */
  it("says a Squad needs you instead of showing its status badge", () => {
    render(<SquadListPane fleet={fleet({ squads: [row({ waiting: true })] })} route={route()} />)
    expect(screen.getByTestId("squad-fleet-waiting")).toBeInTheDocument()
  })
})

describe("filter counts", () => {
  /**
   * The counts live on the toggles that act on them. A stat strip above
   * repeated the same two numbers one row higher, away from the control.
   */
  it("counts every Squad, what needs you and what is working on the toggles", () => {
    render(
      <SquadListPane
        fleet={fleet({ squads: [row({ waiting: true }), row({ id: "b", name: "B", live: true })] })}
        route={route()}
      />
    )
    expect(screen.getByTestId("squad-fleet-filter-all-count")).toHaveTextContent("2")
    expect(screen.getByTestId("squad-fleet-filter-waiting-count")).toHaveTextContent("1")
    expect(screen.getByTestId("squad-fleet-filter-live-count")).toHaveTextContent("1")
  })

  /** The number is decoration to sight, so the toggle's name carries it. */
  it("names each toggle with its count for assistive tech", () => {
    render(<SquadListPane fleet={fleet({ squads: [row({ waiting: true })] })} route={route()} />)
    expect(screen.getByTestId("squad-fleet-filter-waiting")).toHaveAccessibleName("Needs you, 1")
  })

  it("offers no search or filter when there is nothing to narrow", () => {
    render(<SquadListPane fleet={fleet({ squads: [], total: 0 })} route={route()} />)
    expect(screen.queryByTestId("squad-fleet-search")).not.toBeInTheDocument()
    expect(screen.queryByTestId("squad-fleet-filter-all")).not.toBeInTheDocument()
  })
})

describe("variant", () => {
  /** The desktop rail paints its own ground; a frame per row was a card per name. */
  it("sets rail rows straight on the rail's ground", () => {
    render(<SquadListPane fleet={fleet()} route={route()} />)
    const list = screen.getByTestId("squad-fleet-list")
    expect(list).not.toHaveAttribute("data-surface-layer")
    expect(screen.getByTestId("squad-fleet-row")).not.toHaveAttribute("data-surface-layer")
  })

  /** On a phone the list is the page, over the wallpaper: one surface for all rows. */
  it("groups page rows on one raised surface", () => {
    render(<SquadListPane fleet={fleet()} route={route()} variant="page" />)
    expect(screen.getByTestId("squad-fleet-list")).toHaveAttribute("data-surface-layer", "raised")
    expect(screen.getByTestId("squad-fleet-row")).not.toHaveAttribute("data-surface-layer")
  })
})

describe("narrowing", () => {
  it("reports typing and filtering up to the route", async () => {
    render(<SquadListPane fleet={fleet()} route={route()} />)
    await userEvent.type(screen.getByTestId("squad-fleet-search"), "r")
    expect(setQuery).toHaveBeenCalledWith("r")
    await userEvent.click(screen.getByTestId("squad-fleet-filter-waiting"))
    expect(setFilter).toHaveBeenCalledWith("waiting")
  })

  // The URL lags a keystroke behind. Bound to it, the box reset itself under
  // the typist; this route never catches up at all, which is the worst case.
  it("keeps what is typed while the URL catches up", async () => {
    render(<SquadListPane fleet={fleet()} route={route({ query: "" })} />)
    const search = screen.getByTestId("squad-fleet-search")
    await userEvent.type(search, "ab")
    expect(search).toHaveValue("ab")
    expect(setQuery).toHaveBeenLastCalledWith("ab")
  })

  // Mid-composition text is pinyin, not a query. Writing it to the URL both
  // filtered on "ni" and, on the round trip, committed the IME half-typed.
  it("writes nothing to the URL until an IME composition ends", () => {
    render(<SquadListPane fleet={fleet()} route={route({ query: "" })} />)
    const search = screen.getByTestId("squad-fleet-search")
    fireEvent.compositionStart(search)
    fireEvent.input(search, { target: { value: "ni" }, isComposing: true })
    expect(search).toHaveValue("ni")
    expect(setQuery).not.toHaveBeenCalled()
    fireEvent.input(search, { target: { value: "你" }, isComposing: true })
    fireEvent.compositionEnd(search)
    expect(setQuery).toHaveBeenCalledTimes(1)
    expect(setQuery).toHaveBeenCalledWith("你")
  })

  it("follows a query the URL gets from elsewhere", () => {
    const { rerender } = render(<SquadListPane fleet={fleet()} route={route({ query: "" })} />)
    rerender(<SquadListPane fleet={fleet()} route={route({ query: "alpha" })} />)
    expect(screen.getByTestId("squad-fleet-search")).toHaveValue("alpha")
  })

  /**
   * "No Squads yet" is a claim about the user's data. "No Squads match" is a
   * claim about the filter, and only one of them is true here.
   */
  it("tells an empty filter apart from an empty workspace", async () => {
    render(
      <SquadListPane
        fleet={fleet({ squads: [], total: 3 })}
        route={route({ query: "zzz", narrowed: true })}
      />
    )
    expect(screen.getByTestId("empty-state")).toHaveTextContent("No Squads match")
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(clearFilters).toHaveBeenCalled()
  })
})

describe("loading and empty", () => {
  /**
   * Dexie not having answered is not the same as the user having no Squads.
   * The empty state used to make that claim for the whole of the first read.
   */
  it("shows a skeleton rather than claiming the workspace is empty", () => {
    render(<SquadListPane fleet={fleet({ squads: [], total: 0, loading: true })} route={route()} />)
    expect(screen.getByTestId("squad-fleet-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument()
  })

  it("offers a way out of an empty workspace", async () => {
    const onCreate = jest.fn()
    render(
      <SquadListPane fleet={fleet({ squads: [], total: 0 })} route={route()} onCreate={onCreate} />
    )
    await userEvent.click(screen.getByTestId("squad-fleet-create"))
    expect(onCreate).toHaveBeenCalled()
  })

  it("omits the CTA when the host has nowhere to create from", () => {
    render(<SquadListPane fleet={fleet({ squads: [], total: 0 })} route={route()} />)
    expect(screen.queryByTestId("squad-fleet-create")).not.toBeInTheDocument()
  })

  /** "New Squad" lives in each host's header, which is always on screen. */
  it("leaves creating to the host's header once there are rows", () => {
    render(<SquadListPane fleet={fleet()} route={route()} onCreate={jest.fn()} />)
    expect(screen.queryByTestId("squad-fleet-create")).not.toBeInTheDocument()
  })

  /**
   * Beside a centre pane that already shows the full empty state, a second
   * illustrated "No Squads yet" said the same thing twice.
   */
  it("says an empty workspace in one line when asked to be quiet", () => {
    render(
      <SquadListPane
        fleet={fleet({ squads: [], total: 0 })}
        route={route()}
        onCreate={jest.fn()}
        emptyStyle="quiet"
      />
    )
    expect(screen.getByTestId("squad-fleet-empty-quiet")).toHaveTextContent("No Squads yet")
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument()
    expect(screen.queryByTestId("squad-fleet-create")).not.toBeInTheDocument()
  })

  /** A filter with no hits still needs its way out, quiet or not. */
  it("keeps the clear-filters way out when quiet", () => {
    render(
      <SquadListPane
        fleet={fleet({ squads: [], total: 3 })}
        route={route({ query: "zzz", narrowed: true })}
        emptyStyle="quiet"
      />
    )
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument()
  })
})

describe("built-in Teams", () => {
  const builtIns = [
    { id: "team_builtin_brainstorm", name: "Brainstorm Squad", members: [], isBuiltIn: true },
    { id: "team_builtin_research_squad", name: "Research", members: [], isBuiltIn: true },
  ] as unknown as Team[]

  /**
   * The sidebar offers these as scopes while the page said "No Squads yet"
   * with nothing explaining them.
   */
  it("lists them in their own section while the Squad count stays at zero", () => {
    render(
      <SquadListPane
        fleet={fleet({ squads: [], total: 0 })}
        route={route()}
        builtInTeams={builtIns}
      />
    )
    expect(screen.getByText("No Squads yet")).toBeInTheDocument()
    expect(screen.getByTestId("squad-builtin-teams")).toBeInTheDocument()
    expect(screen.getAllByTestId(/^squad-builtin-row-/)).toHaveLength(2)
    // Not Squad rows: nothing selects them into the Squad inspector.
    expect(screen.queryAllByTestId("squad-fleet-row")).toHaveLength(0)
  })

  it("points the empty state at the built-ins", () => {
    render(
      <SquadListPane
        fleet={fleet({ squads: [], total: 0 })}
        route={route()}
        builtInTeams={builtIns}
      />
    )
    expect(
      screen.getByText(/The 2 built-in teams below are ready to use right now\./)
    ).toBeInTheDocument()
  })

  it("keeps the plain empty copy when there are none", () => {
    render(<SquadListPane fleet={fleet({ squads: [], total: 0 })} route={route()} />)
    expect(screen.queryByTestId("squad-builtin-teams")).not.toBeInTheDocument()
    expect(screen.queryByText(/built-in teams below/)).not.toBeInTheDocument()
  })

  /** With no Squads of their own, the built-ins are the only thing here to use. */
  it("unfolds while the workspace has no Squads, and folds once it has some", () => {
    const { unmount } = render(
      <SquadListPane
        fleet={fleet({ squads: [], total: 0 })}
        route={route()}
        builtInTeams={builtIns}
      />
    )
    expect(screen.getByTestId("squad-builtin-teams")).toHaveAttribute("data-open", "true")
    unmount()
    render(<SquadListPane fleet={fleet()} route={route()} builtInTeams={builtIns} />)
    expect(screen.getByTestId("squad-builtin-teams")).toHaveAttribute("data-open", "false")
    expect(screen.queryAllByTestId(/^squad-builtin-row-/)).toHaveLength(0)
  })

  it("sits below the user's Squads", () => {
    render(<SquadListPane fleet={fleet()} route={route()} builtInTeams={builtIns} />)
    const list = screen.getByTestId("squad-fleet-list")
    const section = screen.getByTestId("squad-builtin-teams")
    expect(list.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("drops out under a run-state filter, which a Team cannot match", () => {
    render(
      <SquadListPane
        fleet={fleet()}
        route={route({ filter: "live", narrowed: true })}
        builtInTeams={builtIns}
      />
    )
    expect(screen.queryByTestId("squad-builtin-teams")).not.toBeInTheDocument()
  })

  it("narrows with the search box", () => {
    render(
      <SquadListPane
        fleet={fleet()}
        route={route({ query: "research", narrowed: true })}
        builtInTeams={builtIns}
      />
    )
    expect(screen.getAllByTestId(/^squad-builtin-row-/)).toHaveLength(1)
    expect(screen.getByTestId("squad-builtin-row-team_builtin_research_squad")).toBeInTheDocument()
  })
})
