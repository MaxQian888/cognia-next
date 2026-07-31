import { fireEvent, render, screen } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { GoalConsolePrefsPopover } from "./goal-console-prefs-popover"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

describe("GoalConsolePrefsPopover", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null, save: jest.fn().mockResolvedValue(undefined) })
  })

  it("renders the gear trigger", () => {
    render(<GoalConsolePrefsPopover />)
    expect(screen.getByTestId("goal-console-prefs-trigger")).toBeInTheDocument()
  })

  it("opens the preferences popover with the tab + sort selects", () => {
    render(<GoalConsolePrefsPopover />)
    fireEvent.click(screen.getByTestId("goal-console-prefs-trigger"))
    expect(screen.getByTestId("goal-console-prefs")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-prefs-default-tab")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-prefs-sort")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-prefs-dir")).toBeInTheDocument()
  })
})
