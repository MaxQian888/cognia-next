import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { GoalConfigSection as GoalConfigSectionId } from "@/lib/goal/console-prefs"

import { GoalConfigSection } from "./goal-config-section"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

// Each panel has its own suite; this one owns the frame: which panel shows
// for which section, the nav that switches them, and the panel headings.
jest.mock("@/components/settings/goals/goal-defaults-form", () => ({
  GoalDefaultsForm: () => <div data-testid="mock-defaults-form" />,
}))
jest.mock("@/components/settings/goals/goal-templates-manager", () => ({
  GoalTemplatesManager: () => <div data-testid="mock-templates-manager" />,
}))
jest.mock("@/components/settings/goals/goal-tracker-config", () => ({
  GoalTrackerConfig: () => <div data-testid="mock-tracker-config" />,
}))
jest.mock("./goal-console-prefs-form", () => ({
  GoalConsolePrefsForm: () => <div data-testid="mock-console-prefs" />,
}))

const PANELS: Record<GoalConfigSectionId, { testId: string; label: string; description: string }> =
  {
    defaults: {
      testId: "mock-defaults-form",
      label: "Defaults",
      description: "Budgets, judge and pacing every new goal starts with.",
    },
    templates: {
      testId: "mock-templates-manager",
      label: "Templates",
      description: "Reusable objectives to start goals from.",
    },
    tracker: {
      testId: "mock-tracker-config",
      label: "Goal Tracker",
      description: "The built-in agent that pairs with /goal.",
    },
    console: {
      testId: "mock-console-prefs",
      label: "Console",
      description: "Where the console opens and how open goals sort.",
    },
  }

describe("GoalConfigSection", () => {
  it.each(Object.keys(PANELS) as GoalConfigSectionId[])(
    "renders the %s panel with its heading and description",
    (section) => {
      render(<GoalConfigSection section={section} onSectionChange={jest.fn()} />)
      const panel = screen.getByTestId(`goal-config-panel-${section}`)
      expect(within(panel).getByRole("heading", { level: 2 })).toHaveTextContent(
        PANELS[section].label
      )
      expect(panel).toHaveTextContent(PANELS[section].description)
      expect(within(panel).getByTestId(PANELS[section].testId)).toBeInTheDocument()
      // Only one panel at a time.
      for (const other of Object.keys(PANELS) as GoalConfigSectionId[]) {
        if (other === section) continue
        expect(screen.queryByTestId(PANELS[other].testId)).not.toBeInTheDocument()
      }
    }
  )

  it("labels the panel region by its heading", () => {
    render(<GoalConfigSection section="templates" onSectionChange={jest.fn()} />)
    expect(screen.getByRole("region", { name: "Templates" })).toBe(
      screen.getByTestId("goal-config-panel-templates")
    )
  })

  it("lists every section in the nav, grouped, and marks the active one", () => {
    render(<GoalConfigSection section="tracker" onSectionChange={jest.fn()} />)
    expect(screen.getByTestId("goal-config-section")).toBeInTheDocument()
    expect(screen.getByTestId("goal-config-nav-group-goals")).toBeInTheDocument()
    expect(screen.getByTestId("goal-config-nav-group-console")).toBeInTheDocument()
    for (const id of Object.keys(PANELS)) {
      expect(screen.getByTestId(`goal-config-nav-item-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId("goal-config-nav-item-tracker")).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(screen.getByTestId("goal-config-nav-item-defaults")).not.toHaveAttribute("aria-current")
  })

  it("reports a section change from the nav", async () => {
    const user = userEvent.setup()
    const onSectionChange = jest.fn()
    render(<GoalConfigSection section="defaults" onSectionChange={onSectionChange} />)
    await user.click(screen.getByTestId("goal-config-nav-item-console"))
    expect(onSectionChange).toHaveBeenCalledWith("console")
  })

  it("follows the section prop", () => {
    const { rerender } = render(
      <GoalConfigSection section="defaults" onSectionChange={jest.fn()} />
    )
    expect(screen.getByTestId("mock-defaults-form")).toBeInTheDocument()
    rerender(<GoalConfigSection section="templates" onSectionChange={jest.fn()} />)
    expect(screen.getByTestId("goal-config-panel-templates")).toBeInTheDocument()
  })

  it("offers the narrow-pane drawer trigger", () => {
    render(<GoalConfigSection section="console" onSectionChange={jest.fn()} />)
    expect(screen.getByTestId("goal-config-nav-trigger")).toHaveTextContent("Sections")
  })
})
