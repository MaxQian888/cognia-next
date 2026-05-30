/**
 * Ultracode lead planning (ADR-0022 addendum). Before an ultracode run fans
 * out, a planner teammate decides WHICH quality patterns to compose for the
 * task and how wide to fan each one — the "decide to orchestrate" brain that
 * mirrors Claude Code's effort-driven workflow authoring. The plan is validated
 * structured output (`ultracodePlanSchema`) and then handed to
 * `synthesizeUltracodeWorkflow`.
 */

import { ultracodePlanSchema, type UltracodePlan } from "@/types/agent/ultracode"
import { dispatchStructured } from "./structured-dispatch"
import type { TeamRunContext } from "./team-run-context"

const PLAN_HINT =
  '{ "summary": "…", "stages": [{ "pattern": "multi-modal-sweep|loop-until-dry|adversarial-verify|judge-panel|completeness-critic|synthesize", "instruction": "…", "count"?: 1-16, "variants"?: ["…"] }] }'

const PLANNER_GUIDANCE = `You are the lead planner for an ultracode multi-agent run. Design the most effective composition of quality patterns for the objective.

Available patterns (compose in a sensible order; the run is a forward pipeline):
- multi-modal-sweep: parallel finders, each a DIFFERENT search angle. \`variants\` = the distinct angles.
- loop-until-dry: keep finding until rounds go dry. \`instruction\` = what to find. \`count\` = finders per round.
- adversarial-verify: N skeptics REFUTE each finding; majority-refute kills it. \`count\` = skeptics; \`variants\` = lenses (correctness/security/perf/repro) for perspective-diverse verification.
- judge-panel: produce attempts from different angles and score them. \`variants\` = angles; \`count\` = judges per attempt.
- completeness-critic: ask "what's missing?" so gaps feed forward.
- synthesize: fold survivors + winner + gaps into the final cited report. ALWAYS end with this.

Guidance: for audit / bug-hunt / research tasks, use a finder (sweep or loop) → adversarial-verify → completeness-critic → synthesize. For design / solution tasks, use judge-panel → synthesize. Keep counts proportional to task importance; do not exceed 16.`

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

  const { value } = await dispatchStructured(
    teamCtx,
    {
      taskId: "ultracode-plan",
      prompt: `${PLANNER_GUIDANCE}\n\nObjective:\n${objective}${knobs ? `\n\nTeam knobs — ${knobs}.` : ""}`,
      signal: opts.signal,
      // Planning is pure reasoning — no repo tools needed.
      preferToolEnabled: false,
    },
    ultracodePlanSchema,
    { schemaHint: PLAN_HINT }
  )
  return value
}
