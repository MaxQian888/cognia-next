/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { MemoryFacets } from "@/lib/memory/history-filter"
import { MemoryFilterDrawer, type MemoryFilterDrawerProps } from "./memory-filter-drawer"

const facets: MemoryFacets = {
  types: [
    { value: "semantic", count: 3 },
    { value: "episodic", count: 1 },
  ],
  scopes: [],
  provenances: [],
  tags: [{ value: "tools", count: 2 }],
  projectMemoryKinds: [],
  projectIds: [{ value: "p1", count: 2 }],
  branches: [],
  freshness: [],
} as MemoryFacets

function setup(over: Partial<MemoryFilterDrawerProps> = {}) {
  const props: MemoryFilterDrawerProps = {
    open: true,
    onOpenChange: jest.fn(),
    facets,
    filter: {},
    onFilterChange: jest.fn(),
    projectNames: { p1: "Cognia" },
    sort: "recent",
    onSortChange: jest.fn(),
    ...over,
  }
  render(<MemoryFilterDrawer {...props} />)
  return props
}

// vaul reads pointer transforms jsdom does not compute, so chips are clicked
// with fireEvent rather than userEvent's full pointer sequence.
describe("MemoryFilterDrawer", () => {
  it("sorts from radio chips", () => {
    const props = setup()
    expect(screen.getByTestId("memory-drawer-sort-recent")).toHaveAttribute("aria-checked", "true")
    fireEvent.click(screen.getByTestId("memory-drawer-sort-importance"))
    expect(props.onSortChange).toHaveBeenCalledWith("importance")
  })

  it("shows only the facets the view contains, with counts and readable names", () => {
    setup()
    expect(screen.getByTestId("memory-drawer-types-episodic")).toHaveTextContent("1")
    expect(screen.getByTestId("memory-drawer-projectIds-p1")).toHaveTextContent("Cognia")
    expect(screen.queryByRole("group", { name: "Scope" })).toBeNull()
  })

  it("toggles a facet", () => {
    const props = setup({ filter: { types: ["semantic"] } })
    expect(screen.getByTestId("memory-drawer-types-semantic")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    fireEvent.click(screen.getByTestId("memory-drawer-types-episodic"))
    expect(props.onFilterChange).toHaveBeenCalledWith({ types: ["semantic", "episodic"] })
  })

  it("clears facets but keeps the query", () => {
    const props = setup({ filter: { types: ["semantic"], query: "tea" } })
    expect(screen.getByText("1 filter on")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("memory-drawer-clear"))
    expect(props.onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ query: "tea" }))
    expect(props.onFilterChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ types: ["semantic"] })
    )
  })

  it("disables clear with nothing to clear", () => {
    setup()
    expect(screen.getByTestId("memory-drawer-clear")).toBeDisabled()
  })
})
