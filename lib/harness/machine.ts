/**
 * The run state machine (ADR-0237).
 *
 *   queued → snapshotting → reference_running → proposing ⇄ probing ⇄ composing
 *          → evaluating → reflecting → awaiting_approval → adopting → completed
 *
 * Sequential runs loop proposing → probing → composing once per round.
 * Reflection runs right after the decision, before the run waits on a person,
 * so every model call is spent while the run is still active and an approval
 * that takes days holds no work. A keep-base decision ends after reflecting; a
 * low-risk decision the settings allow to auto-adopt skips awaiting_approval.
 * A reflection that fails does not fail the run. Every
 * non-terminal status can fail, be cancelled, exceed its budget or be
 * interrupted (the app quit holding its lease); an interrupted run resumes into
 * the phase its steps say it reached. A completed run that adopted a harness can
 * be rolled back.
 *
 * Every transition goes through {@link transitionRun}, which bumps `version` so
 * the store's compare-and-swap write rejects a concurrent writer.
 */

import type { HarnessEvolutionRun, HarnessRunStatus } from "@/types/harness/evolution"
import { canonicalHash } from "./snapshot"

export const TERMINAL_RUN_STATUSES: ReadonlySet<HarnessRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
  "rejected",
  "rolled_back",
])

/** Statuses in which a driver is doing work and must hold the run's lease. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<HarnessRunStatus> = new Set([
  "snapshotting",
  "reference_running",
  "proposing",
  "probing",
  "composing",
  "evaluating",
  "adopting",
  "reflecting",
])

const WORK_PHASES: readonly HarnessRunStatus[] = [
  "snapshotting",
  "reference_running",
  "proposing",
  "probing",
  "composing",
  "evaluating",
  "adopting",
  "reflecting",
]

const ABORTS: readonly HarnessRunStatus[] = [
  "failed",
  "cancelled",
  "budget_exceeded",
  "interrupted",
]

const TRANSITIONS: Record<HarnessRunStatus, readonly HarnessRunStatus[]> = {
  queued: ["snapshotting", "cancelled", "failed"],
  snapshotting: ["reference_running", ...ABORTS],
  reference_running: ["proposing", ...ABORTS],
  proposing: ["probing", "composing", ...ABORTS],
  probing: ["proposing", "composing", "evaluating", ...ABORTS],
  composing: ["probing", "proposing", "evaluating", ...ABORTS],
  evaluating: ["reflecting", ...ABORTS],
  reflecting: ["awaiting_approval", "adopting", "completed", ...ABORTS],
  awaiting_approval: ["adopting", "rejected", "cancelled", "failed"],
  adopting: ["completed", ...ABORTS],
  interrupted: [...WORK_PHASES, "awaiting_approval", "failed", "cancelled", "budget_exceeded"],
  completed: ["rolled_back"],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
  rejected: [],
  rolled_back: [],
}

export function isTerminalRunStatus(status: HarnessRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export function isActiveRunStatus(status: HarnessRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status)
}

export function allowedTransitions(from: HarnessRunStatus): readonly HarnessRunStatus[] {
  return TRANSITIONS[from]
}

export function canTransition(from: HarnessRunStatus, to: HarnessRunStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export class HarnessRunTransitionError extends Error {
  constructor(
    readonly from: HarnessRunStatus,
    readonly to: HarnessRunStatus
  ) {
    super(`harness run cannot go from ${from} to ${to}`)
    this.name = "HarnessRunTransitionError"
  }
}

export type HarnessRunPatch = Partial<
  Pick<
    HarnessEvolutionRun,
    | "round"
    | "baseSnapshotId"
    | "finalLabels"
    | "decision"
    | "adoption"
    | "experienceIds"
    | "retrievedExperienceIds"
    | "stopReason"
    | "ledger"
    | "error"
    | "owner"
  >
>

/**
 * The run after moving to `to`. Throws on an illegal move. `startedAt` is set
 * the first time the run leaves `queued`; `endedAt` when it reaches a terminal
 * status (and is cleared again by a rollback, which is a new end).
 */
export function transitionRun(
  run: HarnessEvolutionRun,
  to: HarnessRunStatus,
  patch: HarnessRunPatch,
  now: number
): HarnessEvolutionRun {
  if (!canTransition(run.status, to)) throw new HarnessRunTransitionError(run.status, to)
  const next: HarnessEvolutionRun = {
    ...run,
    ...patch,
    status: to,
    version: run.version + 1,
    updatedAt: now,
  }
  if (run.status === "queued" && next.startedAt === undefined) next.startedAt = now
  if (isTerminalRunStatus(to)) {
    next.endedAt = now
    delete next.owner
  }
  return next
}

/** A run whose driver died: non-terminal, not waiting on a person, and its lease lapsed. */
export function isOrphaned(run: HarnessEvolutionRun, now: number): boolean {
  if (!isActiveRunStatus(run.status)) return false
  return !run.owner || run.owner.leaseExpiresAt <= now
}

/**
 * Identity of "the same run": one agent, one task, one base harness and one run
 * configuration. While a run with this key is not finished, starting another
 * returns it instead (a double click, a repeated failure offer, a background
 * sweep racing a manual start).
 */
export async function runDedupeKey(input: {
  characterId: string
  taskInputHash: string
  baseContentHash: string
  config: HarnessEvolutionRun["config"]
}): Promise<string> {
  const hash = await canonicalHash({
    characterId: input.characterId,
    task: input.taskInputHash,
    base: input.baseContentHash,
    config: {
      mode: input.config.mode,
      k: input.config.k,
      scope: input.config.scope,
      editable: [...input.config.editable].sort(),
      models: input.config.models,
      seed: input.config.seed,
    },
  })
  return `hrd1-${hash.slice(0, 40)}`
}
