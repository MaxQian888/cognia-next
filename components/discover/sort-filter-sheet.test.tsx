/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let platform = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platform,
}))

import { SortFilterSheet } from "./sort-filter-sheet"

beforeEach(() => {
  platform = "web"
})

describe("<SortFilterSheet />", () => {
  it("renders a Sheet on mobile and a Popover on desktop", async () => {
    const user = userEvent.setup()
    platform = "mobile"
    const { rerender } = render(
      <SortFilterSheet
        sort="name"
        filter="all"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-sort-filter-trigger"))
    expect(screen.getByTestId("discover-sort-filter-sheet")).toBeInTheDocument()

    platform = "web"
    rerender(
      <SortFilterSheet
        sort="name"
        filter="all"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    // Desktop path still exposes the same content container + options.
    await user.click(screen.getByTestId("discover-sort-filter-trigger"))
    expect(screen.getByTestId("discover-sort-name")).toBeInTheDocument()
  })

  it("renders a trigger button with the sortFilter.trigger label", () => {
    render(
      <SortFilterSheet
        sort="name"
        filter="all"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-sort-filter-trigger")).toBeInTheDocument()
  })

  it("opens the sheet and shows every sort + filter option", async () => {
    const user = userEvent.setup()
    render(
      <SortFilterSheet
        sort="name"
        filter="all"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-sort-filter-trigger"))
    expect(screen.getByTestId("discover-sort-name")).toBeInTheDocument()
    expect(screen.getByTestId("discover-sort-recent")).toBeInTheDocument()
    expect(screen.getByTestId("discover-filter-all")).toBeInTheDocument()
    expect(screen.getByTestId("discover-filter-installed")).toBeInTheDocument()
    expect(screen.getByTestId("discover-filter-enabled")).toBeInTheDocument()
    expect(screen.getByTestId("discover-filter-builtin")).toBeInTheDocument()
  })

  it("marks the active sort + filter option with aria-checked", async () => {
    const user = userEvent.setup()
    render(
      <SortFilterSheet
        sort="recent"
        filter="installed"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-sort-filter-trigger"))
    expect(screen.getByTestId("discover-sort-recent")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("discover-sort-name")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByTestId("discover-filter-installed")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("discover-filter-all")).toHaveAttribute("aria-checked", "false")
  })

  it("fires onSortChange and onFilterChange when an option is clicked", async () => {
    const onSortChange = jest.fn()
    const onFilterChange = jest.fn()
    const user = userEvent.setup()
    render(
      <SortFilterSheet
        sort="name"
        filter="all"
        onSortChange={onSortChange}
        onFilterChange={onFilterChange}
      />
    )
    await user.click(screen.getByTestId("discover-sort-filter-trigger"))
    await user.click(screen.getByTestId("discover-sort-recent"))
    expect(onSortChange).toHaveBeenCalledWith("recent")
    await user.click(screen.getByTestId("discover-filter-enabled"))
    expect(onFilterChange).toHaveBeenCalledWith("enabled")
  })

  it("disables the Reset button when state already matches defaults", async () => {
    const user = userEvent.setup()
    render(
      <SortFilterSheet
        sort="name"
        filter="all"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-sort-filter-trigger"))
    expect(screen.getByTestId("discover-sort-filter-reset")).toBeDisabled()
  })

  it("reset button collapses both knobs to defaults", async () => {
    const onSortChange = jest.fn()
    const onFilterChange = jest.fn()
    const user = userEvent.setup()
    render(
      <SortFilterSheet
        sort="recent"
        filter="enabled"
        onSortChange={onSortChange}
        onFilterChange={onFilterChange}
      />
    )
    await user.click(screen.getByTestId("discover-sort-filter-trigger"))
    await user.click(screen.getByTestId("discover-sort-filter-reset"))
    expect(onSortChange).toHaveBeenCalledWith("name")
    expect(onFilterChange).toHaveBeenCalledWith("all")
  })
})
