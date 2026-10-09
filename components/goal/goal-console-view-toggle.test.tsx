import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { GoalConsoleViewToggle } from "./goal-console-view-toggle"

// next-intl globally mocked against en.json in jest.setup.ts.

// The app mounts one TooltipProvider in app/layout.tsx.
function wrapper({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>
}

describe("GoalConsoleViewToggle", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { goalConsoleView: "grid" } as never })
  })

  it("renders list first, then grid, as a labelled group", () => {
    render(<GoalConsoleViewToggle />, { wrapper })
    const group = screen.getByRole("radiogroup", { name: "Open-goals view mode" })
    const items = group.querySelectorAll("[data-testid^='goal-console-view-']")
    expect(Array.from(items, (item) => item.getAttribute("data-testid"))).toEqual([
      "goal-console-view-list",
      "goal-console-view-grid",
    ])
  })

  it("is icon-only: each option is named by its aria-label, with no visible text", () => {
    render(<GoalConsoleViewToggle />, { wrapper })
    const list = screen.getByRole("radio", { name: "List" })
    const grid = screen.getByRole("radio", { name: "Grid" })
    expect(list).toHaveAttribute("aria-label", "List")
    expect(grid).toHaveAttribute("aria-label", "Grid")
    expect(list).toHaveTextContent(/^$/)
    expect(grid).toHaveTextContent(/^$/)
    expect(list.querySelector("svg")).not.toBeNull()
  })

  it("marks the stored view as selected", () => {
    render(<GoalConsoleViewToggle />, { wrapper })
    expect(screen.getByRole("radio", { name: "Grid" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "false")
  })

  it("defaults to the list view when no view is stored", () => {
    useSettingsStore.setState({ settings: {} as never })
    render(<GoalConsoleViewToggle />, { wrapper })
    expect(screen.getByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true")
  })

  it("persists the chosen view via save()", async () => {
    const user = userEvent.setup()
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: { goalConsoleView: "grid" } as never, save })
    render(<GoalConsoleViewToggle />, { wrapper })
    await user.click(screen.getByRole("radio", { name: "List" }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ goalConsoleView: "list" }))
  })

  it("shows the label as a tooltip on hover", async () => {
    const user = userEvent.setup()
    render(<GoalConsoleViewToggle />, { wrapper })
    await user.hover(screen.getByRole("radio", { name: "Grid" }))
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Grid")
  })
})
