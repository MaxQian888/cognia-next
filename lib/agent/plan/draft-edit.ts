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

import type { AgentPlan, CreatePlanStepInput, PlanEditPatch, PlanStep } from "@/types/agent/plan"
import { projectStepTitles, rebuildPlanText } from "./plan-doc"
import { linearAgentTurnSteps, materializeSteps } from "./steps"
import { validatePlanStepParams } from "./step-params"
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

/** Thrown when an edit from the plan editor does not describe a runnable plan. */
export class PlanEditValidationError extends Error {
  constructor(
    readonly reason: "empty" | "invalid_step",
    /** 1-based step index for `invalid_step`. */
    readonly stepIndex?: number
  ) {
    super(
      reason === "empty"
        ? "a plan needs at least one step"
        : `step ${stepIndex} has parameters its kind cannot run with`
    )
    this.name = "PlanEditValidationError"
  }
}

/** One edited step: what the "Write a plan" editor produces per line. */
export type PlanComposerStepEdit = Pick<CreatePlanStepInput, "title" | "kind" | "params">

function sameParams(a: PlanStep["params"], b: PlanStep["params"]): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Amend a not-yet-approved plan from the "Write a plan" editor (title + one
 * step per line + optional step types) — the approval card's Edit action.
 *
 * Re-validates before writing: every step's params go back through the shared
 * `validatePlanStepParams` (the same gate the composer and the agent tools
 * use), so a plan that reaches approval is one the executor can run.
 *
 * Keeps what can be kept. When the step COUNT is unchanged the edit is applied
 * position by position onto the existing rows — ids, dependencies (a DAG the
 * agent authored stays a DAG) and the trail's step references survive a
 * rename or a kind change. A different count re-derives a fresh linear chain,
 * which is the only shape a list of lines can describe. A captured markdown
 * body (`metadata.planText`) has its steps section rewritten to match, so the
 * document and the executable steps cannot disagree, and `userEdited` makes
 * approval embed the amended plan rather than the transcript's original.
 */
export async function applyPlanComposerEdit(
  plan: AgentPlan,
  edit: { title: string; steps: PlanComposerStepEdit[] }
): Promise<AgentPlan | null> {
  if (edit.steps.length === 0) throw new PlanEditValidationError("empty")
  edit.steps.forEach((step, i) => {
    if (step.params && "error" in validatePlanStepParams(step.kind, step.params)) {
      throw new PlanEditValidationError("invalid_step", i + 1)
    }
  })

  const title = edit.title.trim().slice(0, 120) || plan.title
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order)
  const inputs: CreatePlanStepInput[] = linearAgentTurnSteps(edit.steps.map((s) => s.title)).map(
    (base, i) => ({
      ...base,
      kind: edit.steps[i].kind,
      ...(edit.steps[i].params ? { params: edit.steps[i].params } : {}),
    })
  )
  const steps: PlanStep[] =
    inputs.length === ordered.length
      ? ordered.map((row, i) => {
          const next = inputs[i]
          const { params: _dropped, ...rest } = row
          void _dropped
          return {
            ...rest,
            title: next.title,
            kind: next.kind,
            ...(next.params ? { params: next.params } : {}),
          }
        })
      : materializeSteps(inputs)
  const stepsChanged =
    steps.length !== ordered.length ||
    steps.some(
      (step, i) =>
        step.title !== ordered[i].title ||
        step.kind !== ordered[i].kind ||
        !sameParams(step.params, ordered[i].params)
    )

  const meta = plan.metadata as { planText?: unknown } | undefined
  const planText = typeof meta?.planText === "string" ? meta.planText : ""
  const titles = steps.map((step) => step.title)
  const titlesChanged =
    titles.some((t, i) => t !== ordered[i]?.title) || titles.length !== ordered.length
  return getPlanRuntime().updatePlanDraft(plan.id, {
    title,
    ...(stepsChanged ? { steps } : {}),
    metadata: {
      ...plan.metadata,
      userEdited: true,
      ...(planText && titlesChanged ? { planText: rebuildPlanText(planText, titles) } : {}),
    },
  })
}
