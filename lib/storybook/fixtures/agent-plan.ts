// Storybook-only fixtures for the agent plan panels (ADR-0045). Builds a
// realistic `AgentPlan` so the approval card + tracker panel render full step
// lists, progress, and status badges without a live plan runtime.
import {
  computePlanCounts,
  DEFAULT_PLAN_CONFIG,
  type AgentPlan,
  type PlanStep,
  type PlanStepKind,
  type PlanStepStatus,
} from "@/types/agent/plan"

interface StepSeed {
  title: string
  status: PlanStepStatus
  kind?: PlanStepKind
}

const STEP_SEEDS: StepSeed[] = [
  { title: "Gather the failing test output", status: "completed", kind: "agent_turn" },
  {
    title: "Delegate root-cause analysis to the debugger teammate",
    status: "completed",
    kind: "teammate_dispatch",
  },
  { title: "Patch the reducer and re-run the suite", status: "in_progress", kind: "tool_call" },
  { title: "Request reviewer approval before merge", status: "pending", kind: "approval_gate" },
  { title: "Run the deployment sub-workflow", status: "pending", kind: "sub_workflow" },
]

function buildSteps(seeds: StepSeed[]): PlanStep[] {
  return seeds.map((seed, index) => ({
    id: `step-${index + 1}`,
    title: seed.title,
    kind: seed.kind ?? "agent_turn",
    status: seed.status,
    order: index,
    dependencies: index > 0 ? [`step-${index}`] : [],
  }))
}

export function buildPlan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? buildSteps(STEP_SEEDS)
  const counts = computePlanCounts(steps)
  return {
    id: "plan-1",
    sessionId: "session-1",
    title: "Fix the off-by-one in the plan reducer",
    description: "Reproduce, patch, review, and ship the reducer fix.",
    source: "planner_llm",
    executionMode: "auto",
    steps,
    status: "executing",
    currentStepId: "step-3",
    totalSteps: counts.totalSteps,
    completedSteps: counts.completedSteps,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "gen-1",
    createdAt: Date.UTC(2026, 5, 29),
    updatedAt: Date.UTC(2026, 5, 29),
    ...over,
  }
}

/** A fresh draft plan awaiting approval (all steps pending). */
export function buildDraftPlan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = buildSteps(STEP_SEEDS.map((s) => ({ ...s, status: "pending" })))
  return buildPlan({
    status: "awaiting_approval",
    source: "exit_plan_mode",
    currentStepId: undefined,
    steps,
    ...over,
  })
}

/** A realistic markdown plan body — what `exit_plan_mode` captures. */
export const SAMPLE_PLAN_MARKDOWN = `## Overview

Refactor the plan reducer to fix the off-by-one and add regression coverage.

### Steps

1. **Reproduce** the failure with a focused unit test.
2. Patch \`applyStepStatus\` to clamp the cursor.
3. Re-run the suite and confirm it's green.

\`\`\`ts
const next = Math.min(index, steps.length - 1)
\`\`\`

> Ship behind the existing plan-mode flag.`

/**
 * A draft `exit_plan_mode` plan carrying its full markdown body in
 * `metadata.planText` — the approval card renders this instead of the lossy
 * step-title projection.
 */
export function buildMarkdownPlan(over: Partial<AgentPlan> = {}): AgentPlan {
  return buildDraftPlan({ metadata: { planText: SAMPLE_PLAN_MARKDOWN }, ...over })
}
