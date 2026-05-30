/**
 * Decide whether a team run should use ultracode orchestration (ADR-0022
 * addendum). Mirrors Claude Code's effort toggle: an explicit operator override
 * always wins; otherwise the team must have ultracode enabled, and `autoMode`
 * decides — `"always"` orchestrates every run, `"never"` never does, and
 * `"auto"` (the default) only orchestrates when the routing assessment judged
 * the task complex.
 */

import type { AgentTeam } from "@/types/agent/agent-team"

/** Operator override threaded from the workspace run control. */
export type UltracodeOverride = "force" | "off" | undefined

export function isUltracodeActive(
  team: Pick<AgentTeam, "config" | "routingAssessment">,
  override?: UltracodeOverride
): boolean {
  if (override === "force") return true
  if (override === "off") return false

  const uc = team.config.ultracode
  if (!uc?.enabled) return false

  const mode = uc.autoMode ?? "auto"
  if (mode === "never") return false
  if (mode === "always") return true

  // "auto": only for complex tasks, per the routing assessment.
  return team.routingAssessment?.factors.taskComplexity === "complex"
}
