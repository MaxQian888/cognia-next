import "fake-indexeddb/auto"
import { useState } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

import { TooltipProvider } from "@/components/ui/tooltip"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { GOAL_NOW, makeGoal } from "@/lib/storybook/fixtures/goal"
import type { Goal } from "@/types/goal"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
// Delete goes through the runtime; the default delegates to the real Dexie
// delete so the live list reacts, and a test can make it fail.
jest.mock("@/lib/goal/runtime", () => ({ getGoalRuntime: jest.fn() }))
// Sessions and agent names are a Dexie + data-adapter read with its own suite.
jest.mock("@/hooks/goal/use-goal-row-context", () => ({
  useGoalRowContext: () => ({
    sessionFor: (goal: Pick<Goal, "sessionId">) =>
      goal.sessionId === "ses_gone"
        ? null
        : ({ id: goal.sessionId, title: `Chat ${goal.sessionId}` } as ChatSession),
    agentNameFor: () => undefined,
    judgeNoteFor: () => null,
  }),
}))
jest.mock("@/components/goal/goal-quick-create-dialog", () => ({
  GoalQuickCreateDialog: ({ triggerTestId }: { triggerTestId?: string }) => (
    <button type="button" data-testid={triggerTestId ?? "mock-quick-create"} />
  ),
}))

import { toast } from "sonner"
import { deleteGoal } from "@/lib/db/goals"
import { getGoalRuntime } from "@/lib/goal/runtime"
import {
  ALL_GOAL_STATUSES,
  GOAL_HISTORY_PAGE,
  GoalHistorySection,
  type GoalHistorySectionProps,
} from "./goal-history-section"

const deleteMock = jest.fn((id: string) => deleteGoal(id))

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
  deleteMock.mockImplementation((id: string) => deleteGoal(id))
  ;(getGoalRuntime as jest.Mock).mockReturnValue({ deleteGoal: deleteMock })
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

/** The console owns the status filter; a stateful host stands in for it. */
function Host(props: Partial<GoalHistorySectionProps>) {
  const [status, setStatus] = useState(props.statusFilter ?? ALL_GOAL_STATUSES)
  return (
    <TooltipProvider>
      <GoalHistorySection
        selectedGoalId={props.selectedGoalId ?? null}
        onSelect={props.onSelect ?? jest.fn()}
        onDeleted={props.onDeleted ?? jest.fn()}
        statusFilter={status}
        onStatusFilterChange={(next) => {
          props.onStatusFilterChange?.(next)
          setStatus(next)
        }}
      />
    </TooltipProvider>
  )
}

const rows = () => screen.getAllByTestId("goals-history-row")

