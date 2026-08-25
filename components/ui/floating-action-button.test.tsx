/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import { FloatingActionButton } from "./floating-action-button"

describe("FloatingActionButton", () => {
  it("renders with the default + icon and the supplied aria-label", () => {
    render(<FloatingActionButton aria-label="Add item" onClick={jest.fn()} />)
    const btn = screen.getByRole("button", { name: "Add item" })
    expect(btn).toBeInTheDocument()
    expect(btn.querySelector("svg")).toBeInTheDocument()
  })

  it("uses fixed positioning by default", () => {
    render(<FloatingActionButton aria-label="Create" />)
    expect(screen.getByRole("button", { name: "Create" })).toHaveClass("fixed")
  })

  it("uses absolute positioning when position='absolute'", () => {
    render(<FloatingActionButton aria-label="Create" position="absolute" />)
    const btn = screen.getByRole("button", { name: "Create" })
    expect(btn).toHaveClass("absolute")
    expect(btn).not.toHaveClass("fixed")
  })

  it("invokes onClick when activated", () => {
    const onClick = jest.fn()
    render(<FloatingActionButton aria-label="Add" onClick={onClick} />)
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("renders a custom icon when provided", () => {
    render(<FloatingActionButton aria-label="Mic" icon={<svg data-testid="mic-icon" />} />)
    expect(screen.getByTestId("mic-icon")).toBeInTheDocument()
  })

  it("applies additional className alongside the FAB defaults", () => {
    render(<FloatingActionButton aria-label="Add" className="ring-2" />)
    const btn = screen.getByRole("button", { name: "Add" })
    expect(btn).toHaveClass("ring-2")
    expect(btn).toHaveClass("rounded-pill")
  })

  it("sets data-slot='fab' for downstream querying", () => {
    render(<FloatingActionButton aria-label="Add" />)
    const btn = screen.getByRole("button", { name: "Add" })
    expect(btn.getAttribute("data-slot")).toBe("fab")
  })
})
