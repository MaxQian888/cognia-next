/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { ChatSession } from "@cognia/agent-config-types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import type { Goal } from "@/types/goal"
import type { AgentPlan } from "@/types/agent/plan"
import {
  agentStateExecutionRunId,
  syncGoalExecutionRun,
  syncPlanExecutionRun,
} from "./agent-state-bridge"

function session(id = "session-1"): ChatSession {
  const conversationKey = `lark:lark-1:${id}`
  return {
    id,
    title: "IM session",
    createdAt: 1,
    updatedAt: 1,
    platformBinding: {
      adapterId: "lark-1",
      platform: "lark",
      conversationKey,
      conversationRef: { platform: "lark", adapterId: "lark-1", chatId: id },
      deliveryTarget: {
        address: {
          adapterId: "lark-1",
          platform: "lark",
          conversationKey,
          scopeKind: "group",
          containerId: id,
        },
        conversationRef: { platform: "lark", adapterId: "lark-1", chatId: id },
        sourceMessageId: "source-message-1",
        refreshedAt: 1,
      },
    },
  }
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    sessionId: "session-1",
    rawObjective: "private objective",
    safeObjective: "redacted objective",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: {
      maxTurns: 20,
      maxTokens: 200_000,
      maxJudgeFailures: 3,
      timeoutMs: 1_800_000,
    },
    generationId: "generation-1",
    createdAt: 10,
    updatedAt: 20,
    subgoals: [
      { id: "goal-step-1", text: "private first step", done: true, order: 0 },
      { id: "goal-step-2", text: "private second step", done: false, order: 1 },
    ],
    ...overrides,
  }
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan-1",
    sessionId: "session-1",
    title: "Release plan",
    source: "manual",
    executionMode: "auto",
    steps: [
      {
        id: "plan-step-1",
        title: "private first step",
        kind: "agent_turn",
        status: "completed",
        order: 0,
        dependencies: [],
      },
      {
        id: "plan-step-2",
        title: "private second step",
        kind: "agent_turn",
        status: "pending",
        order: 1,
        dependencies: ["plan-step-1"],
      },
    ],
    status: "awaiting_approval",
    totalSteps: 2,
    completedSteps: 1,
    config: {
      requireApproval: true,
      maxAutoRefinements: 2,
      maxStepRetries: 1,
      judgeDeviation: false,
      errorPolicy: "stop",
      maxConcurrency: 1,
    },
    refinementCount: 0,
    generationId: "generation-1",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  }
}

describe("agent state execution bridge", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("projects a live Goal into the shared durable run and binding without objective text", async () => {
    const row = session()
    await syncGoalExecutionRun(goal(), row)
    await syncGoalExecutionRun(goal(), row)

    const runId = agentStateExecutionRunId("goal", "goal-1")
    const run = await getDb().executionRuns.get(runId)
    expect(run?.latestSnapshot).toMatchObject({
      kind: "goal",
      title: "Goal",
      status: "running",
      progress: { completed: 1, total: 2, trustworthy: true },
    })
    expect(JSON.stringify(run?.latestSnapshot)).not.toContain("private objective")
    expect(JSON.stringify(run?.latestSnapshot)).not.toContain("private first step")
    expect(await getDb().executionRunEvents.where("runId").equals(runId).count()).toBe(4)
    expect(await getDb().executionRunBindings.where("runId").equals(runId).first()).toMatchObject({
      sourceMessageId: "source-message-1",
      deliveryMode: "native",
    })
  })

  it("projects a structured Plan and keeps waiting state idempotent", async () => {
    const row = session()
    await syncPlanExecutionRun(plan(), row)
    await syncPlanExecutionRun(plan(), row)

    const runId = agentStateExecutionRunId("plan", "plan-1")
    const run = await getDb().executionRuns.get(runId)
    expect(run?.latestSnapshot).toMatchObject({
      kind: "plan",
      status: "waiting",
      progress: { completed: 1, total: 2, trustworthy: true },
    })
    expect(run?.latestSnapshot?.pendingInterrupt).toBeUndefined()
    expect(run?.latestSnapshot?.allowedActions).toEqual(["stop", "open_details"])
    expect(JSON.stringify(run?.latestSnapshot)).not.toContain("private first step")
    expect(await getDb().executionRunEvents.where("runId").equals(runId).count()).toBe(4)
  })

  it("does not create a presenter binding when live activity is disabled", async () => {
    const row = session("session-disabled")
    await upsertByConversationKey({
      conversationKey: row.platformBinding!.conversationKey,
      sessionId: row.id,
      liveActivity: false,
    })

    await syncGoalExecutionRun(goal({ id: "goal-disabled", sessionId: row.id }), row)

    const runId = agentStateExecutionRunId("goal", "goal-disabled")
    expect(await getDb().executionRuns.get(runId)).toBeDefined()
    expect(await getDb().executionRunBindings.where("runId").equals(runId).count()).toBe(0)
  })
})
