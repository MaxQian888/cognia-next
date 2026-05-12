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
  it("marks 'all' active when the selection is empty", () => {
    render(
      <KindFilterChips
        selected={new Set()}
        onToggle={() => {}}
        onClear={() => {}}
        countsByKind={COUNTS}
      />
    )
    const all = screen.getByRole("button", { name: /All/ })
    expect(all).toHaveAttribute("data-active", "true")
  })

  it("marks 'all' inactive when at least one kind is selected", () => {
    render(
      <KindFilterChips
        selected={new Set(["app"])}
        onToggle={() => {}}
        onClear={() => {}}
        countsByKind={COUNTS}
      />
    )
    const all = screen.getByRole("button", { name: /All/ })
    expect(all).toHaveAttribute("data-active", "false")
    const app = screen.getByTestId("kind-filter-app")
    expect(app).toHaveAttribute("data-active", "true")
  })

  it("clicking 'all' fires onClear", () => {
    const onClear = jest.fn()
    render(
      <KindFilterChips
        selected={new Set(["app"])}
        onToggle={() => {}}
        onClear={onClear}
        countsByKind={COUNTS}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /All/ }))
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
    // total = 3 + 2 + 1 + 0 + 4 = 10
    const all = screen.getByRole("button", { name: /All\s*10/ })
    expect(all).toBeInTheDocument()
    // Plugin shows 0
    const plugin = screen.getByTestId("kind-filter-plugin")
    expect(plugin.textContent).toMatch(/0/)
  })
})
