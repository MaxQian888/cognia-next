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

import type { JSONValue } from "ai"

import type { VideoProviderId } from "../video-generation-sdk"

/**
 * - `generating` — started at the provider; the reconciler polls it.
 * - `downloading` — the provider finished and one window claimed the download.
 * - `succeeded` / `failed` / `cancelled` / `timed_out` — settled.
 */
export type VideoJobStatus =
  "generating" | "downloading" | "succeeded" | "failed" | "cancelled" | "timed_out"

const SETTLED_VIDEO_JOB_STATUSES: ReadonlySet<VideoJobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
])

/** Stable failure codes; the UI localizes each one. */
export type VideoJobErrorCode =
  /** The prompt failed the outbound PII gate. */
  | "pii_blocked"
  /** No video provider is configured (or the named one is not). */
  | "no_provider"
  /** The provider's API key changed since the job started. */
  | "credential_changed"
  /** An option or start frame the provider/model does not accept. */
  | "unsupported_input"
  /** The web build cannot reach this provider (no CORS); desktop can. */
  | "unavailable_on_web"
  /** The provider reported the generation failed (moderation included). */
  | "generation_failed"
  /** A request to the provider failed (start, status, or cancel). */
  | "provider_error"
  /** Past the job deadline without a terminal answer. */
  | "timed_out"
  /** The finished video could not be downloaded. */
  | "download_failed"
  /** The finished video is larger than this shell can carry. */
  | "result_too_large"
  /** The provider no longer serves the finished video. */
  | "result_expired"
  /** Storing the downloaded video failed. */
  | "store_failed"

export interface VideoJobError {
  code: VideoJobErrorCode
  message: string
  /**
   * Whether "check again" can still succeed: the remote job may be fine and
   * only this side failed (credentials changed, provider unreachable, a
   * download that can be retried while the URL is valid, the deadline).
   */
  recheckable: boolean
}

/**
 * Where the start request came from; decides where the result lands.
 *
 * `chat-tool` is the `video_generate` agent tool and `slash` is `/video`
 * (including "try again" on either card); their video becomes an asset of
 * that conversation. Jobs live in this device's database and are not synced:
 * a companion viewing the conversation from another device shows the card as
 * "not stored on this device" rather than a job it cannot follow.
 *
 * `workflow` is the `action.media.generateVideo` node; its video becomes a
 * file on disk the next media node can read.
 */
export type VideoJobOrigin =
  | { surface: "chat-tool"; sessionId: string }
  | { surface: "slash"; sessionId: string }
  | { surface: "plugin"; pluginId: string }
  | {
      surface: "workflow"
      runId: string
      stepId: string
      /** The loop iteration, when the step runs inside a loop. */
      iteration?: { loopId: string; iterationIndex: number }
    }
  | { surface: "executor" }

/** The start frame as recorded on the row — a reference, never the bytes. */
export type VideoJobStartFrameRef =
  | { kind: "media"; ref: string }
  | { kind: "session-asset"; assetId: string }
  | { kind: "inline"; mediaType: string }

export interface VideoJobRequest {
  prompt: string
  startFrame?: VideoJobStartFrameRef
  durationSec?: number
  aspectRatio?: `${number}:${number}`
  resolution?: `${number}x${number}`
  seed?: number
  fps?: number
}

export interface VideoJobProvider {
  providerId: VideoProviderId
  modelId: string
  /** The provider's configured base URL when the job started. */
  baseURL?: string
  /** `credentialAffinityOf(apiKey)` when the job started. */
  credentialAffinity: string
}

/** Where a finished video's bytes live. */
export type VideoJobContent =
  | { kind: "session-asset"; sessionId: string; assetId: string }
  | { kind: "library"; assetId: string }
  /**
   * A file under the desktop app's AppData (`relativePath`), for a workflow
   * job; `path` is its absolute form, which is what the workflow step outputs.
   */
  | { kind: "file"; relativePath: string; path: string }
  /** Held in memory by the in-memory store (CLI); gone with the process. */
  | { kind: "inline"; bytes: Uint8Array }

export interface VideoJobResult {
  content: VideoJobContent
  mediaType: string
  byteSize: number
  /**
   * Read from the stored file when this shell can decode it; absent otherwise
   * (the video is stored either way, and the player shows its own first frame).
   */
  durationSec?: number
  width?: number
  height?: number
}

export interface MediaGenerationJobRow {
  /** `vjob_<base36 time>_<rand>`; also the provider-operations handle id. */
  id: string
  kind: "video"
  /** Flattened from `origin` for the `[sessionId+createdAt]` index. */
  sessionId?: string
  projectId?: string
  origin: VideoJobOrigin
  request: VideoJobRequest
  provider: VideoJobProvider
  /** Opaque SDK reference from `experimental_startVideo`. */
  operation: JSONValue
  status: VideoJobStatus
  /** Status checks made so far; drives the poll backoff. */
  pollCount: number
  /** Next time the reconciler should check this job. */
  nextPollAt: number
  /** After this the job settles `timed_out` (it can still be checked again). */
  deadlineAt: number
  /** Provider warnings, e.g. an option the model ignored. */
  warnings?: string[]
  /** Last transient status-check failure, cleared on the next success. */
  lastPollError?: string
  error?: VideoJobError
  /** Set when cancelled: whether the provider was actually asked to stop. */
  remoteCancelled?: boolean
  result?: VideoJobResult
  createdAt: number
  updatedAt: number
  settledAt?: number
}

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
