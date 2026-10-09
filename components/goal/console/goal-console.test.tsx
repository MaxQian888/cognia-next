import "fake-indexeddb/auto"
import { useState } from "react"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import { dexieAdapter } from "@/lib/data-hooks/dexie-adapter"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { GoalConsoleLocation } from "@/lib/goal/console-prefs"
import { GOAL_NOW, makeGoal } from "@/lib/storybook/fixtures/goal"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { Goal } from "@/types/goal"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json);
// next/navigation is globally mocked too (the quick-create dialog's router).

// The breakpoint picks pane vs sheet for the inspector (and the shell's own
// overlay tier); a test can move the console below the desktop tier.
jest.mock("@/hooks/ui", () => ({
  ...jest.requireActual("@/hooks/ui"),
  useBreakpoint: jest.fn(() => "desktop"),
}))
// The inspector and its sheet have their own suites; the stubs expose the
// callbacks the console wires so the selection contract is observable.
jest.mock("../goal-detail-panel", () => ({
  GoalDetailPanel: ({
    goalId,
    initialGoal,
    onClose,
    onDeleted,
  }: {
    goalId: string
    initialGoal?: Goal
    onClose?: () => void
    onDeleted?: () => void
  }) => (
    <div data-testid="mock-detail-panel" data-goal-id={goalId} data-initial={initialGoal?.id}>
      <button type="button" data-testid="mock-detail-close" onClick={onClose} />
      <button type="button" data-testid="mock-detail-deleted" onClick={onDeleted} />
    </div>
  ),
}))
jest.mock("../goal-detail-sheet", () => ({
  GoalDetailSheet: ({
    goal,
    onOpenChange,
  }: {
    goal: Goal
    onOpenChange: (open: boolean) => void
  }) => (
    <div data-testid="mock-detail-sheet" data-goal-id={goal.id}>
      <button type="button" data-testid="mock-sheet-close" onClick={() => onOpenChange(false)} />
    </div>
  ),
}))
// Configure's panels (forms over the settings store, the tracker agent) have
// their own suites; the console only routes `section`.
jest.mock("./goal-config-section", () => ({
  GoalConfigSection: ({
    section,
    onSectionChange,
  }: {
    section: string
    onSectionChange: (next: "templates") => void
  }) => (
    <div data-testid="mock-config-section" data-section={section}>
      <button
        type="button"
        data-testid="mock-config-to-templates"
        onClick={() => onSectionChange("templates")}
      />
    </div>
  ),
}))

import { useBreakpoint } from "@/hooks/ui"
import { GoalConsole, type GoalConsolePlace } from "./goal-console"

const breakpointMock = useBreakpoint as jest.Mock

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  // Establish the default project scope outside any liveQuery, the way the
  // app bootstrap does before /goals ever renders.
  await resolveScopeProjectId()
  breakpointMock.mockReturnValue("desktop")
  useSettingsStore.setState({ settings: null, save: jest.fn().mockResolvedValue(undefined) })
})
afterAll(dbFixture.dispose)

async function seed(goals: Goal[]) {
  await getDb().chatGoals.bulkAdd(goals)
}

function goal(id: string, over: Partial<Goal> = {}): Goal {
  return makeGoal({
    id,
    sessionId: `ses_${id}`,
    safeObjective: `objective ${id}`,
    rawObjective: `objective ${id}`,
    ...over,
  })
}

type Navigate = jest.Mock<void, [GoalConsolePlace, { replace?: boolean }?]>

/**
 * Plays the route: holds the address, hands it to the console, and applies
 * every `onNavigate` back to it, so a click lands where a real one would.
 */
function Routed({
  initial,
  initialGoalId = null,
  navigate,
}: {
  initial: GoalConsoleLocation | null
  initialGoalId?: string | null
  navigate: Navigate
}) {
  const [location, setLocation] = useState(initial)
  const [goalId, setGoalId] = useState<string | null>(initialGoalId)
  // The app root mounts both providers (`app/layout.tsx`).
  return (
    <DataAdapterProvider adapter={dexieAdapter}>
      <TooltipProvider>
        <GoalConsole
          location={location}
          selectedGoalId={goalId}
          onNavigate={(place, options) => {
            navigate(place, options)
            setLocation({ tab: place.tab, section: place.section })
            setGoalId(place.goalId ?? null)
          }}
        />
      </TooltipProvider>
    </DataAdapterProvider>
  )
}

