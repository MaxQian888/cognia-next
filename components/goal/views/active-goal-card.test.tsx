import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"
import { ActiveGoalCard } from "./active-goal-card"

// next-intl globally mocked in jest.setup.ts.

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
})

async function makeGoal(over: Partial<Goal["config"]> = {}, status: Goal["status"] = "active") {
  const g = await getGoalRuntime().createGoal({
    sessionId: "ses_a",
    rawObjective: "ship the feature",
    config: over,
  })
  if (status !== "active") {
    await getDb().chatGoals.update(g.id, { status })
  }
  return (await getDb().chatGoals.get(g.id))!
}

describe("ActiveGoalCard", () => {
  it("renders status, objective and progress meters", async () => {
    const goal = await makeGoal()
    render(<ActiveGoalCard goal={goal} />)
    expect(screen.getByTestId("active-goal-card")).toBeInTheDocument()
    expect(screen.getByText("ship the feature")).toBeInTheDocument()
    expect(screen.getByText("Turns")).toBeInTheDocument()
    expect(screen.getByText("Tokens")).toBeInTheDocument()
  })

  it("shows Pause for an active goal and pauses on click", async () => {
    const goal = await makeGoal()
    render(<ActiveGoalCard goal={goal} />)
    expect(screen.queryByTestId("active-card-resume")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("active-card-pause"))
    await waitFor(async () => {
      const updated = await getDb().chatGoals.get(goal.id)
      expect(updated?.status).toBe("paused")
    })
  })

  it("shows Resume for a paused goal", async () => {
    const goal = await makeGoal({}, "paused")
    render(<ActiveGoalCard goal={goal} />)
    expect(screen.getByTestId("active-card-resume")).toBeInTheDocument()
    expect(screen.queryByTestId("active-card-pause")).not.toBeInTheDocument()
  })

  it("shows the Continue control only when manualContinue is on", async () => {
    const plain = await makeGoal()
    const { unmount } = render(<ActiveGoalCard goal={plain} />)
    expect(screen.queryByTestId("active-card-continue")).not.toBeInTheDocument()
    unmount()

    const manual = await makeGoal({ manualContinue: true })
    render(<ActiveGoalCard goal={manual} />)
    expect(screen.getByTestId("active-card-continue")).toBeInTheDocument()
  })

  it("opens the detail sheet from the details control", async () => {
    const goal = await makeGoal()
    render(<ActiveGoalCard goal={goal} />)
    fireEvent.click(screen.getByTestId("active-card-details"))
    expect(await screen.findByText(/Goal · active/)).toBeInTheDocument()
  })

  it("renders the compact variant with controls and objective", async () => {
    const goal = await makeGoal()
    render(<ActiveGoalCard goal={goal} variant="compact" />)
    const card = screen.getByTestId("active-goal-card")
    expect(card).toHaveAttribute("data-variant", "compact")
    expect(screen.getByText("ship the feature")).toBeInTheDocument()
    expect(screen.getByTestId("active-card-pause")).toBeInTheDocument()
    // Meters are collapsed to inline text — no progress bars.
    expect(screen.queryByText("Turns")).not.toBeInTheDocument()
  })
})