describe("GoalHistorySection", () => {
  it("shows a skeleton until the first read lands", async () => {
    render(<Host />)
    expect(screen.getByTestId("goals-history-loading")).toBeInTheDocument()
    expect(await screen.findByTestId("goals-history-empty")).toBeInTheDocument()
  })

  it("shows the empty state with its own create trigger when there are no goals", async () => {
    render(<Host />)
    const empty = await screen.findByTestId("goals-history-empty")
    expect(empty).toHaveTextContent("No goals yet")
    expect(screen.getByTestId("goals-history-create")).toBeInTheDocument()
  })

  it("renders a row per goal, newest first, with a status chip and its conversation", async () => {
    await seed([
      goal("old", { status: "completed", createdAt: GOAL_NOW - 2000 }),
      goal("new", { status: "stopped", createdAt: GOAL_NOW - 1000 }),
    ])
    render(<Host />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]).toHaveTextContent("objective new")
    expect(within(rows()[0]).getByTestId("goal-status-chip")).toHaveTextContent("stopped")
    expect(within(rows()[1]).getByTestId("goal-status-chip")).toHaveTextContent("completed")
    expect(within(rows()[0]).getByTestId("goal-conversation-link")).toHaveTextContent(
      "Chat ses_new"
    )
    expect(screen.getByRole("status")).toHaveTextContent("2 goals")
  })

  it("says the conversation is gone for a goal whose chat was deleted", async () => {
    await seed([goal("x", { sessionId: "ses_gone" })])
    render(<Host />)
    const row = (await screen.findAllByTestId("goals-history-row"))[0]
    expect(within(row).getByTestId("goal-conversation-missing")).toBeInTheDocument()
  })

  it("selects a goal from its objective and from the row, and marks the selected row", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    await seed([goal("a", { createdAt: GOAL_NOW - 10 }), goal("b", { createdAt: GOAL_NOW - 20 })])
    render(<Host onSelect={onSelect} selectedGoalId="b" />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    const [rowA, rowB] = rows()
    expect(rowB).toHaveAttribute("data-state", "selected")
    expect(within(rowB).getByTestId("goals-history-row-select")).toHaveAttribute(
      "aria-current",
      "true"
    )
    expect(rowA).not.toHaveAttribute("data-state")

    await user.click(within(rowA).getByTestId("goals-history-row-select"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith("a")
    await user.click(within(rowB).getAllByRole("cell")[1])
    expect(onSelect).toHaveBeenLastCalledWith("b")
  })

  it("filters by search, counts the matches, and clears with Escape", async () => {
    const user = userEvent.setup()
    await seed([
      goal("alpha", { createdAt: GOAL_NOW - 10 }),
      goal("beta", { createdAt: GOAL_NOW - 20 }),
    ])
    render(<Host />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    const search = screen.getByTestId("goals-history-search")
    await user.type(search, "alpha")
    expect(rows()).toHaveLength(1)
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2")
    await user.keyboard("{Escape}")
    expect(search).toHaveValue("")
    expect(rows()).toHaveLength(2)
  })

  it("shows no-results and clears every filter from it", async () => {
    const user = userEvent.setup()
    const onStatusFilterChange = jest.fn()
    await seed([goal("alpha")])
    render(<Host statusFilter="completed" onStatusFilterChange={onStatusFilterChange} />)
    expect(await screen.findByTestId("goals-history-no-results")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(onStatusFilterChange).toHaveBeenCalledWith(ALL_GOAL_STATUSES)
    await waitFor(() => expect(rows()).toHaveLength(1))
  })

  it("filters by status from the status select", async () => {
    const user = userEvent.setup()
    const onStatusFilterChange = jest.fn()
    await seed([
      goal("done", { status: "completed", createdAt: GOAL_NOW - 10 }),
      goal("halt", { status: "stopped", createdAt: GOAL_NOW - 20 }),
    ])
    render(<Host onStatusFilterChange={onStatusFilterChange} />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    await user.click(screen.getByTestId("goals-history-status"))
    await user.click(await screen.findByRole("option", { name: "stopped" }))
    expect(onStatusFilterChange).toHaveBeenCalledWith("stopped")
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveTextContent("objective halt")
  })

  it("sorts by tokens and flips the direction", async () => {
    const user = userEvent.setup()
    await seed([
      goal("cheap", { tokensUsed: 10, createdAt: GOAL_NOW - 1 }),
      goal("costly", { tokensUsed: 90_000, createdAt: GOAL_NOW - 2 }),
    ])
    render(<Host />)
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0]).toHaveTextContent("objective cheap")
    await user.click(screen.getByTestId("goals-history-sort"))
    await user.click(await screen.findByRole("option", { name: "Tokens" }))
    expect(rows()[0]).toHaveTextContent("objective costly")
    const dir = screen.getByTestId("goals-history-dir")
    expect(dir).toHaveAccessibleName("Descending")
    await user.click(dir)
    expect(dir).toHaveAccessibleName("Ascending")
    expect(rows()[0]).toHaveTextContent("objective cheap")
  })

  it("deletes a goal through the ⋯ menu after confirming", async () => {
    const user = userEvent.setup()
    const onDeleted = jest.fn()
    await seed([goal("a")])
    render(<Host onDeleted={onDeleted} />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    await user.click(screen.getByTestId("goal-actions-a"))
    await user.click(await screen.findByTestId("goal-action-delete"))
    await user.click(await screen.findByTestId("goal-delete-confirm"))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("a"))
    expect(await getDb().chatGoals.get("a")).toBeUndefined()
    expect(await screen.findByTestId("goals-history-empty")).toBeInTheDocument()
  })

  it("keeps the confirmation open and reports a failed delete", async () => {
    const user = userEvent.setup()
    deleteMock.mockRejectedValueOnce(new Error("disk unavailable"))
    await seed([goal("a")])
    render(<Host />)
    await waitFor(() => expect(rows()).toHaveLength(1))
    await user.click(screen.getByTestId("goal-actions-a"))
    await user.click(await screen.findByTestId("goal-action-delete"))
    await user.click(await screen.findByTestId("goal-delete-confirm"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't delete the goal", {
        description: "disk unavailable",
      })
    )
    expect(screen.getByTestId("goal-delete-dialog")).toBeInTheDocument()
    expect(await getDb().chatGoals.get("a")).toBeDefined()
  })

  it("reads a page at a time and loads the rest on request", async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: GOAL_HISTORY_PAGE + 2 }, (_, index) =>
      goal(`g${index}`, { status: "completed", createdAt: GOAL_NOW - index })
    )
    await seed(many)
    render(<Host />)
    await waitFor(() => expect(rows()).toHaveLength(GOAL_HISTORY_PAGE))
    expect(
      screen.getByText(`Showing ${GOAL_HISTORY_PAGE} of ${GOAL_HISTORY_PAGE + 2}`)
    ).toBeInTheDocument()
    await user.click(screen.getByTestId("goals-history-load-more"))
    await waitFor(() => expect(rows()).toHaveLength(GOAL_HISTORY_PAGE + 2))
    expect(screen.queryByTestId("goals-history-load-more")).not.toBeInTheDocument()
  }, 30_000)
})
