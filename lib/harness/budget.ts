/**
 * Budget control for evolution runs (ADR-0237).
 *
 * The scheduled work of a run is fixed by its mode and k (Harness²'s R = 4k
 * rollouts and P = 3k editor sessions, plus one selection and one reflection),
 * so a run can be priced before it starts and refused if the price is over the
 * budget. While it runs, every step's spend is added to the ledger, and before
 * each step the controller reserves the worst cost observed so far for that
 * kind of step: a run stops one step early rather than one step late.
 *
 * When a step reports no price (a provider without pricing), the ledger marks
 * its cost as a lower bound and the token and call ceilings are what hold.
 */

import type {
  HarnessBudgetLedger,
  HarnessEvolutionBudget,
  HarnessEvolutionMode,
  HarnessStepKind,
} from "@/types/harness/evolution"

export const K_MIN = 1
export const K_MAX = 4

export const DEFAULT_HARNESS_BUDGET: HarnessEvolutionBudget = {
  maxIterations: 2,
  maxCandidates: 4,
  maxParallelRuns: 2,
  maxModelCalls: 40,
  maxTokens: 4_000_000,
  maxCostUsd: 5,
  maxWallTimeMs: 2 * 60 * 60 * 1000,
  maxTurnsPerRollout: 40,
}

/** Allowed range of each budget field; settings inputs clamp to the same. */
export const BUDGET_LIMITS: Readonly<
  Record<keyof HarnessEvolutionBudget, readonly [number, number]>
> = {
  maxIterations: [1, K_MAX],
  maxCandidates: [2, 2 * K_MAX],
  maxParallelRuns: [1, 8],
  maxModelCalls: [4, 400],
  maxTokens: [50_000, 100_000_000],
  maxCostUsd: [0.05, 500],
  maxWallTimeMs: [60_000, 24 * 60 * 60 * 1000],
  maxTurnsPerRollout: [1, 200],
}

/** Clamp every field into its allowed range; missing or invalid fields take the default. */
export function normalizeBudget(
  input: Partial<HarnessEvolutionBudget> | undefined
): HarnessEvolutionBudget {
  const out = { ...DEFAULT_HARNESS_BUDGET }
  for (const key of Object.keys(BUDGET_LIMITS) as (keyof HarnessEvolutionBudget)[]) {
    const value = input?.[key]
    if (typeof value !== "number" || !Number.isFinite(value)) continue
    const [min, max] = BUDGET_LIMITS[key]
    const clamped = Math.min(max, Math.max(min, value))
    out[key] = key === "maxCostUsd" ? clamped : Math.round(clamped)
  }
  return out
}

/** The k a run may use under its budget: at most maxIterations, and 2k ≤ maxCandidates. */
export function effectiveK(requested: number, budget: HarnessEvolutionBudget): number {
  const k = Math.round(Number.isFinite(requested) ? requested : K_MIN)
  return Math.max(
    K_MIN,
    Math.min(k, K_MAX, budget.maxIterations, Math.floor(budget.maxCandidates / 2))
  )
}

export interface ScheduledWork {
  /** base k + candidates 2k + finals k. */
  rollouts: number
  /** Propose 2k + compose k. */
  editorSessions: number
  /** Selection + reflection. */
  judgeCalls: number
  candidates: number
}

/** The work a run of this shape schedules, before any reuse or early stop. */
export function scheduledWork(mode: HarnessEvolutionMode, k: number): ScheduledWork {
  // Parallel and sequential schedule the same counts; they differ in what each
  // session sees (iid vs. carried history), not in how many there are.
  void mode
  return { rollouts: 4 * k, editorSessions: 3 * k, judgeCalls: 2, candidates: 2 * k }
}

export interface UnitCostEstimate {
  /** Cost of one rollout of the base harness on the task. */
  rolloutUsd?: number
  rolloutTokens?: number
  /** Cost of one editor session. */
  sessionUsd?: number
  sessionTokens?: number
  /** Wall time of one rollout. */
  rolloutMs?: number
}

export interface RunEstimate {
  work: ScheduledWork
  costUsd?: number
  tokens?: number
  modelCalls: number
  /** With maxParallelRuns rollouts at a time. */
  wallTimeMs?: number
  /** Budget dimensions the estimate already exceeds. */
  exceeds: (keyof HarnessEvolutionBudget)[]
}

/**
 * A pre-run estimate. Unit figures come from the agent's recent turns (ADR-0232)
 * or, failing that, are absent, in which case only call counts are checked.
 */
