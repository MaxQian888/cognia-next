/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PROVIDER_CATEGORY_FILTERS } from "./provider-status-utils"
import {
  ProviderFilterPopover,
  STATUS_FILTERS,
  type ProviderFilterPopoverProps,
} from "./provider-filter-popover"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(",")}` : key,
}))

function renderPopover(over: Partial<ProviderFilterPopoverProps> = {}) {
  const props: ProviderFilterPopoverProps = {
    categoryFilter: "all",
    onCategoryChange: jest.fn(),
    statusFilter: "all",
    onStatusFilterChange: jest.fn(),
    onClearAll: jest.fn(),
    ...over,
  }
  return { ...render(<ProviderFilterPopover {...props} />), props }
}

describe("ProviderFilterPopover", () => {
  it("shows no count and no chips when nothing is filtered", () => {
    renderPopover()
    expect(screen.queryByTestId("provider-filter-count")).not.toBeInTheDocument()
    expect(screen.queryByTestId("provider-filter-chip-category")).not.toBeInTheDocument()
    expect(screen.queryByTestId("provider-filter-chip-status")).not.toBeInTheDocument()
    expect(screen.queryByTestId("provider-filter-clear")).not.toBeInTheDocument()
  })

  // Both axes are collapsed behind one trigger, which is the whole point: as
  // chip bands they cost up to seven rows above the list they filtered.
  it("keeps both axes off screen until opened", () => {
    renderPopover()
    expect(screen.queryByTestId("provider-filter-category-flagship")).not.toBeInTheDocument()
    expect(screen.queryByTestId("provider-filter-status-connected")).not.toBeInTheDocument()
  })

  it("offers every catalog category and every status once opened", async () => {
    const user = userEvent.setup()
    renderPopover()
    await user.click(screen.getByTestId("provider-filter-trigger"))
    for (const key of PROVIDER_CATEGORY_FILTERS) {
      expect(screen.getByTestId(`provider-filter-category-${key}`)).toBeInTheDocument()
    }
    for (const { value } of STATUS_FILTERS) {
      expect(screen.getByTestId(`provider-filter-status-${value}`)).toBeInTheDocument()
    }
  })

  it("marks the chosen option in each group", async () => {
    const user = userEvent.setup()
    renderPopover({ categoryFilter: "local", statusFilter: "error" })
    await user.click(screen.getByTestId("provider-filter-trigger"))
    expect(screen.getByTestId("provider-filter-category-local")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByTestId("provider-filter-category-flagship")).toHaveAttribute(
      "aria-checked",
      "false"
    )
    expect(screen.getByTestId("provider-filter-status-error")).toHaveAttribute(
      "aria-checked",
      "true"
    )
  })

  it("reports each axis to its own handler", async () => {
    const onCategoryChange = jest.fn()
    const onStatusFilterChange = jest.fn()
    const user = userEvent.setup()
    renderPopover({ onCategoryChange, onStatusFilterChange })
    await user.click(screen.getByTestId("provider-filter-trigger"))
    await user.click(screen.getByTestId("provider-filter-category-aggregator"))
    expect(onCategoryChange).toHaveBeenCalledWith("aggregator")
    expect(onStatusFilterChange).not.toHaveBeenCalled()
  })

  describe("active state", () => {
    it("counts one per active axis", () => {
      expect(
        renderPopover({ categoryFilter: "local" }).container.querySelector(
          '[data-testid="provider-filter-count"]'
        )
      ).toHaveTextContent("1")
    })

    it("counts both axes together", () => {
      renderPopover({ categoryFilter: "local", statusFilter: "error" })
      expect(screen.getByTestId("provider-filter-count")).toHaveTextContent("2")
    })

    // The chip is the state made visible with the popover closed, and it is
    // also the undo: making the user reopen the popover to find "All" is a
    // round trip for something they can see.
    it("shows a chip per active axis that clears that axis", async () => {
      const onCategoryChange = jest.fn()
      const onStatusFilterChange = jest.fn()
      const user = userEvent.setup()
      renderPopover({
        categoryFilter: "local",
        statusFilter: "error",
        onCategoryChange,
        onStatusFilterChange,
      })
      await user.click(screen.getByTestId("provider-filter-chip-category"))
      expect(onCategoryChange).toHaveBeenCalledWith("all")
      await user.click(screen.getByTestId("provider-filter-chip-status"))
      expect(onStatusFilterChange).toHaveBeenCalledWith("all")
    })

    it("names the filter it removes on the chip's label", () => {
      renderPopover({ categoryFilter: "local" })
      expect(screen.getByTestId("provider-filter-chip-category")).toHaveAttribute(
        "aria-label",
        "sidebar.removeFilter:categories.local"
      )
    })

    // Search lives on the rail, not here, but "clear filters" resets it too,
    // so the button has to appear for a search-only narrowing as well.
    it("offers clear-all for a search with no filter set", () => {
      renderPopover({ searchActive: true })
      expect(screen.queryByTestId("provider-filter-count")).not.toBeInTheDocument()
      expect(screen.getByTestId("provider-filter-clear")).toBeInTheDocument()
    })

    it("clears every axis at once", async () => {
      const onClearAll = jest.fn()
      const user = userEvent.setup()
      renderPopover({ categoryFilter: "local", statusFilter: "error", onClearAll })
      await user.click(screen.getByTestId("provider-filter-clear"))
      expect(onClearAll).toHaveBeenCalledTimes(1)
    })
  })
})
