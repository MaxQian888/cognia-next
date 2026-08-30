/**
 * The explicit history backfill, as a state machine and an estimate.
 *
 * A backfill walks every conversation in a workspace and mines it. That costs
 * real money on the user's own key or subscription, so the run does not start
 * when it is created. It starts in `preconsent`, holding an estimate, and only
 * a person can move it forward.
 *
 * ## The run does the bookkeeping, the existing worker does the work
 *
 * A cursor step enqueues ordinary `project-mining` jobs and then waits for them
 * to reach a terminal state before advancing. There is no second miner, no
 * second lease protocol, and no second retry policy. That is what keeps a
 * backfilled claim identical to a live-mined one.
 *
 * ## The watermark advances on "checked", never on "produced"
 *
 * A batch of sessions that yields no claims still moves the cursor. Advancing
 * only on success would make an unproductive stretch of history an infinite
 * loop, and the whole point of the watermark is that the run can be resumed.
 */

import type {
  ProjectMiningRun,
  ProjectMiningRunEstimateRow,
  ProjectMiningRunStatus,
} from "../types/governance"

/**
 * Legal transitions, as data.
 *
 * `paused` returns to `queued` rather than straight to `running`: resuming has
 * to re-acquire the lease, and a status that says "running" without an owner is
 * exactly the lie the lease exists to prevent.
 */
export const PROJECT_MINING_RUN_TRANSITIONS: Readonly<
  Record<ProjectMiningRunStatus, readonly ProjectMiningRunStatus[]>
> = {
  preconsent: ["queued", "cancelled"],
  queued: ["running", "paused", "cancelled"],
  running: ["paused", "succeeded", "failed", "cancelled"],
  paused: ["queued", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export const TERMINAL_PROJECT_MINING_RUN_STATUSES: readonly ProjectMiningRunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
]

export function isTerminalProjectMiningRun(status: ProjectMiningRunStatus): boolean {
  return TERMINAL_PROJECT_MINING_RUN_STATUSES.includes(status)
}

export function canTransitionProjectMiningRun(
  from: ProjectMiningRunStatus,
  to: ProjectMiningRunStatus
): boolean {
  return PROJECT_MINING_RUN_TRANSITIONS[from].includes(to)
}

/** How long a run may hold its lease before another tab may take it over. */
export const PROJECT_MINING_RUN_LEASE_TTL_MS = 10 * 60 * 1000

/**
 * Can `workerId` take this run's lease right now?
 *
 * Same three cases `claimMemoryJob` allows, restated for a run: nobody holds
 * it, this worker already holds it, or the holder's lease has expired. A tab
 * that is closed mid-backfill must not park the run forever.
 */
export function canClaimProjectMiningRun(
  run: Pick<ProjectMiningRun, "leaseOwner" | "leaseExpiresAt">,
  workerId: string,
  now: number
): boolean {
  if (!run.leaseOwner) return true
  if (run.leaseOwner === workerId) return true
  return (run.leaseExpiresAt ?? 0) <= now
}

/** Rough per-message input token cost, used only for the preconsent estimate. */
export const ESTIMATED_TOKENS_PER_MESSAGE = 220

/** Messages a mining window holds on average, at the shipped 6k-token budget. */
export const ESTIMATED_MESSAGES_PER_WINDOW = 12

/**
 * Turn two counts into the numbers a consent dialog can show.
 *
 * Deliberately derived from counts alone. Reading message BODIES to measure
 * them would mean loading every `parts` array in the workspace's history, which
 * is the read the estimate exists to let the user avoid paying for twice.
 *
 * The result is an upper bound in one direction and a lower bound in the other,
 * and the caller should say so: salience will reject some windows before they
 * ever reach a model, while a conversation full of long tool outputs will
 * exceed the per-message average.
 */
export function estimateProjectMiningRun(counts: {
  sessions: number
  messages: number
}): ProjectMiningRunEstimateRow {
  const sessions = Math.max(0, Math.floor(counts.sessions))
  const messages = Math.max(0, Math.floor(counts.messages))
  // At least one window per non-empty session: a two-message conversation is
  // still one model call, and dividing by the average would round it to zero.
  const windows =
    messages === 0 ? 0 : Math.max(sessions, Math.ceil(messages / ESTIMATED_MESSAGES_PER_WINDOW))
  return {
    sessions,
    messages,
    windows,
    estimatedInputTokens: messages * ESTIMATED_TOKENS_PER_MESSAGE,
  }
}

/**
 * Progress as a 0..1 fraction, or null when there is nothing to divide by.
 *
 * Null rather than 0: an empty workspace is not "0% done", and a progress bar
 * pinned at zero reads as stuck.
 */
export function projectMiningRunProgress(
  run: Pick<ProjectMiningRun, "sessionsScanned" | "estimate">
): number | null {
  const total = run.estimate.sessions
  if (total <= 0) return null
  return Math.min(1, run.sessionsScanned / total)
}
