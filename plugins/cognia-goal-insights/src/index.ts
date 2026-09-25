/**
 * Goal Insights — opt-in EXAMPLE plugin for the goal lifecycle hooks.
 *
 * This is author reference material, not a product feature, and is labelled
 * that way on all three axes:
 *   - documented here and at {@link GOAL_INSIGHTS_EXAMPLE};
 *   - labelled in the UI: the plugin's name and description say "(example)"
 *     and that it adds no UI;
 *   - pinned by `index.test.ts` (no `startup` activation, no UI contribution).
 *
 * It is not enabled for anyone who did not turn it on. The host's own /goals
 * console already shows goal activity and analytics, so a plugin panel here
 * would only duplicate it; the example's observable effect is one redacted
 * line per event in this plugin's log (Plugins → Goal Insights → Logs).
 *
 * Hooks are REGISTERED by returning them from activate() (the manager captures
 * the return value). The payload carries only `safeObjective` (the redacted
 * text), never the raw objective, so the example can never observe stripped
 * PII. Nothing is kept in memory — there is no unbounded log to grow.
 */

import {
  definePlugin,
  definePluginManifest,
  type GoalHookPayload,
  type PluginContext,
  type PluginHooksAll,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

/**
 * Marker for the plugin's status: an example that demonstrates the goal hooks
 * and contributes no UI. Tests assert against it so the example cannot quietly
 * start auto-enabling or grow a surface without this changing too.
 */
export const GOAL_INSIGHTS_EXAMPLE = {
  example: true,
  surface: "plugin-log",
} as const

/** Longest objective excerpt written to the log. */
export const OBJECTIVE_EXCERPT_LIMIT = 120

export const manifest = definePluginManifest(manifestJson)

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > OBJECTIVE_EXCERPT_LIMIT
    ? `${flat.slice(0, OBJECTIVE_EXCERPT_LIMIT - 1)}…`
    : flat
}

/** The hook block, bound to the activation's logger. */
export function createGoalInsightHooks(logger: PluginContext["logger"]): PluginHooksAll {
  const record = (kind: "created" | "completed", goal: GoalHookPayload): void => {
    logger.info(
      `goal ${kind}: ${goal.goalId} status=${goal.status} turns=${goal.turnsUsed} objective="${excerpt(goal.safeObjective)}"`
    )
  }
  return {
    onGoalCreate: (goal) => record("created", goal),
    onGoalComplete: (goal) => record("completed", goal),
  }
}

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => createGoalInsightHooks(ctx.logger),
})
