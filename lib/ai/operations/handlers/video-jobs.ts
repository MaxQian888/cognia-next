/**
 * `videos.get`, `videos.cancel` and `videos.content` (ADR-0163, Batch 15),
 * in the contract shapes. A video handle names either
 *   - a job this process completed synchronously through the SDK (kept in
 *     the job registry with its bytes), or
 *   - a vendor-side job: the OpenAI videos API (`/videos/{id}`, content at
 *     `/content`, deletion as cancellation) or a Veo long-running operation
 *     (the handle id is the operation name, the bytes come from the sample
 *     URI the operation reports).
 * The registry is consulted first for every provider, so a locally
 * completed job answers without a network call. Nothing here invents a
 * status the vendor did not report.
 */

import type { z } from "zod"
import type {
  ProviderResourceHandle,
  videosCancelOutput,
  videosContentOutput,
  videosGetInput,
  videosGetOutput,
} from "@cognia/provider-types"

import { ProviderOperationFailureError } from "../failure"
import { providerJobRegistry, type ProviderJobRecord } from "../job-handle"
import type { ProviderOperationHandlerRegistration } from "../registry"
import { requireHandle } from "../resource-handle"
import { bytesRefOf, type BytesRef } from "./bytes"
import { providerDownload, providerRequest } from "./http"
import { contextOf, jobStatusOf, type JobStatus, type WireContext } from "./jobs-shared"

export type VideosGetInput = z.infer<typeof videosGetInput>
export type VideosGetOutput = z.infer<typeof videosGetOutput>
export type VideosCancelOutput = z.infer<typeof videosCancelOutput>
export type VideosContentOutput = z.infer<typeof videosContentOutput>

interface VideoWire {
  get(context: WireContext, handle: ProviderResourceHandle): Promise<VideosGetOutput>
  cancel(context: WireContext, handle: ProviderResourceHandle): Promise<VideosCancelOutput>
  content(context: WireContext, handle: ProviderResourceHandle): Promise<BytesRef>
}

function fromRegistry(handle: ProviderResourceHandle, job: ProviderJobRecord): VideosGetOutput {
  return {
    handle,
    status: job.status,
    ...(job.status === "succeeded" ? { progress: 1 } : {}),
    ...(job.error ? { error: job.error } : {}),
  }
}

// ---- OpenAI videos API ------------------------------------------------------------

const OPENAI_STATUS: Record<string, JobStatus> = {
  queued: "queued",
  in_progress: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
}

interface OpenAiVideo {
  id: string
  status?: string
  progress?: number
  error?: { message?: string } | null
}

function openAiVideo(handle: ProviderResourceHandle, video: OpenAiVideo): VideosGetOutput {
  return {
    handle,
    status: jobStatusOf(video.status, OPENAI_STATUS),
    ...(typeof video.progress === "number"
      ? { progress: Math.min(1, Math.max(0, video.progress / 100)) }
      : {}),
    ...(video.error?.message ? { error: video.error.message } : {}),
  }
}

export const openAiVideoWire: VideoWire = {
  async get(context, handle) {
    const { json } = await providerRequest<OpenAiVideo>(context.provider, {
      path: `videos/${encodeURIComponent(handle.id)}`,
      signal: context.signal,
    })
    return openAiVideo(handle, json)
  },
  async cancel(context, handle) {
    // The API has no cancel verb: deleting a queued or running job stops it.
    await providerRequest(context.provider, {
      method: "DELETE",
      path: `videos/${encodeURIComponent(handle.id)}`,
      signal: context.signal,
    })
    return { handle, status: "cancelled" }
  },
  async content(context, handle) {
    const { bytes, mimeType } = await providerDownload(context.provider, {
      path: `videos/${encodeURIComponent(handle.id)}/content`,
      signal: context.signal,
    })
    return bytesRefOf(bytes, mimeType ?? "video/mp4")
  },
}

// ---- Veo operations -----------------------------------------------------------------

interface VeoOperation {
  name: string
  done?: boolean
  error?: { message?: string }
  response?: {
    generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> }
  }
}

function veoStatus(handle: ProviderResourceHandle, operation: VeoOperation): VideosGetOutput {
  const status: JobStatus = operation.error ? "failed" : operation.done ? "succeeded" : "running"
  return {
    handle,
    status,
    ...(status === "succeeded" ? { progress: 1 } : {}),
    ...(operation.error?.message ? { error: operation.error.message } : {}),
  }
}

