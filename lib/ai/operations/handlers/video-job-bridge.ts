/**
 * The provider-operations face of the video job engine (ADR-0205).
 *
 * `videos.generate` for the vendors the media module drives starts a durable
 * job and answers at once with its handle (the job id) and `running`.
 * `videos.get` / `cancel` / `content` recognise that handle by its `vjob_`
 * prefix and answer from the job, checking it with the provider first when it
 * is still generating — the CLI has no background reconciler, so a caller's
 * `videos.get` is what moves its job forward.
 */

import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import type { ProviderResourceHandle } from "@cognia/provider-types"
import { getVideoJobEngine, getVideoJobHost } from "@/lib/ai/media/video-jobs/host"
import type {
  MediaGenerationJobRow,
  VideoJobError,
  VideoJobStatus,
} from "@/lib/ai/media/video-jobs/types"
import type { ProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import { bytesRefOf, type BytesRef } from "./bytes"
import type { JobStatus } from "./jobs-shared"

const JOB_ID_PREFIX = "vjob_"

export function isVideoJobHandle(handle: Pick<ProviderResourceHandle, "id">): boolean {
  return handle.id.startsWith(JOB_ID_PREFIX)
}

const STATUS: Record<VideoJobStatus, JobStatus> = {
  generating: "running",
  downloading: "running",
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "failed",
  cancelled: "cancelled",
}

export function contractStatusOf(status: VideoJobStatus): JobStatus {
  return STATUS[status]
}

/** A start failure as the executor's typed failure. */
export function failureOfVideoJobError(error: VideoJobError): ProviderOperationFailureError {
  switch (error.code) {
    case "pii_blocked":
      return new ProviderOperationFailureError({
        code: "permission",
        retryable: false,
        message: error.message,
      })
    case "no_provider":
      return new ProviderOperationFailureError({
        code: "authentication",
        retryable: false,
        message: error.message,
      })
    case "credential_changed":
      return new ProviderOperationFailureError({
        code: "authentication",
        retryable: false,
        message: error.message,
      })
    case "unsupported_input":
    case "unavailable_on_web":
      return new ProviderOperationFailureError({
        code: "capability-unsupported",
        retryable: false,
        message: error.message,
      })
    default:
      return new ProviderOperationFailureError({
        code: "transport",
        retryable: error.recheckable,
        message: error.message,
      })
  }
}

async function jobFor(handle: ProviderResourceHandle): Promise<MediaGenerationJobRow> {
  const row = await getVideoJobHost().store.get(handle.id)
  // The handle's owner was already checked against the current provider;
  // a job started on another provider is not this handle's job.
  if (!row || row.provider.providerId !== handle.providerId) {
    throw new ProviderOperationFailureError({
      code: "model-unavailable",
      retryable: false,
      message: `no record of video job ${handle.id} on this host`,
    })
  }
  return row
}

function output(handle: ProviderResourceHandle, row: MediaGenerationJobRow) {
  return {
    handle,
    status: contractStatusOf(row.status),
    ...(row.status === "succeeded" ? { progress: 1 } : {}),
    ...(row.error ? { error: `${row.error.code}: ${row.error.message}` } : {}),
  }
}

export async function getVideoJob(
  handle: ProviderResourceHandle,
  snapshot: ProviderSettingsSnapshot
) {
  let row = await jobFor(handle)
  if (row.status === "generating") {
    row = (await getVideoJobEngine().poll(row.id, { snapshot })) ?? row
  }
  return output(handle, row)
}

export async function cancelVideoJob(
  handle: ProviderResourceHandle,
  snapshot: ProviderSettingsSnapshot
) {
  const row = await jobFor(handle)
  const settled = (await getVideoJobEngine().cancel(row.id, { snapshot })) ?? row
  return output(handle, settled)
}

export async function videoJobContent(
  handle: ProviderResourceHandle,
  snapshot: ProviderSettingsSnapshot
): Promise<BytesRef> {
  let row = await jobFor(handle)
  if (row.status === "generating") {
    row = (await getVideoJobEngine().poll(row.id, { snapshot })) ?? row
  }
  if (row.status !== "succeeded" || !row.result) {
    throw new ProviderOperationFailureError({
      code: "model-unavailable",
      retryable: row.status === "generating" || row.status === "downloading",
      message: `video job ${handle.id} is ${row.status} and holds no video`,
    })
  }
  const blob = await getVideoJobHost().readContent(row.result.content)
  return bytesRefOf(new Uint8Array(await readBlobAsArrayBuffer(blob)), row.result.mediaType)
}
