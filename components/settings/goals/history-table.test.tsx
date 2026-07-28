import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createGoal } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"
import { GoalsHistoryTable } from "./history-table"

const CONFIG: Goal["config"] = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(overrides: Partial<Goal> = {}): Parameters<typeof createGoal>[0] {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    sessionId: overrides.sessionId ?? "ses_a",
    rawObjective: overrides.rawObjective ?? "x",
    safeObjective: overrides.safeObjective ?? "ship feature",
    redactionMapEnc: "",
    status: overrides.status ?? "active",
    turnsUsed: overrides.turnsUsed ?? 1,
    tokensUsed: overrides.tokensUsed ?? 100,
    judgeFailureCount: 0,
    config: CONFIG,
    generationId: "gen-1",
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("GoalsHistoryTable", () => {
  it("shows the empty-state when no goals exist", async () => {
    render(<GoalsHistoryTable />)
    await waitFor(() => expect(screen.getByTestId("goals-history-empty")).toBeInTheDocument())
  })

  it("renders a row per goal", async () => {
    await createGoal(buildGoal({ id: "g_a", safeObjective: "alpha" }))
    await createGoal(buildGoal({ id: "g_b", safeObjective: "beta", status: "completed" }))
    render(<GoalsHistoryTable />)
    await waitFor(() => {
      const rows = screen.getAllByTestId("goals-history-row")
      expect(rows).toHaveLength(2)
    })
    expect(screen.getByText("alpha")).toBeInTheDocument()
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("filters rows by the search query", async () => {
    await createGoal(buildGoal({ id: "g_a", safeObjective: "alpha objective" }))
    await createGoal(buildGoal({ id: "g_b", safeObjective: "beta objective" }))
    render(<GoalsHistoryTable />)
    await waitFor(() => expect(screen.getAllByTestId("goals-history-row")).toHaveLength(2))
    fireEvent.change(screen.getByTestId("goals-history-search"), { target: { value: "alpha" } })
    await waitFor(() => expect(screen.getAllByTestId("goals-history-row")).toHaveLength(1))
    expect(screen.getByText("alpha objective")).toBeInTheDocument()
  })

  it("shows a no-results state when filters exclude everything", async () => {
    await createGoal(buildGoal({ id: "g_a", safeObjective: "alpha" }))
    render(<GoalsHistoryTable />)
    await waitFor(() => expect(screen.getByTestId("goals-history-table")).toBeInTheDocument())
    fireEvent.change(screen.getByTestId("goals-history-search"), { target: { value: "zzzzz" } })
    await waitFor(() => expect(screen.getByTestId("goals-history-no-results")).toBeInTheDocument())
  })

  it("opens the delete confirm and removes the goal", async () => {
    await createGoal(buildGoal({ id: "g_a", safeObjective: "alpha" }))
    render(<GoalsHistoryTable />)
    await waitFor(() => expect(screen.getByTestId("goals-history-delete")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("goals-history-delete"))
    fireEvent.click(await screen.findByTestId("goals-history-delete-confirm"))
    await waitFor(async () => expect(await getDb().chatGoals.count()).toBe(0))
    await waitFor(() => expect(screen.getByTestId("goals-history-empty")).toBeInTheDocument())
  })

  it("toggles sort direction", async () => {
    await createGoal(buildGoal({ id: "g_a", safeObjective: "alpha" }))
    render(<GoalsHistoryTable />)
    const dirBtn = await screen.findByTestId("goals-history-dir")
    fireEvent.click(dirBtn)
    // Still renders the table after flipping direction.
    expect(screen.getByTestId("goals-history-table")).toBeInTheDocument()
  })
})
