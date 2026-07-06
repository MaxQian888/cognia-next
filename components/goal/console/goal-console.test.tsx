import "fake-indexeddb/auto"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"

// The quick-create dialog uses the app router — stub it for the console test.
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))

import { GoalConsole } from "./goal-console"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
})

describe("GoalConsole", () => {
  it("renders the header and the five management tabs", async () => {
    render(<GoalConsole />)
    expect(await screen.findByTestId("goal-console")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-tab-history")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-tab-analytics")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-tab-templates")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-tab-defaults")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-tab-tracker")).toBeInTheDocument()
  })

  it("renders the StatCard row", async () => {
    render(<GoalConsole />)
    expect(await screen.findByTestId("goal-stat-active")).toBeInTheDocument()
    expect(screen.getByTestId("goal-stat-token-spend")).toBeInTheDocument()
  })

  it("shows the empty state when there are no open goals", async () => {
    render(<GoalConsole />)
    expect(await screen.findByTestId("goal-console-active-empty")).toBeInTheDocument()
  })

  it("lists open goals as pills", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "ship the thing" })
    render(<GoalConsole />)
    const list = await screen.findByTestId("goal-console-open-list")
    expect(within(list).getByText("ship the thing")).toBeInTheDocument()
  })

  it("honours the initialTab deep link", async () => {
    render(<GoalConsole initialTab="analytics" />)
    const analyticsTab = await screen.findByTestId("goal-console-tab-analytics")
    expect(analyticsTab).toHaveAttribute("data-state", "active")
  })

  it("clicking the avg-turns stat card jumps to the Analytics tab", async () => {
    render(<GoalConsole />)
    // History is the default tab.
    expect((await screen.findByTestId("goal-console-tab-history")).getAttribute("data-state")).toBe(
      "active"
    )
    fireEvent.click(screen.getByTestId("goal-stat-avg-turns"))
    expect(screen.getByTestId("goal-console-tab-analytics")).toHaveAttribute("data-state", "active")
  })

  it("renders the open-goals toolbar and filters by search query", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "ship the thing" })
    render(<GoalConsole />)
    expect(await screen.findByTestId("goal-console-open-toolbar")).toBeInTheDocument()
    const search = screen.getByTestId("goal-console-open-search") as HTMLInputElement
    fireEvent.change(search, { target: { value: "no-such-objective" } })
    expect(await screen.findByTestId("goal-console-open-no-results")).toBeInTheDocument()
  })

  it("scoping to paused via the stat card hides an active-only goal", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "ship the thing" })
    render(<GoalConsole />)
    await screen.findByTestId("goal-console-open-list")
    fireEvent.click(screen.getByTestId("goal-stat-paused"))
    expect(await screen.findByTestId("goal-console-open-no-results")).toBeInTheDocument()
  })
})
