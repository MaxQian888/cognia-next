/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

import { FilterChips } from "./filter-chips"

describe("FilterChips", () => {
  const filters = [
    { key: "all", label: "All", count: 10 },
    { key: "active", label: "Active", count: 4 },
    { key: "paused", label: "Paused" },
  ]

  it("renders every chip with its label", () => {
    render(<FilterChips filters={filters} activeFilter="all" onFilterChange={jest.fn()} />)
    expect(screen.getByText("All")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
  })

  it("renders counts only for chips that supply one", () => {
    render(<FilterChips filters={filters} activeFilter="all" onFilterChange={jest.fn()} />)
    expect(screen.getByText("10")).toBeInTheDocument()
    expect(screen.getByText("4")).toBeInTheDocument()
    expect(screen.queryByText("0")).toBeNull()
  })

  it("marks the active chip with data-active=true and active classes", () => {
    render(<FilterChips filters={filters} activeFilter="active" onFilterChange={jest.fn()} />)
    const activeBtn = screen.getByText("Active").closest("button")!
    expect(activeBtn.getAttribute("data-active")).toBe("true")
    expect(activeBtn.className).toMatch(/bg-primary\/10/)

    const inactiveBtn = screen.getByText("All").closest("button")!
    expect(inactiveBtn.getAttribute("data-active")).toBe("false")
  })

  it("invokes onFilterChange with the chip key on click", () => {
    const onFilterChange = jest.fn()
    render(<FilterChips filters={filters} activeFilter="all" onFilterChange={onFilterChange} />)
    fireEvent.click(screen.getByText("Paused"))
    expect(onFilterChange).toHaveBeenCalledWith("paused")
  })

  it("renders nothing visible when the filter list is empty", () => {
    const { container } = render(
      <FilterChips filters={[]} activeFilter="all" onFilterChange={jest.fn()} />
    )
    expect(container.querySelectorAll("button")).toHaveLength(0)
  })
})
