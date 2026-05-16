/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillFilterSheet } from "./skill-filter-sheet"

beforeEach(() => {
  useSkillsStore.setState({
    filterSheetOpen: true,
    filters: {
      query: "",
      category: "all",
      source: "all",
      status: "all",
      tag: null,
      sort: "name",
    },
  } as never)
})

describe("SkillFilterSheet", () => {
  it("renders the localized title and sort options when open", () => {
    render(<SkillFilterSheet allTags={[]} />)
    // The category label appears twice — once in the SheetTitle, once as the
    // category-select label — so we just verify both exist via the multi-match
    // form. The single-occurrence labels still use getByText.
    expect(screen.getAllByText("filter.byCategory").length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText("filter.bySource")).toBeInTheDocument()
    expect(screen.getByText("filter.byStatus")).toBeInTheDocument()
    expect(screen.getByText("filter.byTag")).toBeInTheDocument()
    expect(screen.getByText("filter.sortBy")).toBeInTheDocument()
  })

  it("clears filters via the footer reset button", () => {
    useSkillsStore.setState({
      filters: {
        query: "x",
        category: "development",
        source: "custom",
        status: "enabled",
        tag: "alpha",
        sort: "usage",
      },
    } as never)
    render(<SkillFilterSheet allTags={["alpha"]} />)
    fireEvent.click(screen.getByText("filter.clear"))
    const { filters } = useSkillsStore.getState()
    expect(filters.category).toBe("all")
    expect(filters.source).toBe("all")
    expect(filters.status).toBe("all")
    expect(filters.tag).toBeNull()
    expect(filters.sort).toBe("name")
  })

  it("renders each available tag as a clickable badge", () => {
    render(<SkillFilterSheet allTags={["alpha", "beta"]} />)
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
  })
})
