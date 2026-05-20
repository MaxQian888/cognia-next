/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DiscoverCategorySidebar } from "./discover-category-sidebar"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("<DiscoverCategorySidebar />", () => {
  it("renders one accordion entry per populated super-group", () => {
    render(<DiscoverCategorySidebar activeCategory="characters" onSelect={jest.fn()} />)
    // Phase 3 promoted workflowTemplates → the templates group is now
    // populated, so all 4 super-groups render.
    expect(screen.getByTestId("discover-group-agents")).toBeInTheDocument()
    expect(screen.getByTestId("discover-group-extensions")).toBeInTheDocument()
    expect(screen.getByTestId("discover-group-twin")).toBeInTheDocument()
    expect(screen.getByTestId("discover-group-templates")).toBeInTheDocument()
  })

  it("renders every implemented category as a clickable button", () => {
    render(<DiscoverCategorySidebar activeCategory="characters" onSelect={jest.fn()} />)
    expect(screen.getByTestId("discover-category-characters")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-teams")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-skills")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-plugins")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-mcpTools")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-connectors")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-ocrProviders")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-workflowTemplates")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-twinIngest")).toBeInTheDocument()
    expect(screen.getByTestId("discover-category-twinDrafts")).toBeInTheDocument()
  })

  it("marks the active category with aria-current=page", () => {
    render(<DiscoverCategorySidebar activeCategory="plugins" onSelect={jest.fn()} />)
    expect(screen.getByTestId("discover-category-plugins")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("discover-category-characters")).not.toHaveAttribute(
      "aria-current",
      "page"
    )
  })

  it("calls onSelect with the chosen category id", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(<DiscoverCategorySidebar activeCategory="characters" onSelect={onSelect} />)
    await user.click(screen.getByTestId("discover-category-skills"))
    expect(onSelect).toHaveBeenCalledWith("skills")
  })

  it("exposes the aria label from the discover.groups.aria key", () => {
    render(<DiscoverCategorySidebar activeCategory="characters" onSelect={jest.fn()} />)
    const nav = screen.getByTestId("discover-category-sidebar")
    expect(nav).toHaveAttribute("aria-label", "groups.aria")
  })
})
