/**
 * Validate a video job's parameters against what the provider's AI SDK
 * adapter forwards (`VIDEO_PROVIDER_OPTIONS`) and what the model accepts as a
 * start frame, before any network call. A control the adapter would drop is
 * refused here instead of vanishing silently.
 */

import {
  VIDEO_PROVIDER_OPTIONS,
  videoStartFrameMode,
  type VideoProviderId,
} from "../video-generation-sdk"

export interface VideoJobParams {
  durationSec?: number
  aspectRatio?: `${number}:${number}`
  resolution?: `${number}x${number}`
  seed?: number
  fps?: number
}

export type VideoParamsCheck =
  | { ok: true }
  | {
      ok: false
      /** The option or input the provider/model refuses. */
      field: keyof VideoJobParams | "startFrame"
      message: string
    }

const ASPECT_RATIO = /^\d+:\d+$/
const RESOLUTION = /^\d+x\d+$/

export function checkVideoJobParams(
  providerId: VideoProviderId,
  modelId: string,
  params: VideoJobParams,
  hasStartFrame: boolean
): VideoParamsCheck {
  const support = VIDEO_PROVIDER_OPTIONS[providerId]
  if (params.aspectRatio !== undefined) {
    if (!ASPECT_RATIO.test(params.aspectRatio)) {
      return {
        ok: false,
        field: "aspectRatio",
        message: `Invalid aspect ratio "${params.aspectRatio}".`,
      }
    }
    if (!support.aspectRatio) {
      return {
        ok: false,
        field: "aspectRatio",
        message: `${providerId} does not take an aspect ratio.`,
      }
    }
  }
  if (params.resolution !== undefined) {
    if (!RESOLUTION.test(params.resolution)) {
      return {
        ok: false,
        field: "resolution",
        message: `Invalid resolution "${params.resolution}".`,
      }
    }
    if (!support.resolution) {
      return {
        ok: false,
        field: "resolution",
        message: `${providerId} does not take a resolution.`,
      }
    }
  }
  if (params.durationSec !== undefined) {
    if (!Number.isFinite(params.durationSec) || params.durationSec <= 0) {
      return {
        ok: false,
        field: "durationSec",
        message: "Duration must be a positive number of seconds.",
      }
    }
    if (!support.duration) {
      return { ok: false, field: "durationSec", message: `${providerId} does not take a duration.` }
    }
  }
  if (params.seed !== undefined) {
    if (!Number.isInteger(params.seed)) {
      return { ok: false, field: "seed", message: "Seed must be an integer." }
    }
    if (!support.seed) {
      return { ok: false, field: "seed", message: `${providerId} does not take a seed.` }
    }
  }
  if (params.fps !== undefined) {
    if (!Number.isFinite(params.fps) || params.fps <= 0) {
      return { ok: false, field: "fps", message: "fps must be a positive number." }
    }
    if (!support.fps) {
      return { ok: false, field: "fps", message: `${providerId} does not take fps.` }
    }
  }
  const frameMode = videoStartFrameMode(modelId)
  if (frameMode === "required" && !hasStartFrame) {
    return { ok: false, field: "startFrame", message: `${modelId} needs a start image.` }
  }
  if (frameMode === "unsupported" && hasStartFrame) {
    return { ok: false, field: "startFrame", message: `${modelId} generates from text only.` }
  }
  return { ok: true }
}
