/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { ActiveFilterChips } from "./active-filter-chips"

describe("<ActiveFilterChips />", () => {
  it("renders nothing when sort + filter are at defaults", () => {
    const { container } = render(
      <ActiveFilterChips
        sort="name"
        filter="all"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a sort chip only when sort is non-default", () => {
    render(
      <ActiveFilterChips
        sort="recent"
        filter="all"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-active-filter-sort")).toBeInTheDocument()
    expect(screen.queryByTestId("discover-active-filter-filter")).not.toBeInTheDocument()
  })

  it("renders a filter chip only when filter is non-default", () => {
    render(
      <ActiveFilterChips
        sort="name"
        filter="enabled"
        onSortChange={jest.fn()}
        onFilterChange={jest.fn()}
      />
    )
    expect(screen.getByTestId("discover-active-filter-filter")).toBeInTheDocument()
    expect(screen.queryByTestId("discover-active-filter-sort")).not.toBeInTheDocument()
  })

  it("resets sort to default when the sort chip is removed", async () => {
    const onSortChange = jest.fn()
    const user = userEvent.setup()
    render(
      <ActiveFilterChips
        sort="recent"
        filter="all"
        onSortChange={onSortChange}
        onFilterChange={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("discover-active-filter-sort-remove"))
    expect(onSortChange).toHaveBeenCalledWith("name")
  })

  it("resets filter to default when the filter chip is removed", async () => {
    const onFilterChange = jest.fn()
    const user = userEvent.setup()
    render(
      <ActiveFilterChips
        sort="name"
        filter="builtin"
        onSortChange={jest.fn()}
        onFilterChange={onFilterChange}
      />
    )
    await user.click(screen.getByTestId("discover-active-filter-filter-remove"))
    expect(onFilterChange).toHaveBeenCalledWith("all")
  })
})
