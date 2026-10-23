/**
 * Durable video-generation jobs (ADR-0205).
 *
 * A job is started with the AI SDK's `experimental_startVideo`, which returns
 * an opaque, JSON-serializable `operation`. The row keeps that operation plus
 * the provider coordinates needed to rebuild the same model later (every
 * provider except fal rebuilds its status URL from the configured base URL),
 * so a reconciler can keep checking it across reloads and download the result
 * exactly once.
 */

import type {
  MediaGenerationJobRow,
  VideoJobStatus,
} from "@cognia/plugin-contract/lib/ai/media/video-jobs/types"
export type {
  MediaGenerationJobRow,
  VideoJobContent,
  VideoJobError,
  VideoJobErrorCode,
  VideoJobOrigin,
  VideoJobProvider,
  VideoJobRequest,
  VideoJobResult,
  VideoJobStartFrameRef,
  VideoJobStatus,
} from "@cognia/plugin-contract/lib/ai/media/video-jobs/types"

const SETTLED_VIDEO_JOB_STATUSES: ReadonlySet<VideoJobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
])

export function isSettledVideoJob(row: Pick<MediaGenerationJobRow, "status">): boolean {
  return SETTLED_VIDEO_JOB_STATUSES.has(row.status)
}

/** A settled job the user can ask to check again (G9). */
export function canRecheckVideoJob(row: Pick<MediaGenerationJobRow, "status" | "error">): boolean {
  if (row.status === "timed_out") return true
  return row.status === "failed" && row.error?.recheckable === true
}

export function newVideoJobId(now: number = Date.now()): string {
  return `vjob_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
