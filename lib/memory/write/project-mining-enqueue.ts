/**
 * Which transcript windows earn a `project-mining` job, and how they are queued.
 *
 * WHY WINDOWS AND NOT TURNS. Enqueuing one job per turn would roughly double the
 * memory job volume of every project conversation, against a drain budget of 20
 * jobs per 30s tick. Windows are ~12 messages wide, so a live session produces a
 * job roughly every ten turns instead of every turn.
 *
 * WHY THE TRAILING WINDOW IS HELD BACK. The last window keeps growing while the
 * conversation continues, so its `lastMessageId` — and therefore its dedupe key —
 * changes on every turn. Mining it live would re-mine the same overlapping text
 * repeatedly, which is both the cost and the duplicate-claim problem. It is
 * instead flushed once from the idle maintenance tick, where "the conversation
 * stopped" is a good proxy for "this window is closed".
 *
 * Consequence, stated rather than hidden: a session that ends before its first
 * window closes is mined by the idle flush, and if the app never reaches an idle
 * tick (a hard quit), by the explicit history backfill. It is never mined twice —
 * window identity is message-id based, and `reuseCompleted` makes re-enqueuing a
 * finished window a no-op.
 */

import {
  buildProjectMiningWindows,
  type ProjectMiningWindow,
  type ProjectWindowMessage,
} from "@cognia/memory/extract/project-windows"
import { assessProjectSalience } from "@cognia/memory/extract/project-salience"
import type { MemoryProvenance, MemoryScope } from "@/types/memory/memory"
import type { MemoryJob, MemoryJobCheckpoint } from "@/types/memory/governance"

export interface SelectProjectMiningWindowsOptions {
  /**
   * Include the last (still-growing) window. False on the live turn path, true
   * on the idle path where the conversation has stopped.
   */
  includeTrailing: boolean
}

/**
 * Windows worth a model call, in transcript order.
 *
 * Salience is applied HERE rather than inside the job so a window that will
 * never produce anything never becomes a queue row at all — the queue is the
 * scarce resource, not the salience check.
 */
export function selectProjectMiningWindows(
  transcript: readonly ProjectWindowMessage[],
  options: SelectProjectMiningWindowsOptions
): ProjectMiningWindow[] {
  const windows = buildProjectMiningWindows(transcript)
  const closed = options.includeTrailing ? windows : windows.slice(0, -1)
  return closed.filter((window) => assessProjectSalience({ messages: window.messages }).salient)
}

/** The checkpoint that pins a mining job to its window. */
export function projectMiningCheckpoint(
  window: ProjectMiningWindow,
  transcriptRevision: number | undefined
): MemoryJobCheckpoint {
  return {
    transcriptRevision: transcriptRevision ?? 0,
    firstMessageId: window.firstMessageId,
    lastMessageId: window.lastMessageId,
    messageCount: window.messages.length,
  }
}

/**
 * Dedupe key for one window.
 *
 * Ends in `:<count>` for the same reason every other memory job does: a row
 * whose `checkpoint` is ever lost still resolves through the legacy trailing-
 * count path in `resolveJobTranscriptWindow`.
 *
 * `runId` is reserved for history backfill, which stamps its own prefix so a
 * cancelled run can withdraw its still-queued jobs with one prefix scan of the
 * existing `dedupeKey` index.
 */
export function projectMiningDedupeKey(params: {
  sessionId: string
  window: ProjectMiningWindow
  runId?: string
}): string {
  const scope = params.runId ? `project-mining:${params.runId}` : "project-mining"
  return `${scope}:${params.sessionId}:${params.window.firstMessageId}:${params.window.lastMessageId}:${params.window.messages.length}`
}

export interface EnqueueProjectMiningJobsParams {
  sessionId: string
  projectId: string
  transcript: readonly ProjectWindowMessage[]
  transcriptRevision?: number
  scope: MemoryScope
  characterId?: string
  agentId?: string
  provenance: MemoryProvenance
  includeTrailing: boolean
  /** Set by history backfill so its jobs can be withdrawn as a group. */
  runId?: string
}

/**
 * Queue a mining job for every salient window. Returns the queued (or reused)
 * rows. Never throws — a mining failure must not break the turn that triggered it.
 */
export async function enqueueProjectMiningJobs(
  params: EnqueueProjectMiningJobsParams
): Promise<MemoryJob[]> {
  if (!params.projectId || !params.sessionId) return []
  const windows = selectProjectMiningWindows(params.transcript, {
    includeTrailing: params.includeTrailing,
  })
  if (windows.length === 0) return []

  const { enqueueMemoryJob } = await import("@/lib/db/memory-governance")
  const queued: MemoryJob[] = []
  for (const window of windows) {
    try {
      const job = await enqueueMemoryJob(
        {
          dedupeKey: projectMiningDedupeKey({
            sessionId: params.sessionId,
            window,
            runId: params.runId,
          }),
          kind: "project-mining",
          checkpoint: projectMiningCheckpoint(window, params.transcriptRevision),
          sessionId: params.sessionId,
          projectId: params.projectId,
          characterId: params.characterId,
          agentId: params.scope === "agent" ? params.agentId : undefined,
          scope: params.scope,
          provenance: params.provenance,
          // Mining evidence is per-CLAIM and cannot exist yet — the rows are
          // written by the worker once consolidation has produced memory ids.
          evidenceIds: [],
        },
        { reuseCompleted: true }
      )
      queued.push(job)
    } catch {
      // One unqueueable window must not stop the others.
    }
  }
  return queued
}
