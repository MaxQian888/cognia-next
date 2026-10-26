/**
 * What the run viewer shows, derived from a run and its steps (ADR-0237).
 *
 * Pure: the viewer, the agent's evolution page and the notification copy all
 * read a run through these, so "can this run be resumed" or "how much of the
 * budget is spent" has one answer everywhere.
 */

import type {
  HarnessBudgetLedger,
  HarnessEvolutionBudget,
  HarnessEvolutionRun,
  HarnessEvolutionStep,
  HarnessRunStatus,
  HarnessStepKind,
} from "@/types/harness/evolution"
import { isActiveRunStatus, isTerminalRunStatus } from "./machine"
import { BASE, planRun, statusForStep, type PlannedStep } from "./recursion"

/** The verbs a person may use on a run in its current state. */
export interface RunActions {
  cancel: boolean
  resume: boolean
  approve: boolean
  reject: boolean
  rollback: boolean
}

export function runActions(
  run: Pick<HarnessEvolutionRun, "status" | "owner" | "adoption">,
  now: number,
  activeHere: boolean
): RunActions {
  const stalled =
    isActiveRunStatus(run.status) && !activeHere && (!run.owner || run.owner.leaseExpiresAt <= now)
  return {
    cancel: !isTerminalRunStatus(run.status),
    resume: run.status === "interrupted" || run.status === "queued" || stalled,
    approve: run.status === "awaiting_approval",
    reject: run.status === "awaiting_approval",
    rollback: run.status === "completed" && !!run.adoption && !run.adoption.rolledBackAt,
  }
}

/** The phases of the timeline, in order. */
export type TimelinePhase =
  "reference_running" | "proposing" | "probing" | "composing" | "evaluating" | "reflecting"

export interface TimelineGroup {
  phase: TimelinePhase
  /** Sequential runs repeat phases per round. */
  round?: number
  steps: { planned: PlannedStep; step?: HarnessEvolutionStep }[]
}

/** The plan with whatever steps exist, grouped as the run walks it. */
export function runTimeline(
  run: Pick<HarnessEvolutionRun, "config">,
  steps: readonly HarnessEvolutionStep[]
): TimelineGroup[] {
  const byLabel = new Map(steps.map((s) => [s.label, s]))
  const groups: TimelineGroup[] = []
  for (const planned of planRun(run.config.mode, run.config.k)) {
    const phase = statusForStep(planned)
    const last = groups[groups.length - 1]
    const entry = {
      planned,
      ...(byLabel.has(planned.label) ? { step: byLabel.get(planned.label) } : {}),
    }
    if (last && last.phase === phase && last.round === planned.round) last.steps.push(entry)
    else
      groups.push({
        phase,
        ...(planned.round !== undefined ? { round: planned.round } : {}),
        steps: [entry],
      })
  }
  return groups
}

/** A step label as a person reads it: kind, number and what it rolls. */
export interface StepLabelParts {
  kind: "base" | "invariant" | "domain" | "aggregate" | "compose" | "rollout" | "select" | "reflect"
  index?: number
  /** Rollouts of a stage: the stage label. */
  of?: string
}

export function stepLabelParts(label: string): StepLabelParts {
  if (label === "select") return { kind: "select" }
  if (label === "reflect") return { kind: "reflect" }
  if (label.startsWith("roll:")) return { kind: "rollout", of: label.slice(5) }
  const match = /^(base|inv|dom|agg|c)(\d+)$/.exec(label)
  if (!match) return { kind: "rollout", of: label }
  const kinds = {
    base: "base",
    inv: "invariant",
    dom: "domain",
    agg: "aggregate",
    c: "compose",
  } as const
  return { kind: kinds[match[1] as keyof typeof kinds], index: Number(match[2]) }
}

export interface BudgetMeter {
  dimension: "cost" | "tokens" | "modelCalls" | "wallTime"
  used: number
  limit: number
  /** 0–1, clamped. */
  fraction: number
  /** The cost is a lower bound: some call reported no price. */
  lowerBound?: boolean
}

/** How much of each ceiling the run has used. */
export function budgetMeters(
  ledger: HarnessBudgetLedger,
  budget: HarnessEvolutionBudget,
  timing: { startedAt?: number; endedAt?: number; now: number }
): BudgetMeter[] {
  const meter = (
    dimension: BudgetMeter["dimension"],
    used: number,
    limit: number,
    extra: Partial<BudgetMeter> = {}
  ): BudgetMeter => ({
    dimension,
    used,
    limit,
    fraction: limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0,
    ...extra,
  })
  const elapsed =
    timing.startedAt !== undefined ? (timing.endedAt ?? timing.now) - timing.startedAt : 0
  return [
    meter(
      "cost",
      ledger.costUsd,
      budget.maxCostUsd,
      ledger.costUnknown ? { lowerBound: true } : {}
    ),
    meter("tokens", ledger.inputTokens + ledger.outputTokens, budget.maxTokens),
    meter("modelCalls", ledger.modelCalls, budget.maxModelCalls),
    meter("wallTime", Math.max(0, elapsed), budget.maxWallTimeMs),
  ]
}

/** Labels whose harness a person can open and compare: the base and every editor stage that produced one. */
export function comparableLabels(steps: readonly HarnessEvolutionStep[]): string[] {
  return [
    BASE,
    ...steps
      .filter(
        (s) =>
          (s.kind === "propose" || s.kind === "compose") &&
          s.status === "succeeded" &&
          !!s.snapshotId
      )
      .map((s) => s.label),
  ]
}

/** The rollout evidence of a harness label (the base's first replicate for `base`). */
export function rolloutOf(
  label: string,
  steps: readonly HarnessEvolutionStep[]
): HarnessEvolutionStep | undefined {
  const target = label === BASE ? "base1" : `roll:${label}`
  return steps.find((s) => s.label === target && s.kind === "rollout")
}

const STATUS_TONE: Record<HarnessRunStatus, "neutral" | "working" | "attention" | "good" | "bad"> =
  {
    queued: "neutral",
    snapshotting: "working",
    reference_running: "working",
    proposing: "working",
    probing: "working",
    composing: "working",
    evaluating: "working",
    reflecting: "working",
    adopting: "working",
    awaiting_approval: "attention",
    interrupted: "attention",
    completed: "good",
    rolled_back: "neutral",
    rejected: "neutral",
    failed: "bad",
    cancelled: "bad",
    budget_exceeded: "bad",
  }

/** How a status reads at a glance. */
export function statusTone(status: HarnessRunStatus) {
  return STATUS_TONE[status]
}

/** Spend per step kind, for the ledger breakdown. */
export function spendByKind(
  steps: readonly HarnessEvolutionStep[]
): Partial<
  Record<HarnessStepKind, { costUsd: number; tokens: number; count: number; cached: number }>
> {
  const out: Partial<
    Record<HarnessStepKind, { costUsd: number; tokens: number; count: number; cached: number }>
  > = {}
  for (const s of steps) {
    const row = (out[s.kind] ??= { costUsd: 0, tokens: 0, count: 0, cached: 0 })
    row.costUsd += s.costUsd ?? 0
    row.tokens += s.inputTokens + s.outputTokens
    row.count += 1
    if (s.cacheHitOf) row.cached += 1
  }
  return out
}
