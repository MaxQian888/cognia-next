/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

// Minimal stub for the toolbar — not under test here.
jest.mock("./skill-panel-toolbar", () => ({
  SkillPanelToolbar: () => <div data-testid="toolbar-stub" />,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillPanelHeader } from "./skill-panel-header"

beforeEach(() => {
  useSkillsStore.setState({
    activeTab: "my-skills",
    filters: {
      query: "",
      category: "all",
      source: "all",
      status: "all",
      tag: null,
      sort: "name",
    },
    filterSheetOpen: false,
    categorySheetOpen: false,
  } as never)
})

describe("SkillPanelHeader", () => {
  it("renders the localized title and subtitle", () => {
    render(<SkillPanelHeader totalCount={5} filteredCount={5} />)
    expect(screen.getByText("panel.headerTitle")).toBeInTheDocument()
    expect(screen.getByText('panel.headerSubtitle:{"count":5}')).toBeInTheDocument()
  })

  it("shows ratio instead of count when filtered count differs", () => {
    render(<SkillPanelHeader totalCount={10} filteredCount={3} />)
    expect(screen.getByText("3/10")).toBeInTheDocument()
  })

  it("exposes a category navigator trigger with a localized aria-label on My Skills tab", () => {
    render(<SkillPanelHeader totalCount={1} filteredCount={1} />)
    const trigger = screen.getByLabelText("panel.openCategoriesAria")
    expect(trigger).toBeInTheDocument()
  })

  it("hides the category trigger when not on the My Skills tab", () => {
    useSkillsStore.setState({ activeTab: "browse" } as never)
    render(<SkillPanelHeader totalCount={1} filteredCount={1} />)
    expect(screen.queryByLabelText("panel.openCategoriesAria")).not.toBeInTheDocument()
  })

  it("opens the category sheet via the store when the trigger is clicked", () => {
    render(<SkillPanelHeader totalCount={1} filteredCount={1} />)
    fireEvent.click(screen.getByLabelText("panel.openCategoriesAria"))
    expect(useSkillsStore.getState().categorySheetOpen).toBe(true)
  })

  it("opens the filter sheet via the store when the filters button is clicked", () => {
    render(<SkillPanelHeader totalCount={1} filteredCount={1} />)
    fireEvent.click(screen.getByLabelText("filters"))
    expect(useSkillsStore.getState().filterSheetOpen).toBe(true)
  })

  it("writes the search query through to the store", () => {
    render(<SkillPanelHeader totalCount={1} filteredCount={1} />)
    fireEvent.change(screen.getByPlaceholderText("filter.search"), { target: { value: "foo" } })
    expect(useSkillsStore.getState().filters.query).toBe("foo")
  })
})
