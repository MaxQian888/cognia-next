/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

// Render the dropdown inline (Radix menus rely on portals + pointer events
// that are flaky under jsdom), so the export items are directly clickable.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}))

import { PerfToolbar } from "./perf-toolbar"

function setup(overrides: Partial<React.ComponentProps<typeof PerfToolbar>> = {}) {
  const props = {
    paused: false,
    intervalMs: 1000,
    onTogglePause: jest.fn(),
    onIntervalChange: jest.fn(),
    onReset: jest.fn(),
    onExport: jest.fn(),
    ...overrides,
  }
  render(<PerfToolbar {...props} />)
  return props
}

describe("PerfToolbar", () => {
  it("shows Pause when running and calls onTogglePause", () => {
    const props = setup({ paused: false })
    const btn = screen.getByTestId("perf-toggle-pause")
    expect(btn).toHaveTextContent("Pause")
    expect(btn).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(btn)
    expect(props.onTogglePause).toHaveBeenCalledTimes(1)
  })

  it("shows Resume when paused", () => {
    setup({ paused: true })
    expect(screen.getByTestId("perf-toggle-pause")).toHaveTextContent("Resume")
    expect(screen.getByTestId("perf-toggle-pause")).toHaveAttribute("aria-pressed", "true")
  })

  it("calls onReset", () => {
    const props = setup()
    fireEvent.click(screen.getByTestId("perf-reset"))
    expect(props.onReset).toHaveBeenCalledTimes(1)
  })

  it("renders the interval trigger", () => {
    setup({ intervalMs: 2000 })
    expect(screen.getByTestId("perf-interval-trigger")).toBeInTheDocument()
  })

  it("invokes onExport with each format from the export menu", () => {
    const props = setup()
    fireEvent.click(screen.getByTestId("perf-export-json"))
    expect(props.onExport).toHaveBeenCalledWith("json")
    fireEvent.click(screen.getByTestId("perf-export-processes"))
    expect(props.onExport).toHaveBeenCalledWith("csv-processes")
    fireEvent.click(screen.getByTestId("perf-export-hotspots"))
    expect(props.onExport).toHaveBeenCalledWith("csv-hotspots")
  })
})
