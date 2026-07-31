// Storybook-only fixtures for the `/goal` subsystem (`components/goal/**`).
// Mirrors the shapes the goal-status-pill story already builds inline, factored
// out so the console / detail-sheet / tab / analytics stories share one source
// of truth. Dependency-free (types only) so importing it never drags a store.
import type { Goal, GoalEvent, GoalStatus } from "@/types/goal"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"

/** Fixed clock so timeline buckets + "elapsed" counters render deterministically. */
export const GOAL_NOW = 1_700_000_000_000

/** Build a realistic active Goal; override any field for a variant. */
export function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: "goal_1",
    // Stamp the Default workspace so `listAllGoals` — which scopes by the
    // compound `[projectId+createdAt]` index — actually returns the seed. Dexie
    // omits rows whose compound-index component is undefined, so a goal without
    // `projectId` is invisible to scoped reads. `seedDb` warms the same scope.
    projectId: DEFAULT_PROJECT_ID,
    sessionId: "ses_a",
    rawObjective: "Triage the open bug backlog and draft fixes for the top 3",
    safeObjective: "Triage the open bug backlog and draft fixes for the top 3",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 7,
    tokensUsed: 84_200,
    judgeFailureCount: 0,
    config: {
      maxTurns: 20,
      maxTokens: 200_000,
      maxJudgeFailures: 3,
      timeoutMs: 30 * 60_000,
    },
    generationId: "gen-1",
    createdAt: GOAL_NOW - 22 * 60_000,
    updatedAt: GOAL_NOW,
    ...over,
  }
}

/** A spread of goals across statuses for the console / analytics dashboards. */
export function makeGoalSet(): Goal[] {
  const statuses: { status: GoalStatus; objective: string }[] = [
    { status: "active", objective: "Refactor the auth module for testability" },
    { status: "active", objective: "Write migration notes for the v2 schema" },
    { status: "paused", objective: "Audit the connector retry policy" },
    { status: "completed", objective: "Summarise last week's incident reports" },
    { status: "completed", objective: "Generate release notes for 1.4.0" },
    { status: "stopped", objective: "Explore a streaming-first inbox redesign" },
    { status: "turn_limited", objective: "Exhaustively label the support tickets" },
  ]
  return statuses.map((s, i) =>
    makeGoal({
      id: `goal_${i + 1}`,
      sessionId: `ses_${i + 1}`,
      rawObjective: s.objective,
      safeObjective: s.objective,
      status: s.status,
      turnsUsed: 3 + i * 2,
      tokensUsed: 20_000 + i * 18_000,
      generationId: `gen-${i + 1}`,
      createdAt: GOAL_NOW - (i + 1) * 6 * 60 * 60_000,
      updatedAt: GOAL_NOW - i * 30 * 60_000,
      endedAt: s.status === "active" || s.status === "paused" ? undefined : GOAL_NOW - i * 60_000,
    })
  )
}

/** Build a single lifecycle event for the Activity tab. */
export function makeGoalEvent(over: Partial<GoalEvent> & Pick<GoalEvent, "goalId">): GoalEvent {
  return {
    id: `gev_${Math.random().toString(36).slice(2)}`,
    kind: "turn_completed",
    ts: GOAL_NOW,
    payload: { kind: "turn_completed", turnNumber: 1, tokensDelta: 1200 },
    ...over,
  }
}

/** A reverse-chrono-ready event log for one goal (Activity tab populated state). */
export function makeGoalEventLog(goalId: string): GoalEvent[] {
  return [
    makeGoalEvent({
      goalId,
      kind: "goal_created",
      ts: GOAL_NOW - 20 * 60_000,
      payload: {
        kind: "goal_created",
        safeObjective: "Triage the open bug backlog",
        config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 30 * 60_000 },
      },
    }),
    makeGoalEvent({
      goalId,
      kind: "turn_started",
      ts: GOAL_NOW - 18 * 60_000,
      payload: { kind: "turn_started", turnNumber: 1 },
    }),
    makeGoalEvent({
      goalId,
      kind: "turn_completed",
      ts: GOAL_NOW - 17 * 60_000,
      payload: { kind: "turn_completed", turnNumber: 1, tokensDelta: 5400 },
    }),
    makeGoalEvent({
      goalId,
      kind: "judge_evaluated",
      ts: GOAL_NOW - 16 * 60_000,
      payload: {
        kind: "judge_evaluated",
        done: false,
        reason: "Two of three fixes drafted; the auth bug still needs a repro.",
        judgeTokens: 180,
      },
    }),
    makeGoalEvent({
      goalId,
      kind: "user_paused",
      ts: GOAL_NOW - 5 * 60_000,
      payload: { kind: "user_paused" },
    }),
  ]
}
