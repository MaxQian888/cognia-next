/**
 * Agent and Plan type definitions
 */

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped"

export interface PlanStep {
  id: string
  title: string
  description?: string
  status: PlanStepStatus
  order: number
  estimatedDuration?: number // in seconds
  actualDuration?: number
  startedAt?: Date
  completedAt?: Date
  error?: string
  output?: string
  dependencies?: string[] // IDs of steps that must complete first
  toolCalls?: string[] // IDs of associated tool calls
}

export interface AgentPlan {
  id: string
  sessionId: string
  title: string
  description?: string
  steps: PlanStep[]
  status: "draft" | "approved" | "executing" | "completed" | "failed" | "cancelled"
  createdAt: Date
  updatedAt: Date
  startedAt?: Date
  completedAt?: Date
  totalSteps: number
  completedSteps: number
  currentStepId?: string
  metadata?: Record<string, unknown>
}

export interface CreatePlanInput {
  sessionId: string
  title: string
  description?: string
  steps: Omit<PlanStep, "id" | "status" | "order">[]
}

export interface UpdatePlanInput {
  title?: string
  description?: string
  steps?: PlanStep[]
  status?: AgentPlan["status"]
}

export interface PlanRefinementRequest {
  planId: string
  refinementType: "optimize" | "simplify" | "expand" | "reorder"
  customInstructions?: string
}

export interface PlanRefinementResult {
  originalPlan: AgentPlan
  refinedPlan: AgentPlan
  changes: string[]
  reasoning: string
}

export interface AgentExecutionContext {
  plan: AgentPlan
  currentStep: PlanStep | null
  previousSteps: PlanStep[]
  remainingSteps: PlanStep[]
  sessionId: string
  startTime: Date
  elapsedTime: number
}

export const PLAN_REFINEMENT_PROMPTS: Record<PlanRefinementRequest["refinementType"], string> = {
  optimize: `Analyze the given plan and optimize it for efficiency. Combine redundant steps, parallelize independent tasks where possible, and ensure the most efficient execution order. Maintain the original goals while reducing complexity.`,

  simplify: `Simplify the given plan by breaking down complex steps into smaller, more manageable tasks. Remove unnecessary complexity while ensuring all original objectives are still achievable.`,

  expand: `Expand the given plan with more detailed steps. Add intermediate checkpoints, validation steps, and error handling considerations. Make the plan more comprehensive and robust.`,

  reorder: `Analyze the dependencies between steps and reorder them for optimal execution. Ensure prerequisites are completed before dependent steps, and group related tasks together.`,
}