export const veoVideoWire: VideoWire = {
  async get(context, handle) {
    const { json } = await providerRequest<VeoOperation>(context.provider, {
      path: handle.id,
      signal: context.signal,
    })
    return veoStatus(handle, json)
  },
  async cancel(_context, handle) {
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: `Veo operations cannot be cancelled once started (${handle.id})`,
    })
  },
  async content(context, handle) {
    const { json } = await providerRequest<VeoOperation>(context.provider, {
      path: handle.id,
      signal: context.signal,
    })
    const uri = json.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    if (!uri) {
      throw new ProviderOperationFailureError({
        code: "model-unavailable",
        retryable: !json.done,
        message: json.done
          ? "the operation finished without a video sample"
          : "the video is still generating",
      })
    }
    const { bytes, mimeType } = await providerDownload(context.provider, {
      baseURL: uri,
      path: "",
      signal: context.signal,
    })
    return bytesRefOf(bytes, mimeType ?? "video/mp4")
  },
}

// ---- dispatch -----------------------------------------------------------------------

/** The vendor wire for a provider, if this host has one. */
export function videoWireFor(context: WireContext): VideoWire | undefined {
  if (context.provider.protocol === "google") return veoVideoWire
  if (context.provider.protocol === "openai" || context.provider.protocol === "azure")
    return openAiVideoWire
  return undefined
}

function unknownJob(handle: ProviderResourceHandle): ProviderOperationFailureError {
  return new ProviderOperationFailureError({
    code: "model-unavailable",
    retryable: false,
    message: `no record of video job ${handle.id} on this host and ${handle.providerId} exposes no job API this host wires`,
  })
}

type Context = Parameters<ProviderOperationHandlerRegistration["handler"]>[0]

function handleOf(context: Context): ProviderResourceHandle {
  return requireHandle(context.request.input as VideosGetInput, "video", context.provider)
}

export const videosGetHandler: ProviderOperationHandlerRegistration<
  VideosGetInput,
  VideosGetOutput
> = {
  operationId: "videos.get",
  providerMatch: { kind: "any" },
  support: "native",
  async handler(context) {
    const handle = handleOf(context)
    const local = providerJobRegistry.get(handle)
    if (local) return fromRegistry(handle, local)
    const wire = videoWireFor(contextOf(context))
    if (!wire) throw unknownJob(handle)
    return wire.get(contextOf(context), handle)
  },
}

export const videosCancelHandler: ProviderOperationHandlerRegistration<
  VideosGetInput,
  VideosCancelOutput
> = {
  operationId: "videos.cancel",
  providerMatch: { kind: "any" },
  support: "native",
  async handler(context) {
    const handle = handleOf(context)
    const local = providerJobRegistry.get(handle)
    // A locally completed job has nothing left to cancel: report it as it is.
    if (local) return fromRegistry(handle, local)
    const wire = videoWireFor(contextOf(context))
    if (!wire) throw unknownJob(handle)
    return wire.cancel(contextOf(context), handle)
  },
}

export const videosContentHandler: ProviderOperationHandlerRegistration<
  VideosGetInput,
  VideosContentOutput
> = {
  operationId: "videos.content",
  providerMatch: { kind: "any" },
  support: "native",
  async handler(context) {
    const handle = handleOf(context)
    const local = providerJobRegistry.get(handle)
    if (local?.content) {
      const { base64, bytes, url, mimeType } = local.content
      return {
        video: {
          ...(bytes ? { bytes: new Uint8Array(bytes) } : {}),
          ...(base64 ? { base64 } : {}),
          ...(url ? { url } : {}),
          ...(mimeType ? { mimeType } : {}),
        },
      }
    }
    if (local) {
      throw new ProviderOperationFailureError({
        code: "model-unavailable",
        retryable: local.status === "queued" || local.status === "running",
        message: `video job ${handle.id} is ${local.status} and holds no bytes`,
      })
    }
    const wire = videoWireFor(contextOf(context))
    if (!wire) throw unknownJob(handle)
    return { video: await wire.content(contextOf(context), handle) }
  },
}

export const VIDEO_JOBS_HANDLERS: ProviderOperationHandlerRegistration[] = [
  videosGetHandler,
  videosCancelHandler,
  videosContentHandler,
] as ProviderOperationHandlerRegistration[]
