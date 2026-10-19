/**
 * Ultracode lead planning (ADR-0022 addendum). Before an ultracode run fans
 * out, a planner teammate decides WHICH quality patterns to compose for the
 * task and how wide to fan each one — the "decide to orchestrate" brain that
 * mirrors Claude Code's effort-driven workflow authoring. The plan is validated
 * structured output (`ultracodePlanSchema`) and then handed to
 * `synthesizeUltracodeWorkflow`. The planner wording is editable in the Prompt
 * Center; the plan schema hint is inspect-only (both in `../team-prompts`).
 */

import { ultracodePlanSchema, type UltracodePlan } from "@/types/agent/ultracode"
import { dispatchStructured } from "../teammate/structured-dispatch"
import type { TeamRunContext } from "../team-run-context"
import { resolvePrompt, resolvePromptAsync } from "@/lib/prompts/resolve"
import {
  teamPromptContext,
  ULTRACODE_PLAN_HINT_PROMPT,
  ULTRACODE_PLANNER_PROMPT,
} from "../team-prompts"

export interface PlanUltracodeOptions {
  signal?: AbortSignal
}

/** Produce a validated ultracode plan for the team's objective. */
export async function planUltracodeWorkflow(
  teamCtx: TeamRunContext,
  opts: PlanUltracodeOptions = {}
): Promise<UltracodePlan> {
  const objective =
    teamCtx.team.task?.trim() || teamCtx.team.description?.trim() || teamCtx.team.name
  const uc = teamCtx.team.config.ultracode ?? {}
  const knobs = [
    uc.skepticsPerFinding ? `default skeptics per finding: ${uc.skepticsPerFinding}` : null,
    uc.judgesPerAttempt ? `default judges per attempt: ${uc.judgesPerAttempt}` : null,
    uc.maxFinderRounds ? `max finder rounds: ${uc.maxFinderRounds}` : null,
  ]
    .filter(Boolean)
    .join("; ")

  // Resolved once for this planning step (ADR-0236).
  const prompt = (
    await resolvePromptAsync(ULTRACODE_PLANNER_PROMPT, {
      context: teamPromptContext(teamCtx.team),
      values: { objective, knobs: knobs ? `\n\nTeam knobs — ${knobs}.` : "" },
    })
  ).text
  opts.signal?.throwIfAborted()

  const { value } = await dispatchStructured(
    teamCtx,
    {
      taskId: "ultracode-plan",
      prompt,
      signal: opts.signal,
      // Planning is pure reasoning — no repo tools needed.
      preferToolEnabled: false,
    },
    ultracodePlanSchema,
    { schemaHint: resolvePrompt(ULTRACODE_PLAN_HINT_PROMPT).text }
  )
  return value
}
