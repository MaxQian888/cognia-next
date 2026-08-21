/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SchedulerFilterBar, type SchedulerFilterBarProps } from "./scheduler-filter-bar"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

const COUNTS_BY_KIND: Record<ScheduledItemKind, number> = {
  app: 1,
  workflow: 0,
  backup: 1,
  plugin: 1,
  system: 0,
  connector: 1,
}

function renderBar(overrides: Partial<SchedulerFilterBarProps> = {}) {
  const props: SchedulerFilterBarProps = {
    status: "all",
    onStatusChange: jest.fn(),
    statusCounts: { all: 4, active: 1, paused: 2 },
    selectedKinds: new Set(),
    onToggleKind: jest.fn(),
    countsByKind: COUNTS_BY_KIND,
    loopOnly: false,
    onLoopOnlyChange: jest.fn(),
    loopCount: 0,
    onClearKindFilters: jest.fn(),
    ...overrides,
  }
  render(<SchedulerFilterBar {...props} />)
  return props
}

describe("SchedulerFilterBar", () => {
  it("renders one row with the three status buckets and their counts", () => {
    renderBar()
    for (const key of ["all", "active", "paused"] as const) {
      expect(screen.getByTestId(`scheduler-status-filter-${key}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId("scheduler-status-filter-all")).toHaveTextContent("4")
    expect(screen.getByTestId("scheduler-status-filter-active")).toHaveTextContent("1")
    expect(screen.getByTestId("scheduler-status-filter-paused")).toHaveTextContent("2")
  })

  it("marks the current status bucket as pressed", () => {
    renderBar({ status: "paused" })
    expect(screen.getByTestId("scheduler-status-filter-paused")).toHaveAttribute("data-state", "on")
    expect(screen.getByTestId("scheduler-status-filter-all")).toHaveAttribute("data-state", "off")
  })

  it("reports a status change when another bucket is pressed", () => {
    const props = renderBar()
    fireEvent.click(screen.getByTestId("scheduler-status-filter-active"))
    expect(props.onStatusChange).toHaveBeenCalledWith("active")
  })

  it("ignores the empty value Radix emits when the pressed bucket is toggled off", () => {
    const props = renderBar({ status: "active" })
    // Clicking the already-selected item deselects it in Radix's single mode.
    fireEvent.click(screen.getByTestId("scheduler-status-filter-active"))
    expect(props.onStatusChange).not.toHaveBeenCalled()
  })

  it("hides the kind menu behind one trigger, with no badge when nothing is pinned", () => {
    renderBar()
    expect(screen.getByTestId("scheduler-kind-filter-menu")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-kind-filter-count")).not.toBeInTheDocument()
  })

  it("badges the trigger with how many filters are pinned", () => {
    renderBar({ selectedKinds: new Set<ScheduledItemKind>(["app", "backup"]), loopOnly: true })
    expect(screen.getByTestId("scheduler-kind-filter-count")).toHaveTextContent("3")
    expect(screen.getByTestId("scheduler-kind-filter-menu")).toHaveAttribute("data-active", "true")
  })

  it("lists every kind with its count and toggles one on select", async () => {
    const user = userEvent.setup()
    const props = renderBar()
    await user.click(screen.getByTestId("scheduler-kind-filter-menu"))

    const backup = screen.getByTestId("scheduler-kind-filter-backup")
    expect(backup).toHaveTextContent("Backup")
    expect(backup).toHaveTextContent("1")
    // A source contributing nothing is still listed (dimmed), not hidden.
    expect(screen.getByTestId("scheduler-kind-filter-workflow")).toHaveTextContent("0")

    await user.click(backup)
    expect(props.onToggleKind).toHaveBeenCalledWith("backup")
  })

  it("omits the /loop row when no loop task exists", async () => {
    const user = userEvent.setup()
    renderBar({ loopCount: 0 })
    await user.click(screen.getByTestId("scheduler-kind-filter-menu"))
    expect(screen.queryByTestId("scheduler-loop-only-filter")).not.toBeInTheDocument()
  })

  it("offers the /loop row once loop tasks exist and reports the toggle", async () => {
    const user = userEvent.setup()
    const props = renderBar({ loopCount: 2 })
    await user.click(screen.getByTestId("scheduler-kind-filter-menu"))
    const loop = screen.getByTestId("scheduler-loop-only-filter")
    expect(loop).toHaveTextContent("2")
    await user.click(loop)
    expect(props.onLoopOnlyChange).toHaveBeenCalledWith(true)
  })

  it("disables the clear entry until something is pinned", async () => {
    const user = userEvent.setup()
    renderBar()
    await user.click(screen.getByTestId("scheduler-kind-filter-menu"))
    expect(screen.getByTestId("scheduler-clear-kind-filters")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("clears the menu axes when the clear entry is chosen", async () => {
    const user = userEvent.setup()
    const props = renderBar({ selectedKinds: new Set<ScheduledItemKind>(["plugin"]) })
    await user.click(screen.getByTestId("scheduler-kind-filter-menu"))
    await user.click(screen.getByTestId("scheduler-clear-kind-filters"))
    expect(props.onClearKindFilters).toHaveBeenCalled()
  })
})
