/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CategoryChipStrip } from "./category-chip-strip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("<CategoryChipStrip />", () => {
  it("renders one chip per implemented category", () => {
    render(<CategoryChipStrip activeCategory="characters" onSelect={jest.fn()} />)
    // Phase 1-5 registry — 10 chips.
    expect(screen.getByTestId("chip-strip-characters")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-teams")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-skills")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-plugins")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-mcpTools")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-connectors")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-ocrProviders")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-workflowTemplates")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-twinIngest")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-twinDrafts")).toBeInTheDocument()
  })

  it("marks the active chip with aria-current=page", () => {
    render(<CategoryChipStrip activeCategory="plugins" onSelect={jest.fn()} />)
    expect(screen.getByTestId("chip-strip-plugins")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("chip-strip-plugins")).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("chip-strip-skills")).not.toHaveAttribute("aria-current", "page")
  })

  it("emits onSelect with the clicked category id", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(<CategoryChipStrip activeCategory="characters" onSelect={onSelect} />)
    await user.click(screen.getByTestId("chip-strip-mcpTools"))
    expect(onSelect).toHaveBeenCalledWith("mcpTools")
  })

  it("renders a group divider at every super-group boundary", () => {
    render(<CategoryChipStrip activeCategory="characters" onSelect={jest.fn()} />)
    // Boundaries (current order): agents → extensions, extensions → templates,
    // templates → twin.
    expect(screen.getByTestId("chip-strip-divider-extensions")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-divider-templates")).toBeInTheDocument()
    expect(screen.getByTestId("chip-strip-divider-twin")).toBeInTheDocument()
    // No divider before the first chip.
    expect(screen.queryByTestId("chip-strip-divider-agents")).not.toBeInTheDocument()
  })

  it("scrolls the active chip into view on activeCategory change", async () => {
    const scrollIntoView = jest.fn()
    // jsdom doesn't implement scrollIntoView — patch on the prototype so all
    // mounted buttons share the spy.
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView

    const { rerender } = render(
      <CategoryChipStrip activeCategory="characters" onSelect={jest.fn()} />
    )
    // Initial mount triggers one scrollIntoView for the active chip.
    expect(scrollIntoView).toHaveBeenCalled()
    scrollIntoView.mockClear()
    rerender(<CategoryChipStrip activeCategory="plugins" onSelect={jest.fn()} />)
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it("exposes the chipStripAria label on the tablist", () => {
    render(<CategoryChipStrip activeCategory="characters" onSelect={jest.fn()} />)
    expect(screen.getByTestId("discover-chip-strip")).toHaveAttribute("aria-label", "chipStripAria")
  })

  it("renders a foryou chip, marks it active, and selects it on click", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    const { rerender } = render(<CategoryChipStrip activeCategory="foryou" onSelect={onSelect} />)
    const chip = screen.getByTestId("chip-strip-foryou")
    expect(chip).toHaveAttribute("aria-selected", "true")
    await user.click(chip)
    expect(onSelect).toHaveBeenCalledWith("foryou")

    // Inactive when another category is active.
    rerender(<CategoryChipStrip activeCategory="characters" onSelect={onSelect} />)
    expect(screen.getByTestId("chip-strip-foryou")).toHaveAttribute("aria-selected", "false")
  })
})
