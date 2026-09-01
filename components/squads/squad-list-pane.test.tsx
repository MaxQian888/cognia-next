/** @jest-environment jsdom */

// The shared list. Both hosts render this component, so its cases are about
// what a row says and what an empty list offers, not about either layout.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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
    tab: undefined,
    query: "",
    filter: "all",
    narrowed: false,
    setSelectedId,
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

describe("headline stats", () => {
  /**
   * The page computed the waiting count, sorted by it, and never showed it,
   * which made the most actionable number on the screen one you had to infer
   * from badge colours.
   */
  it("headlines what needs you and what is working", () => {
    render(
      <SquadListPane
        fleet={fleet({ squads: [row({ waiting: true }), row({ id: "b", name: "B", live: true })] })}
        route={route()}
      />
    )
    expect(screen.getByTestId("stat-waiting")).toHaveTextContent("1")
    expect(screen.getByTestId("stat-working")).toHaveTextContent("1")
  })

  it("offers no search, filter or stats when there is nothing to narrow", () => {
    render(<SquadListPane fleet={fleet({ squads: [], total: 0 })} route={route()} />)
    expect(screen.queryByTestId("squad-fleet-search")).not.toBeInTheDocument()
    expect(screen.queryByTestId("squad-fleet-stats")).not.toBeInTheDocument()
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

  /** A control that appears only when the list is empty reads as a bug. */
  it("keeps the CTA reachable once there are rows", () => {
    render(<SquadListPane fleet={fleet()} route={route()} onCreate={jest.fn()} />)
    expect(screen.getByTestId("squad-fleet-create")).toBeInTheDocument()
  })
})
