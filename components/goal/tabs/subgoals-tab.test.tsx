import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"

// next-intl globally mocked against en.json in jest.setup.ts.

let llmClient: { complete: jest.Mock } | null = null
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: () => llmClient,
}))

import { GoalSubgoalsTab } from "./subgoals-tab"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
  llmClient = { complete: jest.fn() }
})

async function makeGoal(): Promise<Goal> {
  const g = await getGoalRuntime().createGoal({
    sessionId: "ses_a",
    rawObjective: "ship the feature",
  })
  return (await getDb().chatGoals.get(g.id))!
}

describe("GoalSubgoalsTab", () => {
  it("renders the empty state with a generate button", async () => {
    const goal = await makeGoal()
    render(<GoalSubgoalsTab goal={goal} />)
    await waitFor(() => expect(screen.getByTestId("goal-subgoals-empty")).toBeInTheDocument())
    expect(screen.getByTestId("goal-subgoals-generate")).toBeInTheDocument()
  })

  it("generates and renders a checklist with progress", async () => {
    const goal = await makeGoal()
    llmClient!.complete.mockResolvedValue('{"steps": ["Plan", "Build", "Verify"]}')
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    await waitFor(() => expect(screen.getAllByTestId("goal-subgoal-item")).toHaveLength(3))
    expect(screen.getByTestId("goal-subgoals-progress")).toBeInTheDocument()
    expect(screen.getByText("Plan")).toBeInTheDocument()
  })

  it("toggles a subgoal's done state", async () => {
    const goal = await makeGoal()
    llmClient!.complete.mockResolvedValue('{"steps": ["Plan"]}')
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    const checkbox = await screen.findByTestId("goal-subgoal-checkbox")
    fireEvent.click(checkbox)
    await waitFor(async () => {
      const fresh = await getDb().chatGoals.get(goal.id)
      expect(fresh?.subgoals?.[0].done).toBe(true)
    })
  })

  it("shows an error when no LLM client is available", async () => {
    const goal = await makeGoal()
    llmClient = null
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    await waitFor(() => expect(screen.getByTestId("goal-subgoals-error")).toBeInTheDocument())
  })

  it("shows an error when decomposition returns nothing", async () => {
    const goal = await makeGoal()
    llmClient!.complete.mockResolvedValue("garbage not json")
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    await waitFor(() => expect(screen.getByTestId("goal-subgoals-error")).toBeInTheDocument())
  })
})
