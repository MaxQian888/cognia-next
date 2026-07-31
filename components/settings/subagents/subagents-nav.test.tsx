/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SubagentsNav, type SubagentsNavProps } from "./subagents-nav"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

const baseProps = (over: Partial<SubagentsNavProps> = {}): SubagentsNavProps => ({
  activeId: "nesting",
  onSelect: jest.fn(),
  entityGroups: [
    {
      id: "userGroup",
      items: [
        { panelId: "template:a", label: "Alpha", glyph: "A", description: "first" },
        { panelId: "template:b", label: "Beta", glyph: "B", disabled: true },
        { panelId: "template:c", label: "Gamma", glyph: "G", hidden: true },
      ],
    },
    { id: "pluginGroup", items: [] },
  ],
  runningCount: 0,
  search: "",
  onSearchChange: jest.fn(),
  categories: ["coding", "writing"],
  activeCategory: null,
  onCategoryChange: jest.fn(),
  ...over,
})

describe("SubagentsNav", () => {
  it("renders every static panel plus the entity rows", () => {
    render(<SubagentsNav {...baseProps()} />)
    expect(screen.getByTestId("subagent-nav-item-runtime")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-nav-item-nesting")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-nav-item-background")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-nav-item-template:a")).toBeInTheDocument()
  })

  it("omits a group with no items rather than leaving an empty header", () => {
    render(<SubagentsNav {...baseProps()} />)
    expect(screen.queryByTestId("subagent-nav-group-pluginGroup")).not.toBeInTheDocument()
  })

  it("marks the active row for assistive tech", () => {
    render(<SubagentsNav {...baseProps({ activeId: "template:a" })} />)
    expect(screen.getByTestId("subagent-nav-item-template:a")).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByTestId("subagent-nav-item-nesting")).not.toHaveAttribute("aria-current")
  })

  it("selects on click", async () => {
    const onSelect = jest.fn()
    render(<SubagentsNav {...baseProps({ onSelect })} />)
    await userEvent.click(screen.getByTestId("subagent-nav-item-template:a"))
    expect(onSelect).toHaveBeenCalledWith("template:a")
  })

  it("badges the runtime row only while something is live", () => {
    const { rerender } = render(<SubagentsNav {...baseProps()} />)
    expect(screen.queryByTestId("subagent-nav-badge-runtime")).not.toBeInTheDocument()
    rerender(<SubagentsNav {...baseProps({ runningCount: 3 })} />)
    expect(screen.getByTestId("subagent-nav-badge-runtime")).toHaveTextContent("3")
  })

  it("dots the rows that hold unsaved edits", () => {
    render(<SubagentsNav {...baseProps({ dirtyPanels: ["template:a"] })} />)
    expect(screen.getByTestId("subagent-nav-dirty-template:a")).toBeInTheDocument()
    expect(screen.queryByTestId("subagent-nav-dirty-template:b")).not.toBeInTheDocument()
  })

  it("marks a disabled entry so it is distinguishable at a glance", () => {
    render(<SubagentsNav {...baseProps()} />)
    expect(screen.getByTestId("subagent-nav-item-template:b")).toHaveAttribute(
      "data-disabled-entry",
      "true"
    )
    expect(screen.getByTestId("subagent-nav-item-template:a")).not.toHaveAttribute(
      "data-disabled-entry"
    )
  })

  it("carries a flight anchor on every row's avatar", () => {
    const { container } = render(<SubagentsNav {...baseProps()} />)
    expect(container.querySelector('[data-flight-source="template:a"]')).toBeInTheDocument()
    expect(container.querySelector('[data-flight-source="nesting"]')).toBeInTheDocument()
  })

  it("exposes the category filter as toggle buttons, not click-only badges", async () => {
    const onCategoryChange = jest.fn()
    render(<SubagentsNav {...baseProps({ onCategoryChange })} />)
    const chip = screen.getByTestId("category-filter-coding")
    expect(chip.tagName).toBe("BUTTON")
    expect(chip).toHaveAttribute("aria-pressed", "false")
    await userEvent.click(chip)
    expect(onCategoryChange).toHaveBeenCalledWith("coding")
  })

  it("clicking the active category clears it", async () => {
    const onCategoryChange = jest.fn()
    render(<SubagentsNav {...baseProps({ activeCategory: "coding", onCategoryChange })} />)
    await userEvent.click(screen.getByTestId("category-filter-coding"))
    expect(onCategoryChange).toHaveBeenCalledWith(null)
  })

  it("shows the search clear affordance only when there is a query", async () => {
    const onSearchChange = jest.fn()
    const { rerender } = render(<SubagentsNav {...baseProps({ onSearchChange })} />)
    expect(screen.queryByTestId("subagent-nav-search-clear")).not.toBeInTheDocument()

    rerender(<SubagentsNav {...baseProps({ search: "abc", onSearchChange })} />)
    await userEvent.click(screen.getByTestId("subagent-nav-search-clear"))
    expect(onSearchChange).toHaveBeenCalledWith("")
  })

  it("reports a filtered-empty result distinctly from having nothing at all", () => {
    render(<SubagentsNav {...baseProps({ filteredEmpty: true })} />)
    expect(screen.getByTestId("subagent-nav-empty")).toBeInTheDocument()
  })
})
