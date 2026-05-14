import { render, screen } from "@testing-library/react"
import type { Goal } from "@/types/goal"
import { GoalSubgoalsTab } from "./subgoals-tab"

const goal: Goal = {
  id: "g1",
  sessionId: "ses_a",
  rawObjective: "x",
  safeObjective: "redesign the onboarding flow",
  redactionMapEnc: "",
  status: "active",
  turnsUsed: 0,
  tokensUsed: 0,
  judgeFailureCount: 0,
  config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 30 * 60_000 },
  generationId: "gen-1",
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

describe("GoalSubgoalsTab", () => {
  it("shows the Phase 2 placeholder", () => {
    render(<GoalSubgoalsTab goal={goal} />)
    expect(screen.getByTestId("goal-subgoals-placeholder")).toBeInTheDocument()
    expect(screen.getByText(/Subgoals — Phase 2/)).toBeInTheDocument()
    expect(screen.getByText("redesign the onboarding flow")).toBeInTheDocument()
  })
})
