/**
 * The shape of a run: which steps exist, in which order, with which inputs
 * (ADR-0237).
 *
 * Both recursion styles schedule the same work for a given k — Harness²'s
 * identity R = 4k rollouts and P = 3k editor sessions — and differ in what each
 * session sees:
 *
 * parallel   base1..k → inv1..k, dom1..k (independent, all from the base)
 *            → rollouts of all 2k → agg1..k (each composes the whole pool)
 *            → rollouts of agg1..k → select among agg1..k and the base
 *
 * sequential base1..k → for t = 1..k: inv_t, dom_t (from the current harness,
 *            seeing every earlier round) → their rollouts → c_t composes
 *            {inv_t, dom_t} → its rollout; c_t becomes the current harness
 *            → select among c1..k and the base
 *
 * Step labels are stable and unique within a run, so a resumed run finds the
 * steps it already finished by label and skips them.
 */

import type {
  HarnessEvolutionMode,
  HarnessStageDimension,
  HarnessStepKind,
} from "@/types/harness/evolution"

export interface PlannedStep {
  label: string
  kind: HarnessStepKind
  dim?: HarnessStageDimension
  round?: number
  /** For a rollout: the label of the stage whose harness it rolls (`base` for base rollouts). */
  rolls?: string
  /** For a rollout: the 1-based replicate number among the rollouts of the same harness. */
  replicate?: number
  /** For an editor stage: labels of the stages whose harnesses form its pool (composer only). */
  pool?: string[]
  /** For an editor stage: the label whose harness it edits (`base` or an earlier stage). */
  input?: string
}

export const BASE = "base"

export function rolloutLabel(rolls: string, replicate = 1): string {
  return rolls === BASE ? `base${replicate}` : `roll:${rolls}`
}

export function finalLabels(mode: HarnessEvolutionMode, k: number): string[] {
  return Array.from({ length: k }, (_, i) => (mode === "parallel" ? `agg${i + 1}` : `c${i + 1}`))
}

/** Every step of a run, in execution order. */
export function planRun(mode: HarnessEvolutionMode, k: number): PlannedStep[] {
  const steps: PlannedStep[] = []
  for (let r = 1; r <= k; r++) {
    steps.push({ label: rolloutLabel(BASE, r), kind: "rollout", rolls: BASE, replicate: r })
  }
  if (mode === "parallel") {
    const proposals: string[] = []
    for (let i = 1; i <= k; i++) {
      for (const dim of ["INV", "DOM"] as const) {
        const label = `${dim.toLowerCase()}${i}`
        proposals.push(label)
        steps.push({ label, kind: "propose", dim, input: BASE })
      }
    }
    for (const p of proposals) steps.push({ label: rolloutLabel(p), kind: "rollout", rolls: p })
    for (let i = 1; i <= k; i++) {
      steps.push({ label: `agg${i}`, kind: "compose", dim: "AGG", input: BASE, pool: proposals })
    }
    for (let i = 1; i <= k; i++) {
      steps.push({ label: rolloutLabel(`agg${i}`), kind: "rollout", rolls: `agg${i}` })
    }
  } else {
    let current = BASE
    for (let t = 1; t <= k; t++) {
      const inv = `inv${t}`
      const dom = `dom${t}`
      steps.push({ label: inv, kind: "propose", dim: "INV", round: t, input: current })
      steps.push({ label: dom, kind: "propose", dim: "DOM", round: t, input: current })
      steps.push({ label: rolloutLabel(inv), kind: "rollout", rolls: inv, round: t })
      steps.push({ label: rolloutLabel(dom), kind: "rollout", rolls: dom, round: t })
      const c = `c${t}`
      steps.push({
        label: c,
        kind: "compose",
        dim: "COMPOSE",
        round: t,
        input: current,
        pool: [inv, dom],
      })
      steps.push({ label: rolloutLabel(c), kind: "rollout", rolls: c, round: t })
      current = c
    }
  }
  steps.push({ label: "select", kind: "select" })
  steps.push({ label: "reflect", kind: "reflect" })
  return steps
}

/** Counts of the planned work, for the scheduled-work identity and estimates. */
export function plannedWork(steps: readonly PlannedStep[]): {
  rollouts: number
  editorSessions: number
  judgeCalls: number
} {
  return {
    rollouts: steps.filter((s) => s.kind === "rollout").length,
    editorSessions: steps.filter((s) => s.kind === "propose" || s.kind === "compose").length,
    judgeCalls: steps.filter((s) => s.kind === "select" || s.kind === "reflect").length,
  }
}

/** The run status a step belongs to, for the state machine. */
export function statusForStep(
  step: PlannedStep
): "reference_running" | "proposing" | "probing" | "composing" | "evaluating" | "reflecting" {
  switch (step.kind) {
    case "rollout":
      return step.rolls === BASE ? "reference_running" : "probing"
    case "propose":
      return "proposing"
    case "compose":
      return "composing"
    case "select":
      return "evaluating"
    case "reflect":
      return "reflecting"
  }
}

/**
 * Labels of the rollouts an editor stage is shown. Parallel editors see the
 * base rollouts; sequential editors see every rollout finished before them, so
 * round t learns from rounds 1..t-1. A composer additionally sees its pool's
 * rollouts through the pool entries.
 */
export function evidenceLabelsFor(step: PlannedStep, steps: readonly PlannedStep[]): string[] {
  const index = steps.findIndex((s) => s.label === step.label)
  const before = steps.slice(0, Math.max(index, 0))
  if (step.round === undefined) {
    return before.filter((s) => s.kind === "rollout" && s.rolls === BASE).map((s) => s.label)
  }
  return before
    .filter((s) => s.kind === "rollout" && !(step.pool ?? []).includes(s.rolls ?? ""))
    .map((s) => s.label)
}

/** Labels of the editor stages whose notes a sequential stage reads as history. */
export function decisionLabelsFor(step: PlannedStep, steps: readonly PlannedStep[]): string[] {
  if (step.round === undefined || step.round <= 1) return []
  return steps
    .filter(
      (s) =>
        (s.kind === "propose" || s.kind === "compose") && (s.round ?? 0) < (step.round as number)
    )
    .map((s) => s.label)
}
