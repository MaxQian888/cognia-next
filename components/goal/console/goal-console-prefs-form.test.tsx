import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useSettingsStore } from "@/stores/settings/settings-store"

import { GoalConsolePrefsForm } from "./goal-console-prefs-form"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

const saveMock = jest.fn()

function setStored(prefs: Record<string, unknown> | undefined) {
  useSettingsStore.setState({
    settings: (prefs ? { goalConsolePrefs: prefs } : null) as never,
    save: saveMock,
  })
}

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue(undefined)
  setStored(undefined)
})

describe("GoalConsolePrefsForm", () => {
  it("renders the default-tab and open-goals sort fields with their hints", () => {
    render(<GoalConsolePrefsForm />)
    expect(screen.getByTestId("goal-console-prefs")).toBeInTheDocument()
    expect(screen.getByText("Default tab")).toBeInTheDocument()
    expect(
      screen.getByText("Shown when you open Goals without a link to a specific tab.")
    ).toBeInTheDocument()
    expect(screen.getByText("Open-goals sort")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-prefs-dir")).toHaveAccessibleName("Sort direction")
  })

  it("shows the hard defaults when nothing is stored", () => {
    render(<GoalConsolePrefsForm />)
    expect(screen.getByTestId("goal-console-prefs-default-tab")).toHaveTextContent("Overview")
    expect(screen.getByTestId("goal-console-prefs-sort")).toHaveTextContent("Created")
    expect(screen.getByTestId("goal-console-prefs-dir")).toHaveTextContent("Descending")
  })

  it("reflects stored prefs, resolving a retired tab to Configure", () => {
    setStored({ defaultTab: "templates", openGoalsSort: "tokens", openGoalsDir: "asc" })
    render(<GoalConsolePrefsForm />)
    expect(screen.getByTestId("goal-console-prefs-default-tab")).toHaveTextContent("Configure")
    expect(screen.getByTestId("goal-console-prefs-sort")).toHaveTextContent("Tokens")
    expect(screen.getByTestId("goal-console-prefs-dir")).toHaveTextContent("Ascending")
  })

  it("offers the four console tabs and persists the choice as it is made", async () => {
    const user = userEvent.setup()
    render(<GoalConsolePrefsForm />)
    await user.click(screen.getByTestId("goal-console-prefs-default-tab"))
    const options = await screen.findAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual([
      "Overview",
      "History",
      "Analytics",
      "Configure",
    ])
    await user.click(screen.getByRole("option", { name: "History" }))
    // Merged over the resolved prefs, so the other fields are kept.
    expect(saveMock).toHaveBeenCalledWith({
      goalConsolePrefs: { defaultTab: "history", openGoalsSort: "created", openGoalsDir: "desc" },
    })
  })

  it("persists the open-goals sort key", async () => {
    const user = userEvent.setup()
    render(<GoalConsolePrefsForm />)
    await user.click(screen.getByTestId("goal-console-prefs-sort"))
    await user.click(await screen.findByRole("option", { name: "Turns" }))
    expect(saveMock).toHaveBeenCalledWith({
      goalConsolePrefs: expect.objectContaining({ openGoalsSort: "turns" }),
    })
  })

  it("persists the sort direction without touching the other fields", async () => {
    const user = userEvent.setup()
    setStored({ defaultTab: "analytics", openGoalsSort: "tokens", openGoalsDir: "desc" })
    render(<GoalConsolePrefsForm />)
    await user.click(screen.getByTestId("goal-console-prefs-dir"))
    await user.click(await screen.findByRole("option", { name: "Ascending" }))
    expect(saveMock).toHaveBeenCalledWith({
      goalConsolePrefs: { defaultTab: "analytics", openGoalsSort: "tokens", openGoalsDir: "asc" },
    })
  })
})
