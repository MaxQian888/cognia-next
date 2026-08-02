/**
 * Execution-strategy resolution for the Unified Plan Execution Hub (ADR-0045
 * §2, P3). Pure — no Dexie, no IPC — so the decision is unit-testable and the
 * runtime keeps one branch instead of an inline heuristic.
 *
 * `AgentPlan.executionMode` was persisted from day one but never read: every
 * approved plan ran through the orchestrated path regardless. This module is
 * the missing reader.
 *
 *   in_session   — the plan is driven as visible turns in the chat session
 *                  (`lib/agent/plan/turn-driver.ts`), one step per turn.
 *   orchestrated — the plan is compiled into a VisualWorkflow and executed
 *                  headlessly (`synthesizePlanWorkflow` → `runWorkflow`).
 */

import type { AgentPlan, PlanStep } from "@/types/agent/plan"

export type PlanRunStrategy = "in_session" | "orchestrated"

/** The plan fields the resolution actually depends on. */
export type StrategyInput = Pick<AgentPlan, "executionMode" | "steps" | "source">

/**
 * True when the steps form a simple chain: ordered, every step an `agent_turn`,
 * and each step depending on nothing or only on its immediate predecessor.
 *
 * Anything else — a fan-out, a join, a `teammate_dispatch` / `sub_workflow` /
 * `tool_call` / `mcp_tool_call` / `approval_gate` step — needs the orchestrator's
 * concurrency, approval-bus and crash-recovery machinery, which the in-session
 * driver deliberately does not reimplement.
 */
export function isLinearAgentTurnPlan(steps: PlanStep[]): boolean {
  if (steps.length === 0) return false
  const ordered = [...steps].sort((a, b) => a.order - b.order)
  for (const [i, step] of ordered.entries()) {
    if (step.kind !== "agent_turn") return false
    const deps = step.dependencies
    if (deps.length === 0) continue
    if (deps.length > 1) return false
    if (i === 0) return false
    if (deps[0] !== ordered[i - 1].id) return false
  }
  return true
}

/**
 * Pick the execution strategy for a plan.
 *
 * An explicit `executionMode` always wins — `planInputFromGoal` pins
 * `in_session`, `planInputFromTeam` pins `orchestrated`, and a user can pick
 * either. `auto` resolves from the plan's shape AND its provenance:
 *
 *   - not a simple `agent_turn` chain → `orchestrated` (see
 *     {@link isLinearAgentTurnPlan}).
 *   - captured from `exit_plan_mode` → `orchestrated`. This is the Claude-Code
 *     parity carve-out: the model just proposed that plan in this very
 *     transcript, and approving it sends ONE implementing turn
 *     (`buildPlanApprovedPrompt`) that asks it to work the plan through. Feeding
 *     the same model its own steps back one per turn would duplicate work it is
 *     already doing. Such a plan only reaches an executor at all when something
 *     explicitly calls `runPlan` (scheduler / remote control / workflow node),
 *     which is headless anyway.
 *   - otherwise → `in_session`. A `planner_llm`, `manual` or `goal_projection`
 *     plan has no implementing turn behind it in the transcript, so the driver
 *     is what makes its steps happen at all.
 */
export function resolvePlanStrategy(plan: StrategyInput): PlanRunStrategy {
  if (plan.executionMode === "in_session") return "in_session"
  if (plan.executionMode === "orchestrated") return "orchestrated"
  if (!isLinearAgentTurnPlan(plan.steps)) return "orchestrated"
  if (plan.source === "exit_plan_mode") return "orchestrated"
  return "in_session"
}
