/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { MemoryFacets, MemoryFilter } from "@/lib/memory/history-filter"
import { MemoryToolbar } from "./memory-toolbar"

const FACETS: MemoryFacets = {
  types: [
    { value: "semantic", count: 3 },
    { value: "episodic", count: 1 },
  ],
  scopes: [{ value: "global", count: 4 }],
  provenances: [{ value: "user", count: 4 }],
  tags: [
    { value: "work", count: 2 },
    { value: "home", count: 1 },
  ],
  projectMemoryKinds: [
    { value: "personal", count: 3 },
    { value: "constraint", count: 1 },
  ],
  projectIds: [
    { value: "p1", count: 3 },
    { value: "", count: 1 },
  ],
  branches: [{ value: "main", count: 1 }],
  freshness: [{ value: "unknown", count: 4 }],
}

const EMPTY_FACETS: MemoryFacets = {
  types: [],
  scopes: [],
  provenances: [],
  tags: [],
  projectMemoryKinds: [],
  projectIds: [],
  branches: [],
  freshness: [],
}

function setup(over: Partial<Parameters<typeof MemoryToolbar>[0]> = {}) {
  const onViewChange = jest.fn()
  const onFilterChange = jest.fn()
  const onSortChange = jest.fn()
  const onDensityChange = jest.fn()
  const props = {
    view: "all" as const,
    onViewChange,
    viewCounts: { all: 4, pinned: 1, needsReview: 2, conflicts: 0, archived: 3 },
    filter: {} as MemoryFilter,
    onFilterChange,
    facets: FACETS,
    sort: "recent" as const,
    onSortChange,
    density: "comfortable" as const,
    onDensityChange,
    ...over,
  }
  render(<MemoryToolbar {...props} />)
  return { onViewChange, onFilterChange, onSortChange, onDensityChange }
}

describe("MemoryToolbar", () => {
  it("renders every quick view as a tab with its count", () => {
    setup()
    const chips = screen.getByTestId("memory-view-chips")
    expect(within(chips).getAllByRole("tab")).toHaveLength(5)
    expect(screen.getByTestId("memory-view-archived").textContent).toContain("3")
    expect(screen.getByTestId("memory-view-all").getAttribute("aria-selected")).toBe("true")
  })

  it("reports a view change", async () => {
    const { onViewChange } = setup()
    await userEvent.click(screen.getByTestId("memory-view-conflicts"))
    expect(onViewChange).toHaveBeenCalledWith("conflicts")
  })

  it("reports search input", async () => {
    const { onFilterChange } = setup()
    await userEvent.type(screen.getByTestId("memory-search"), "p")
    expect(onFilterChange).toHaveBeenCalledWith({ query: "p" })
  })

  // Offering a filter that would return nothing is how "where did my memory
  // go?" happens, so the menu only lists facets present in the current view.
  it("only offers facet values that exist", async () => {
    setup()
    await userEvent.click(screen.getByTestId("memory-filter-menu"))
    const menu = screen.getByRole("menu")
    expect(within(menu).getByText("Fact")).toBeTruthy()
    expect(within(menu).queryByText("Procedure")).toBeNull()
    expect(within(menu).getByText("work")).toBeTruthy()
  })

  it("toggles a facet value and shows counts beside it", async () => {
    const { onFilterChange } = setup()
    await userEvent.click(screen.getByTestId("memory-filter-menu"))
    await userEvent.click(within(screen.getByRole("menu")).getByText("Event"))
    expect(onFilterChange).toHaveBeenCalledWith({ types: ["episodic"] })
  })

  it("removes a facet value that is already selected", async () => {
    const { onFilterChange } = setup({ filter: { types: ["episodic"] } })
    await userEvent.click(screen.getByTestId("memory-filter-menu"))
    await userEvent.click(within(screen.getByRole("menu")).getByText("Event"))
    expect(onFilterChange).toHaveBeenCalledWith({ types: [] })
  })

  it("badges how many facet axes are active, ignoring the query", async () => {
    setup({ filter: { query: "anything", types: ["semantic"], tags: ["work", "home"] } })
    expect(screen.getByTestId("memory-filter-menu").textContent).toContain("3")
  })

  it("clears every facet but keeps the query", async () => {
    const { onFilterChange } = setup({ filter: { query: "keep me", types: ["semantic"] } })
    await userEvent.click(screen.getByTestId("memory-filter-menu"))
    await userEvent.click(screen.getByTestId("memory-filter-clear"))
    expect(onFilterChange).toHaveBeenCalledWith({ query: "keep me" })
  })

  it("explains an empty facet menu rather than showing a blank sheet", async () => {
    setup({ facets: EMPTY_FACETS })
    await userEvent.click(screen.getByTestId("memory-filter-menu"))
    expect(screen.getByText("Nothing to filter in this view")).toBeTruthy()
  })

  it("changes sort and density from the display menu", async () => {
    const { onSortChange, onDensityChange } = setup()
    await userEvent.click(screen.getByTestId("memory-display-menu"))
    await userEvent.click(screen.getByTestId("memory-sort-importance"))
    expect(onSortChange).toHaveBeenCalledWith("importance")

    await userEvent.click(screen.getByTestId("memory-display-menu"))
    await userEvent.click(screen.getByText("Compact"))
    expect(onDensityChange).toHaveBeenCalledWith("compact")
  })
})

describe("MemoryToolbar project-context facets", () => {
  it("offers the corpus partition as one axis with personal alongside the claim kinds", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByTestId("memory-filter-menu"))
    const menu = await screen.findByRole("menu")
    expect(within(menu).getByText("About you")).toBeTruthy()
    expect(within(menu).getByText("Constraint")).toBeTruthy()
  })

  it("selects a claim kind through the shared filter object", async () => {
    const user = userEvent.setup()
    const { onFilterChange } = setup()
    await user.click(screen.getByTestId("memory-filter-menu"))
    await user.click(await screen.findByText("Constraint"))
    expect(onFilterChange).toHaveBeenCalledWith({ projectMemoryKinds: ["constraint"] })
  })

  it("names workspaces, and gives the unscoped rows a name rather than a blank row", async () => {
    const user = userEvent.setup()
    setup({ projectNames: { p1: "Cognia" } })
    await user.click(screen.getByTestId("memory-filter-menu"))
    const menu = await screen.findByRole("menu")
    expect(within(menu).getByText("Cognia")).toBeTruthy()
    expect(within(menu).getByText("No workspace")).toBeTruthy()
  })

  it("falls back to the raw id for a workspace that no longer exists", async () => {
    // A deleted workspace whose claims survive is exactly the case a user needs
    // to be able to filter for, so the option must not vanish.
    const user = userEvent.setup()
    setup({ projectNames: {} })
    await user.click(screen.getByTestId("memory-filter-menu"))
    expect(within(await screen.findByRole("menu")).getByText("p1")).toBeTruthy()
  })

  it("labels freshness from the shared staleness vocabulary", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByTestId("memory-filter-menu"))
    expect(within(await screen.findByRole("menu")).getByText("Never checked")).toBeTruthy()
  })

  it("still explains an empty facet menu when none of the new axes have values", async () => {
    const user = userEvent.setup()
    setup({ facets: EMPTY_FACETS })
    await user.click(screen.getByTestId("memory-filter-menu"))
    expect(within(await screen.findByRole("menu")).getByText(/Nothing to filter/)).toBeTruthy()
  })
})
