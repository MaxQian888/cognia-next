/**
 * Wiring for the history backfill: the production deps, and the four verbs the
 * UI calls.
 *
 * Kept apart from `project-mining-backfill.ts` so the cursor logic stays a pure
 * function of injected readers. Everything that touches Dexie, the settings
 * store or the job queue lives here.
 */

import {
  isTerminalProjectMiningRun,
  projectMiningRunProgress,
} from "@cognia/memory/lifecycle/project-mining-run"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ProjectMiningRun } from "@/types/memory/governance"
import { getDb } from "@/lib/db/schema"
import { listMessages } from "@/lib/db/messages"
import { cancelMemoryJobsForRun, countPendingMemoryJobsForRun } from "@/lib/db/memory-governance"
import {
  advanceProjectMiningRun,
  claimProjectMiningRun,
  createProjectMiningRun,
  getActiveProjectMiningRun,
  getProjectMiningRun,
  transitionProjectMiningRun,
} from "@/lib/db/project-mining-runs"
import { enqueueProjectMiningJobs } from "@/lib/memory/write/project-mining-enqueue"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import {
  estimateProjectMiningBackfill,
  stepProjectMiningBackfill,
  type ProjectMiningBackfillDeps,
  type ProjectMiningStepOutcome,
} from "./project-mining-backfill"

/** This renderer's identity for the run lease. One per window, stable. */
let workerId: string | null = null
function thisWorker(): string {
  if (!workerId) workerId = `backfill_${Math.random().toString(36).slice(2, 10)}`
  return workerId
}

/**
 * One page of a workspace's sessions, newest first, strictly older than the
 * cursor.
 *
 * The cursor is `[createdAt, id]` rather than `createdAt` alone because
 * sessions routinely share a millisecond, and a one-part cursor would either
 * re-read or skip every row tied with the boundary.
 */
async function pageSessions({
  projectId,
  beforeCreatedAt,
  beforeSessionId,
  limit,
}: {
  projectId: string
  beforeCreatedAt?: number
  beforeSessionId?: string
  limit: number
}): Promise<ChatSession[]> {
  const table = getDb().sessions.where("[projectId+createdAt+id]")
  // Prefix bounds built from strings. A shorter array sorts before every longer
  // one sharing its prefix, which is all the lower bound needs, and `\uffff`
  // sorts after every other UTF-16 code unit, which is what the upper bound
  // needs.
  //
  // `Dexie.minKey` / `Dexie.maxKey` would work here too. An earlier version of
  // this comment claimed `-Infinity` is not a valid IndexedDB key, and that is
  // wrong: the spec's value-to-key algorithm rejects only `NaN` among numbers,
  // and both sentinels round-trip fine under `fake-indexeddb`. The bound that
  // really does throw `DataError` is `undefined`, which is why the cursor arm
  // below defaults `beforeSessionId` to `""` rather than passing it through.
  const lower = [projectId]
  const upper =
    beforeCreatedAt === undefined
      ? [`${projectId}\uffff`]
      : [projectId, beforeCreatedAt, beforeSessionId ?? ""]
  return table.between(lower, upper, true, false).reverse().limit(limit).toArray() as Promise<
    ChatSession[]
  >
}

function backfillDeps(): ProjectMiningBackfillDeps {
  return {
    pageSessions,
    loadTranscript: async (sessionId) => {
      const messages = await listMessages(sessionId)
      return messages.flatMap((message) =>
        message.id
          ? [
              {
                id: message.id,
                role: message.role,
                text: extractPlainText(message.parts),
                parts: message.parts,
              },
            ]
          : []
      )
    },
    enqueueForSession: async ({ session, runId, transcript }) => {
      const jobs = await enqueueProjectMiningJobs({
        sessionId: session.id,
        projectId: session.projectId ?? "",
        transcript,
        transcriptRevision: session.transcriptRevision,
        scope: "workspace",
        characterId: session.characterId,
        // `system`, not `user`: nobody was in this conversation just now. The
        // provenance facet in /memory should be able to separate what a sweep
        // learned from what a live turn learned.
        provenance: "system",
        // The conversation is over, so every window is closed, including the
        // last one the live path deliberately holds back.
        includeTrailing: true,
        runId,
      })
      return jobs.length
    },
    countPendingJobs: countPendingMemoryJobsForRun,
    claimRun: (runId, worker) => claimProjectMiningRun(runId, worker),
    advanceRun: advanceProjectMiningRun,
    finishRun: (runId) => transitionProjectMiningRun(runId, "succeeded"),
    workerId: thisWorker(),
  }
}

/**
 * Count what a sweep would cost, without reading a single message body.
 *
 * `count()` on an index walk is index-only in Dexie, so neither call
 * materialises a row.
 */
export async function estimateWorkspaceBackfill(projectId: string) {
  return estimateProjectMiningBackfill(projectId, {
    countSessions: (id) => getDb().sessions.where("projectId").equals(id).count(),
    countMessages: (id) => getDb().messages.where("projectId").equals(id).count(),
  })
}

/**
 * Create a run in `preconsent`, or hand back the one already in flight.
 *
 * Returning the existing run rather than making a second one is the whole
 * reason `getActiveProjectMiningRun` counts `preconsent` as active: two runs
 * over one workspace would fight over the same cursor and mine everything
 * twice.
 */
export async function proposeWorkspaceBackfill(projectId: string): Promise<ProjectMiningRun> {
  const existing = await getActiveProjectMiningRun(projectId)
  if (existing) return existing
  const estimate = await estimateWorkspaceBackfill(projectId)
  return createProjectMiningRun({ projectId, estimate })
}

/** The user agreed to the cost. This is the only way out of `preconsent`. */
export async function confirmWorkspaceBackfill(
  runId: string
): Promise<ProjectMiningRun | undefined> {
  return transitionProjectMiningRun(runId, "queued")
}

export async function pauseWorkspaceBackfill(runId: string): Promise<ProjectMiningRun | undefined> {
  return transitionProjectMiningRun(runId, "paused")
}

export async function resumeWorkspaceBackfill(
  runId: string
): Promise<ProjectMiningRun | undefined> {
  return transitionProjectMiningRun(runId, "queued")
}

/**
 * Stop a run and withdraw the work it has not done yet.
 *
 * The order matters: the run leaves the runnable states first, so a tick racing
 * the cancel cannot enqueue a fresh batch behind the withdrawal.
 */
export async function cancelWorkspaceBackfill(runId: string): Promise<number> {
  await transitionProjectMiningRun(runId, "cancelled").catch(() => undefined)
  return cancelMemoryJobsForRun(runId)
}

/**
 * Advance the workspace's active run by one step, if it has one.
 *
 * Safe to call from an idle tick in every window: the lease decides which one
 * actually does the work, and the others get `idle`.
 */
export async function tickWorkspaceBackfill(projectId: string): Promise<ProjectMiningStepOutcome> {
  const run = await getActiveProjectMiningRun(projectId).catch(() => undefined)
  if (!run) return { kind: "idle" }
  // `preconsent` and `paused` are both "a person has not said go": neither is a
  // state a background tick may move out of.
  if (run.status !== "queued" && run.status !== "running") return { kind: "idle" }
  return stepProjectMiningBackfill(run.id, backfillDeps())
}

export { getProjectMiningRun, isTerminalProjectMiningRun, projectMiningRunProgress }
