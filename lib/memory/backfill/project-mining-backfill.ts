/**
 * Explicit history backfill for project-context mining.
 *
 * Live mining only sees conversations that happen after it was switched on. A
 * workspace with a year of history behind it therefore starts empty, which is
 * exactly the case the feature exists for. This walks that history.
 *
 * ## What this module is, and is not
 *
 * It is a cursor and a throttle. Every session it reaches is handed to
 * `enqueueProjectMiningJobs`, the same function the live turn path and the idle
 * flush call, so a backfilled claim has identical provenance, identical PII
 * gating, and identical consolidation to one mined live. There is no second
 * miner here and there must never be one.
 *
 * ## Newest first
 *
 * Same reasoning as `backfillChatSearchTextStep`: recent project state is the
 * state most likely to still be true, and a user who started a sweep sees value
 * after the first batch rather than after the last.
 *
 * ## The watermark advances at ENQUEUE, not at completion
 *
 * The plan called for advancing once a batch reached a terminal state. Enqueue
 * turned out to be the correct point and the safer one: a queued
 * `project-mining` row is durable, so a quit between enqueue and mining loses
 * nothing, while a cursor that waits for completion has to remember which
 * sessions were in flight and would re-enqueue them after a crash. Waiting for
 * the previous batch to drain is kept, but purely as a throttle so a sweep
 * cannot flood a queue that drains twenty jobs per tick.
 */

import {
  PROJECT_MINING_RUN_LEASE_TTL_MS,
  estimateProjectMiningRun,
} from "@cognia/memory/lifecycle/project-mining-run"
import type { ProjectMiningRun } from "@/types/memory/governance"
import type { ChatSession } from "@cognia/agent-config-types"

/** Sessions handed to the miner per step. */
export const BACKFILL_SESSION_BATCH = 5

/**
 * Queue depth above which a step declines to enqueue more.
 *
 * The memory worker drains twenty jobs per thirty-second tick. Letting a sweep
 * run ahead of that would bury a live turn's own extraction behind a thousand
 * historical windows, which is the one thing a background sweep must not do.
 */
export const BACKFILL_PENDING_JOB_CEILING = 40

export type ProjectMiningStepOutcome =
  /** The run is not claimable right now (another window owns it, or it ended). */
  | { kind: "idle" }
  /** The previous batch is still draining. Nothing was enqueued. */
  | { kind: "throttled"; pending: number }
  | { kind: "advanced"; sessionsScanned: number; jobsEnqueued: number }
  /** No sessions left before the cursor. The run is finished. */
  | { kind: "finished" }

export interface ProjectMiningBackfillDeps {
  /** One page of sessions, newest first, strictly older than the cursor. */
  pageSessions: (input: {
    projectId: string
    beforeCreatedAt?: number
    beforeSessionId?: string
    limit: number
  }) => Promise<ChatSession[]>
  loadTranscript: (
    sessionId: string
  ) => Promise<Array<{ id: string; role: string; text: string; parts?: unknown }>>
  enqueueForSession: (input: {
    session: ChatSession
    runId: string
    transcript: Array<{ id: string; role: string; text: string; parts?: unknown }>
  }) => Promise<number>
  /** Non-terminal `project-mining` rows still attributable to this run. */
  countPendingJobs: (runId: string) => Promise<number>
  claimRun: (runId: string, workerId: string) => Promise<ProjectMiningRun | undefined>
  advanceRun: (
    runId: string,
    step: {
      cursorCreatedAt: number
      cursorSessionId: string
      sessionsScanned: number
      jobsEnqueued: number
    }
  ) => Promise<ProjectMiningRun | undefined>
  finishRun: (runId: string) => Promise<unknown>
  workerId: string
}

/**
 * One step of a running backfill.
 *
 * Never throws: a sweep that dies on one unreadable session would strand the
 * lease until it expired, and the user would see a run that says "running" and
 * makes no progress. A failed session is skipped and its slot still counts as
 * scanned, for the same reason the watermark advances on "checked".
 */
export async function stepProjectMiningBackfill(
  runId: string,
  deps: ProjectMiningBackfillDeps
): Promise<ProjectMiningStepOutcome> {
  let run: ProjectMiningRun | undefined
  try {
    run = await deps.claimRun(runId, deps.workerId)
  } catch {
    return { kind: "idle" }
  }
  if (!run) return { kind: "idle" }

  const pending = await deps.countPendingJobs(runId).catch(() => 0)
  if (pending >= BACKFILL_PENDING_JOB_CEILING) return { kind: "throttled", pending }

  let page: ChatSession[]
  try {
    page = await deps.pageSessions({
      projectId: run.projectId,
      beforeCreatedAt: run.cursorCreatedAt,
      beforeSessionId: run.cursorSessionId,
      limit: BACKFILL_SESSION_BATCH,
    })
  } catch {
    return { kind: "idle" }
  }
  if (page.length === 0) {
    await deps.finishRun(runId).catch(() => undefined)
    return { kind: "finished" }
  }

  let jobsEnqueued = 0
  for (const session of page) {
    try {
      const transcript = await deps.loadTranscript(session.id)
      if (transcript.length === 0) continue
      jobsEnqueued += await deps.enqueueForSession({ session, runId, transcript })
    } catch {
      // Skipped, but still counted as scanned below: an unreadable session must
      // not be revisited forever.
    }
  }

  const last = page[page.length - 1]
  await deps
    .advanceRun(runId, {
      cursorCreatedAt: last.createdAt,
      cursorSessionId: last.id,
      sessionsScanned: page.length,
      jobsEnqueued,
    })
    .catch(() => undefined)
  return { kind: "advanced", sessionsScanned: page.length, jobsEnqueued }
}

export interface ProjectMiningCountDeps {
  countSessions: (projectId: string) => Promise<number>
  countMessages: (projectId: string) => Promise<number>
}

/**
 * What a sweep of this workspace would cost, from index walks only.
 *
 * Counts, never bodies. Reading `parts` to measure the work is the read the
 * estimate exists to let the user decide about, and a 500-row page of whole
 * messages is a page of tool outputs and media reference sets.
 *
 * The result is honest in both directions and the dialog should say so:
 * salience rejects some windows before they ever reach a model, while a
 * conversation full of long tool output will exceed the per-message average.
 */
export async function estimateProjectMiningBackfill(
  projectId: string,
  deps: ProjectMiningCountDeps
) {
  const [sessions, messages] = await Promise.all([
    deps.countSessions(projectId),
    deps.countMessages(projectId),
  ])
  return estimateProjectMiningRun({ sessions, messages })
}

export { PROJECT_MINING_RUN_LEASE_TTL_MS }
