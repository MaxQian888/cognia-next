/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillCategorySheet } from "./skill-category-sheet"

beforeEach(() => {
  useSkillsStore.setState({
    filters: {
      query: "",
      category: "all",
      source: "all",
      status: "all",
      tag: null,
      sort: "name",
    },
    categorySheetOpen: false,
  } as never)
})

describe("SkillCategorySheet", () => {
  it("stays hidden when categorySheetOpen is false", () => {
    render(<SkillCategorySheet total={0} countsByCategory={{}} countsBySource={{}} />)
    expect(screen.queryByText("panel.categoriesSheetTitle")).not.toBeInTheDocument()
  })

  it("renders the title + description when categorySheetOpen is true", () => {
    useSkillsStore.setState({ categorySheetOpen: true } as never)
    render(<SkillCategorySheet total={1} countsByCategory={{}} countsBySource={{}} />)
    expect(screen.getByText("panel.categoriesSheetTitle")).toBeInTheDocument()
    expect(screen.getByText("panel.categoriesSheetDescription")).toBeInTheDocument()
  })

  it("auto-closes the sheet after a category selection", () => {
    useSkillsStore.setState({ categorySheetOpen: true } as never)
    render(<SkillCategorySheet total={1} countsByCategory={{}} countsBySource={{}} />)
    fireEvent.click(screen.getByText("filter.all"))
    expect(useSkillsStore.getState().categorySheetOpen).toBe(false)
  })
})
