import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { GoalConsoleViewToggle } from "./goal-console-view-toggle"

// next-intl globally mocked against en.json in jest.setup.ts.

describe("GoalConsoleViewToggle", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: { goalConsoleView: "grid" } as never })
  })

  it("renders both view options", () => {
    render(<GoalConsoleViewToggle />)
    expect(screen.getByTestId("goal-console-view-grid")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-view-list")).toBeInTheDocument()
  })

  it("persists the chosen view via save()", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ settings: { goalConsoleView: "grid" } as never, save })
    render(<GoalConsoleViewToggle />)
    fireEvent.click(screen.getByTestId("goal-console-view-list"))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ goalConsoleView: "list" }))
  })
})
