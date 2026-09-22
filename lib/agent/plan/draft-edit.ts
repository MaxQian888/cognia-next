"use client"

/**
 * Shared persistence for plan edits — one code path so the approval dock and
 * the dock's plan panel cannot drift apart on how an `AgentPlan` draft is
 * updated.
 *
 * `planText` edits re-derive the executable `steps[]` projection from the
 * rewritten markdown (the doc stays the single source of truth, ADR-0045).
 * `stepTitles` edits rebuild the linear chain directly for plans that were
 * never captured as markdown. Either way the draft is marked `userEdited` so
 * approval embeds the adjusted plan in the resume prompt instead of the
 * transcript's original wording.
 */

import type { AgentPlan, PlanEditPatch } from "@/types/agent/plan"
import { projectStepTitles } from "./plan-doc"
import { linearAgentTurnSteps, materializeSteps } from "./steps"
import { getPlanRuntime } from "./runtime"

/** Wrap plain titles as a linear `agent_turn` chain — a draft carries no
 *  execution shape yet, so every step starts out sequential and pending. */
export function linearSteps(titles: string[]): AgentPlan["steps"] {
  return materializeSteps(linearAgentTurnSteps(titles))
}

export async function applyPlanEditPatch(plan: AgentPlan, patch: PlanEditPatch): Promise<void> {
  const title = patch.title.trim().slice(0, 120) || plan.title
  // planText patches re-derive steps via `projectStepTitles` — list items
  // only, no prose fallback — so a doc edited down to zero lists projects
  // zero steps instead of a phantom step named after its first line.
  const titles = "planText" in patch ? projectStepTitles(patch.planText) : patch.stepTitles
  if (!titles.length) return
  // Rebuilding materializes fresh `agent_turn` rows — new ids, no kind or
  // params. Only do it when the step titles actually changed; a title-only
  // edit must not flatten an `agent_tool` plan's typed steps (and would break
  // step ids that `agentPlanEvents` payloads reference).
  const currentTitles = [...plan.steps].sort((a, b) => a.order - b.order).map((s) => s.title)
  const nextTitles = titles.map((t) => t.trim())
  const titlesChanged =
    nextTitles.length !== currentTitles.length || nextTitles.some((t, i) => t !== currentTitles[i])
  await getPlanRuntime().updatePlanDraft(plan.id, {
    title,
    ...(titlesChanged ? { steps: linearSteps(nextTitles) } : {}),
    metadata: {
      ...plan.metadata,
      userEdited: true,
      ...("planText" in patch ? { planText: patch.planText } : {}),
    },
  })
}
