/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import { KindFilterChips } from "./kind-filter-chips"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

const COUNTS: Record<ScheduledItemKind, number> = {
  app: 3,
  workflow: 2,
  backup: 1,
  plugin: 0,
  system: 4,
  connector: 0,
}

describe("KindFilterChips", () => {
  it("carries no All chip, because the status row directly above already has one", () => {
    // The two rows rendered the same word above the same total ("All 4" twice
    // on a phone), neither saying which axis it filtered.
    render(
      <KindFilterChips
        selected={new Set()}
        onToggle={() => {}}
        onClear={() => {}}
        countsByKind={COUNTS}
      />
    )
    expect(screen.queryByRole("button", { name: /^All/ })).toBeNull()
    expect(screen.queryByTestId("kind-filter-clear")).toBeNull()
    expect(screen.getByTestId("kind-filter-app")).toBeInTheDocument()
  })

  it("offers Clear only once there is a selection to clear", () => {
    const onClear = jest.fn()
    render(
      <KindFilterChips
        selected={new Set(["app"])}
        onToggle={() => {}}
        onClear={onClear}
        countsByKind={COUNTS}
      />
    )
    expect(screen.getByTestId("kind-filter-app")).toHaveAttribute("data-active", "true")
    fireEvent.click(screen.getByTestId("kind-filter-clear"))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("clicking a kind chip fires onToggle with the kind", () => {
    const onToggle = jest.fn()
    render(
      <KindFilterChips
        selected={new Set()}
        onToggle={onToggle}
        onClear={() => {}}
        countsByKind={COUNTS}
      />
    )
    fireEvent.click(screen.getByTestId("kind-filter-workflow"))
    expect(onToggle).toHaveBeenCalledWith("workflow")
  })

  it("renders the count badge per chip", () => {
    render(
      <KindFilterChips
        selected={new Set()}
        onToggle={() => {}}
        onClear={() => {}}
        countsByKind={COUNTS}
      />
    )
    expect(screen.getByTestId("kind-filter-app").textContent).toMatch(/3/)
    // Plugin shows 0
    const plugin = screen.getByTestId("kind-filter-plugin")
    expect(plugin.textContent).toMatch(/0/)
  })
})