function renderConsole(
  options: { location?: GoalConsoleLocation | null; goalId?: string | null } = {}
) {
  const navigate: Navigate = jest.fn()
  const utils = render(
    <Routed
      initial={options.location ?? null}
      initialGoalId={options.goalId ?? null}
      navigate={navigate}
    />
  )
  return { ...utils, navigate }
}

const tab = (id: string) => screen.getByTestId(`goal-console-tab-${id}`)

describe("GoalConsole", () => {
  it("renders the header with its four tabs and the New goal action", async () => {
    renderConsole()
    expect(await screen.findByTestId("goal-console")).toBeInTheDocument()
    const tablist = screen.getByRole("tablist", { name: "Goal sections" })
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((trigger) => trigger.textContent)
    ).toEqual(["Overview", "History", "Analytics", "Configure"])
    expect(screen.getByTestId("goal-console-header")).toHaveTextContent("Goals")
    expect(screen.getByTestId("goal-quick-create-trigger")).toBeInTheDocument()
  })

  it("opens on Overview when the address names no tab", async () => {
    renderConsole()
    expect(await screen.findByTestId("goal-overview-section")).toBeInTheDocument()
    expect(tab("overview")).toHaveAttribute("data-state", "active")
  })

  it("opens on the user's default tab when the address names none", async () => {
    useSettingsStore.setState({
      settings: { goalConsolePrefs: { defaultTab: "history" } } as never,
    })
    renderConsole()
    expect(await screen.findByTestId("goals-history-empty")).toBeInTheDocument()
    expect(tab("history")).toHaveAttribute("data-state", "active")
  })

  it("honours the tab in the address over the default", async () => {
    renderConsole({ location: { tab: "analytics" } })
    expect(tab("analytics")).toHaveAttribute("data-state", "active")
    expect(await screen.findByTestId("goal-analytics-empty")).toBeInTheDocument()
  })

  it("pushes a tab switch to the address", async () => {
    const user = userEvent.setup()
    const { navigate } = renderConsole()
    await user.click(tab("history"))
    expect(navigate).toHaveBeenLastCalledWith(
      { tab: "history", section: undefined, goalId: null },
      undefined
    )
    expect(tab("history")).toHaveAttribute("data-state", "active")
    expect(await screen.findByTestId("goals-history-empty")).toBeInTheDocument()
  })

  it("shows the Overview empty state when nothing is open", async () => {
    renderConsole()
    expect(await screen.findByTestId("goal-console-active-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-console-needs-you-badge")).not.toBeInTheDocument()
  })

  it("lists the workspace's open goals on Overview", async () => {
    await seed([goal("open"), goal("done", { status: "completed" })])
    renderConsole()
    const list = await screen.findByTestId("goal-console-open-list")
    await waitFor(() => expect(within(list).getAllByTestId("goal-list-row")).toHaveLength(1))
    expect(within(list).getByText("objective open")).toBeInTheDocument()
  })

  it("badges the Overview tab with the goals waiting on a verdict", async () => {
    await seed([
      goal("w1", { status: "paused", awaitingAcceptance: true }),
      goal("w2", { status: "paused", awaitingAcceptance: true }),
      goal("run"),
    ])
    renderConsole({ location: { tab: "analytics" } })
    const badge = await screen.findByTestId("goal-console-needs-you-badge")
    expect(badge).toHaveTextContent("2")
    expect(badge).toHaveAccessibleName("2 goals need you")
  })

  it("selects a goal into the inspector pane, replacing the address", async () => {
    const user = userEvent.setup()
    await seed([goal("a")])
    const { navigate } = renderConsole()
    await user.click(await screen.findByTestId("goal-list-row-select"))
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "overview", goalId: "a" }),
      { replace: true }
    )
    const panel = await screen.findByTestId("mock-detail-panel")
    expect(panel).toHaveAttribute("data-goal-id", "a")
    // The open-goals read is handed over for the first paint.
    expect(panel).toHaveAttribute("data-initial", "a")
    expect(screen.queryByTestId("mock-detail-sheet")).not.toBeInTheDocument()
    expect(screen.getByTestId("goal-list-row")).toHaveAttribute("data-selected", "true")
  })

  it("closes the inspector by clearing the goal from the address", async () => {
    const user = userEvent.setup()
    await seed([goal("a")])
    const { navigate } = renderConsole({ location: { tab: "overview" }, goalId: "a" })
    await user.click(await screen.findByTestId("mock-detail-close"))
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "overview", goalId: null }),
      { replace: true }
    )
    expect(screen.queryByTestId("mock-detail-panel")).not.toBeInTheDocument()
  })

  it("drops the selection when the inspected goal is deleted", async () => {
    const user = userEvent.setup()
    const { navigate } = renderConsole({ location: { tab: "history" }, goalId: "gone" })
    await user.click(await screen.findByTestId("mock-detail-deleted"))
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "history", goalId: null }),
      { replace: true }
    )
  })

  it("keeps the selected goal across a tab switch, and hides the inspector on Configure", async () => {
    const { navigate } = renderConsole({ location: { tab: "history" }, goalId: "a" })
    expect(await screen.findByTestId("mock-detail-panel")).toBeInTheDocument()
    // jsdom lays every element out at 0×0, so with the inspector pane open
    // react-resizable-panels claims any pointer press as a press on its
    // handle. Radix activates a tab on mousedown, which the panels ignore.
    fireEvent.mouseDown(tab("config"), { button: 0 })
    expect(navigate).toHaveBeenLastCalledWith(
      { tab: "config", section: "defaults", goalId: "a" },
      undefined
    )
    expect(screen.queryByTestId("mock-detail-panel")).not.toBeInTheDocument()
  })

  it("shows the inspector as a sheet below the desktop tier", async () => {
    const user = userEvent.setup()
    breakpointMock.mockReturnValue("tablet")
    await seed([goal("a")])
    const { navigate } = renderConsole({ location: { tab: "overview" }, goalId: "a" })
    const sheet = await screen.findByTestId("mock-detail-sheet")
    expect(sheet).toHaveAttribute("data-goal-id", "a")
    expect(screen.queryByTestId("mock-detail-panel")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("mock-sheet-close"))
    expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({ goalId: null }), {
      replace: true,
    })
    expect(screen.queryByTestId("mock-detail-sheet")).not.toBeInTheDocument()
  })

  it("draws no sheet for a selected goal that does not exist", async () => {
    breakpointMock.mockReturnValue("mobile")
    renderConsole({ location: { tab: "overview" }, goalId: "missing" })
    await screen.findByTestId("goal-console-active-empty")
    // The sheet waits for the goal row; a missing one never opens it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByTestId("mock-detail-sheet")).not.toBeInTheDocument()
  })

  it("opens History filtered to completed goals from the Completed cell", async () => {
    await seed([
      goal("won", { status: "completed", createdAt: GOAL_NOW - 10 }),
      goal("lost", { status: "stopped", createdAt: GOAL_NOW - 20 }),
    ])
    const { navigate } = renderConsole()
    fireEvent.click(await screen.findByTestId("goal-stat-completed"))
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "history" }),
      undefined
    )
    await waitFor(() => expect(screen.getAllByTestId("goals-history-row")).toHaveLength(1))
    expect(screen.getByTestId("goals-history-row")).toHaveTextContent("objective won")
    expect(screen.getByTestId("goals-history-status")).toHaveTextContent("completed")
  })

  it("opens Analytics from the average cells", async () => {
    const { navigate } = renderConsole()
    fireEvent.click(await screen.findByTestId("goal-stat-avg-turns"))
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ tab: "analytics" }),
      undefined
    )
    expect(tab("analytics")).toHaveAttribute("data-state", "active")
  })

  it("routes Configure's panel through the address", async () => {
    const user = userEvent.setup()
    const { navigate } = renderConsole({ location: { tab: "config", section: "tracker" } })
    expect(screen.getByTestId("mock-config-section")).toHaveAttribute("data-section", "tracker")
    await user.click(screen.getByTestId("mock-config-to-templates"))
    expect(navigate).toHaveBeenLastCalledWith(
      { tab: "config", section: "templates", goalId: null },
      { replace: true }
    )
    expect(screen.getByTestId("mock-config-section")).toHaveAttribute("data-section", "templates")
  })

  it("opens Configure on the Defaults panel when no section is named", () => {
    renderConsole({ location: { tab: "config" } })
    expect(screen.getByTestId("mock-config-section")).toHaveAttribute("data-section", "defaults")
  })
})
