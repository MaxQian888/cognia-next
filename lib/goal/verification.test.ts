/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { createGoal, getGoal } from "@/lib/db/goals"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { Goal, GoalConfig } from "@/types/goal"
import type { ExecuteDeployedWorkflowResult } from "@/lib/workflow/runtime/execution-authority"
import {
  GOAL_VERIFICATION_INPUT_SCHEMA,
  GOAL_VERIFICATION_OUTPUT_SCHEMA,
  isGoalVerificationWorkflowVersion,
  verifyGoalCompletion,
} from "./verification"

const config: GoalConfig = {
  maxTurns: 20,
  maxTokens: 100_000,
  maxJudgeFailures: 3,
  timeoutMs: 60_000,
  verificationWorkflow: {
    workflowId: "wf-1",
    versionId: "wfv-1",
    deploymentId: "wfd-1",
    deploymentRevision: 1,
    dependencyLock: { workflows: {}, indexes: {} },
  },
}

async function seedGoal(): Promise<Goal> {
  return createGoal({
    id: "goal-1",
    sessionId: "session-1",
    rawObjective: "Ship safely",
    safeObjective: "Ship safely",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 2,
    tokensUsed: 100,
    judgeFailureCount: 0,
    config,
    generationId: "generation-1",
  })
}

function executionResult(output: unknown): ExecuteDeployedWorkflowResult {
  return {
    invocationId: "inv-1",
    runId: "workflow-run-1",
    reused: false,
    version: {} as never,
    executionBinding: {} as never,
    result: { runId: "workflow-run-1", status: "succeeded", output },
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("accepts only published interfaces that satisfy the verifier contract", () => {
  expect(
    isGoalVerificationWorkflowVersion({
      workflowId: "wf-1",
      id: "wfv-1",
      interface: {
        inputSchema: GOAL_VERIFICATION_INPUT_SCHEMA,
        outputSchema: GOAL_VERIFICATION_OUTPUT_SCHEMA,
      },
    } as never)
  ).toBe(true)
})

it("persists a passed workflow result and immutable idempotency key", async () => {
  await seedGoal()
  const execute = jest.fn(async (input) => {
    input.onAdmitted?.("workflow-run-1")
    return executionResult({ passed: true, summary: "All checks passed" })
  })
  await expect(
    verifyGoalCompletion(
      {
        goalId: "goal-1",
        candidateSummary: "Done for alice@example.com",
        capturedGenerationId: "generation-1",
      },
      { execute }
    )
  ).resolves.toMatchObject({ kind: "passed" })
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      idempotencyKey: "goal-verification:goal-1:generation-1:1",
      lockedDependency: config.verificationWorkflow,
    })
  )
  expect((await getGoal("goal-1"))?.verification).toMatchObject({
    status: "passed",
    workflowRunId: "workflow-run-1",
  })
})

it("reuses the same admission after reload instead of creating another attempt", async () => {
  await seedGoal()
  await getDb().chatGoals.update("goal-1", {
    verification: {
      attempt: 2,
      status: "running",
      idempotencyKey: "goal-verification:goal-1:generation-1:2",
      generationId: "generation-1",
      workflowRunId: "workflow-run-existing",
      failureCount: 1,
      candidateSummary: "Existing candidate",
      updatedAt: 1,
    },
  })
  const execute = jest.fn(async () => executionResult({ passed: true, summary: "Recovered" }))
  await verifyGoalCompletion(
    {
      goalId: "goal-1",
      candidateSummary: "Must not replace the durable candidate",
      capturedGenerationId: "generation-1",
    },
    { execute }
  )
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ idempotencyKey: "goal-verification:goal-1:generation-1:2" })
  )
  expect((await getGoal("goal-1"))?.verification).toMatchObject({
    attempt: 2,
    candidateSummary: "Existing candidate",
  })
})

it("pauses after three negative verdicts and immediately on contract errors", async () => {
  await seedGoal()
  const rejected = jest.fn(async () => executionResult({ passed: false, summary: "Missing tests" }))
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await verifyGoalCompletion(
      {
        goalId: "goal-1",
        candidateSummary: `Candidate ${attempt}`,
        capturedGenerationId: "generation-1",
      },
      { execute: rejected }
    )
  }
  expect(await getGoal("goal-1")).toMatchObject({
    status: "paused",
    verification: { status: "failed", failureCount: 3 },
  })

  await getDb().chatGoals.update("goal-1", {
    status: "active",
    generationId: "generation-2",
    verification: undefined,
  })
  await verifyGoalCompletion(
    { goalId: "goal-1", candidateSummary: "Candidate", capturedGenerationId: "generation-2" },
    { execute: async () => executionResult({ passed: "yes", summary: "bad" }) }
  )
  expect(await getGoal("goal-1")).toMatchObject({
    status: "paused",
    verification: { status: "error" },
  })
})
