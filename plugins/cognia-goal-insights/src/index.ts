/**
 * Goal Insights — built-in reference plugin for the goal lifecycle hooks.
 *
 * Ships a `hooks` block on its `PluginDefinition` (registered by the manager
 * on enable, dispatched by `lib/plugin/messaging/hooks-system.ts`). Reacts to
 * `onGoalCreate` / `onGoalComplete` by recording a redacted snapshot — proving
 * the new goal hooks fire end-to-end with a real enable-able plugin.
 *
 * The hook payload carries only `safeObjective` (the redacted text), never the
 * raw objective — so this demo can never observe stripped PII.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import type { GoalHookPayload, PluginHooksAll } from "@/types/plugin/plugin-hooks"
import manifest from "../plugin.json"

// In-memory log of observed goal events. Exported for tests; in a real plugin
// this might drive a dashboard or push a metric.
interface GoalInsightEntry {
  kind: "created" | "completed"
  goalId: string
  status: string
  safeObjective: string
  turnsUsed: number
}

const insights: GoalInsightEntry[] = []

/** Test/inspection accessor — the recorded insight log. */
export function getGoalInsights(): readonly GoalInsightEntry[] {
  return insights
}

/** Test-only reset. */
export function __resetGoalInsightsForTesting(): void {
  insights.length = 0
}

function record(kind: "created" | "completed", goal: GoalHookPayload): void {
  insights.push({
    kind,
    goalId: goal.goalId,
    status: goal.status,
    safeObjective: goal.safeObjective,
    turnsUsed: goal.turnsUsed,
  })
}

const hooks: PluginHooksAll = {
  onGoalCreate: (goal) => record("created", goal),
  onGoalComplete: (goal) => record("completed", goal),
}

const definition: PluginDefinition = {
  manifest: manifest as never,
  // Hooks are REGISTERED by returning them from activate() (the manager
  // captures the return value) — `PluginDefinition` has no static `hooks` field.
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("goal-insights activated (listening for goal lifecycle hooks)")
    return hooks
  },
  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger?.info("goal-insights deactivated")
  },
}

export default definition