export function estimateRun(
  mode: HarnessEvolutionMode,
  k: number,
  budget: HarnessEvolutionBudget,
  unit: UnitCostEstimate
): RunEstimate {
  const work = scheduledWork(mode, k)
  const modelCalls = work.editorSessions + work.judgeCalls
  const costUsd =
    unit.rolloutUsd !== undefined && unit.sessionUsd !== undefined
      ? work.rollouts * unit.rolloutUsd + (work.editorSessions + work.judgeCalls) * unit.sessionUsd
      : undefined
  const tokens =
    unit.rolloutTokens !== undefined && unit.sessionTokens !== undefined
      ? work.rollouts * unit.rolloutTokens +
        (work.editorSessions + work.judgeCalls) * unit.sessionTokens
      : undefined
  // Rollouts of one stage run side by side; stages run one after another.
  // Parallel: base, candidates, finals = 3 waves. Sequential: base + 1 per round.
  const waves =
    mode === "parallel"
      ? Math.ceil(k / budget.maxParallelRuns) +
        Math.ceil((2 * k) / budget.maxParallelRuns) +
        Math.ceil(k / budget.maxParallelRuns)
      : Math.ceil(k / budget.maxParallelRuns) + 3 * k
  const wallTimeMs = unit.rolloutMs !== undefined ? waves * unit.rolloutMs : undefined
  const exceeds: (keyof HarnessEvolutionBudget)[] = []
  if (modelCalls > budget.maxModelCalls) exceeds.push("maxModelCalls")
  if (costUsd !== undefined && costUsd > budget.maxCostUsd) exceeds.push("maxCostUsd")
  if (tokens !== undefined && tokens > budget.maxTokens) exceeds.push("maxTokens")
  if (wallTimeMs !== undefined && wallTimeMs > budget.maxWallTimeMs) exceeds.push("maxWallTimeMs")
  return {
    work,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    modelCalls,
    ...(wallTimeMs !== undefined ? { wallTimeMs } : {}),
    exceeds,
  }
}

export function emptyLedger(startedAt?: number): HarnessBudgetLedger {
  return {
    costUsd: 0,
    costUnknown: false,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    rollouts: 0,
    sessions: 0,
    maxObservedCostUsd: {},
    ...(startedAt !== undefined ? { startedAt } : {}),
  }
}

export interface StepSpend {
  costUsd?: number
  inputTokens: number
  outputTokens: number
  modelCalls: number
}

/** The ledger after one step's spend. Pure. */
export function addSpend(
  ledger: HarnessBudgetLedger,
  kind: HarnessStepKind,
  spend: StepSpend
): HarnessBudgetLedger {
  const priced = typeof spend.costUsd === "number" && Number.isFinite(spend.costUsd)
  const cost = priced ? (spend.costUsd as number) : 0
  return {
    ...ledger,
    costUsd: ledger.costUsd + cost,
    costUnknown: ledger.costUnknown || !priced,
    inputTokens: ledger.inputTokens + spend.inputTokens,
    outputTokens: ledger.outputTokens + spend.outputTokens,
    // Rollouts are bounded by their turn ceiling, not by the call budget, which
    // counts editor, selector and reflector sessions.
    modelCalls: ledger.modelCalls + (kind === "rollout" ? 0 : spend.modelCalls),
    rollouts: ledger.rollouts + (kind === "rollout" ? 1 : 0),
    sessions: ledger.sessions + (kind === "rollout" ? 0 : 1),
    maxObservedCostUsd: {
      ...ledger.maxObservedCostUsd,
      ...(priced ? { [kind]: Math.max(ledger.maxObservedCostUsd[kind] ?? 0, cost) } : {}),
    },
  }
}

export type BudgetVerdict =
  { ok: true } | { ok: false; dimension: keyof HarnessEvolutionBudget; detail: string }

/** Has the run already spent past a ceiling? */
export function checkBudget(
  ledger: HarnessBudgetLedger,
  budget: HarnessEvolutionBudget,
  now: number
): BudgetVerdict {
  if (ledger.costUsd > budget.maxCostUsd) {
    return { ok: false, dimension: "maxCostUsd", detail: `spent $${ledger.costUsd.toFixed(2)}` }
  }
  const tokens = ledger.inputTokens + ledger.outputTokens
  if (tokens > budget.maxTokens) {
    return { ok: false, dimension: "maxTokens", detail: `used ${tokens} tokens` }
  }
  if (ledger.modelCalls > budget.maxModelCalls) {
    return {
      ok: false,
      dimension: "maxModelCalls",
      detail: `made ${ledger.modelCalls} model calls`,
    }
  }
  if (ledger.startedAt !== undefined && now - ledger.startedAt > budget.maxWallTimeMs) {
    return { ok: false, dimension: "maxWallTimeMs", detail: "ran past its wall-time limit" }
  }
  return { ok: true }
}

export interface Reservation {
  costUsd?: number
  tokens?: number
  modelCalls: number
}

/**
 * Can the run afford one more step of `kind`? The reserve is the worst cost seen
 * for that kind so far (or the caller's estimate for a first step); a step is
 * refused when spent + reserve would cross a ceiling.
 */
export function canAfford(
  ledger: HarnessBudgetLedger,
  budget: HarnessEvolutionBudget,
  kind: HarnessStepKind,
  now: number,
  estimate: Reservation
): BudgetVerdict {
  const already = checkBudget(ledger, budget, now)
  if (!already.ok) return already
  const reserveCost = ledger.maxObservedCostUsd[kind] ?? estimate.costUsd ?? 0
  if (ledger.costUsd + reserveCost > budget.maxCostUsd) {
    return {
      ok: false,
      dimension: "maxCostUsd",
      detail: `another ${kind} (~$${reserveCost.toFixed(2)}) would pass the $${budget.maxCostUsd} limit`,
    }
  }
  const tokens = ledger.inputTokens + ledger.outputTokens
  if (estimate.tokens !== undefined && tokens + estimate.tokens > budget.maxTokens) {
    return {
      ok: false,
      dimension: "maxTokens",
      detail: `another ${kind} would pass the token limit`,
    }
  }
  if (ledger.modelCalls + estimate.modelCalls > budget.maxModelCalls) {
    return {
      ok: false,
      dimension: "maxModelCalls",
      detail: `another ${kind} would pass the model-call limit`,
    }
  }
  return { ok: true }
}
