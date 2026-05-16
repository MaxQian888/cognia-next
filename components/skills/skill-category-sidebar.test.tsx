/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillCategoryButtonList } from "./skill-category-sidebar"

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
  } as never)
})

describe("SkillCategoryButtonList", () => {
  it("renders an All bucket with the total count", () => {
    render(<SkillCategoryButtonList total={7} countsByCategory={{}} countsBySource={{}} />)
    expect(screen.getByText("filter.all")).toBeInTheDocument()
    expect(screen.getByText("7")).toBeInTheDocument()
  })

  it("writes a category selection through to the store filters", () => {
    render(
      <SkillCategoryButtonList
        total={0}
        countsByCategory={{ development: 3 }}
        countsBySource={{}}
      />
    )
    fireEvent.click(screen.getByText("category.development"))
    expect(useSkillsStore.getState().filters.category).toBe("development")
    expect(useSkillsStore.getState().filters.source).toBe("all")
  })

  it("writes a source selection through to the store filters", () => {
    render(
      <SkillCategoryButtonList total={0} countsByCategory={{}} countsBySource={{ custom: 2 }} />
    )
    fireEvent.click(screen.getByText("source.custom"))
    expect(useSkillsStore.getState().filters.source).toBe("custom")
    expect(useSkillsStore.getState().filters.category).toBe("all")
  })

  it("fires onSelect after every click", () => {
    const onSelect = jest.fn()
    render(
      <SkillCategoryButtonList
        total={0}
        countsByCategory={{}}
        countsBySource={{}}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByText("filter.all"))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
