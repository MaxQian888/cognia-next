/**
 * "Try again" for a settled video job (ADR-0205): a new job with the same
 * prompt, start frame, options, provider and model, started from the same
 * conversation. A start frame given as raw bytes was never stored (the row
 * keeps only its media type), so such a job cannot be repeated.
 */

import type { StartVideoJobInput } from "./engine"
import { isSettledVideoJob, type MediaGenerationJobRow, type VideoJobOrigin } from "./types"

function retryOrigin(origin: VideoJobOrigin): VideoJobOrigin | null {
  switch (origin.surface) {
    case "chat-tool":
    case "slash":
      return origin
    // A plugin, workflow step or executor caller is waiting on its own job
    // id; a card has nothing to hand a repeat back to.
    case "plugin":
    case "workflow":
    case "executor":
      return null
  }
}

/** The start input that repeats `row`, or null when it cannot be repeated. */
export function retryInputOf(row: MediaGenerationJobRow): StartVideoJobInput | null {
  if (!isSettledVideoJob(row) || row.status === "succeeded") return null
  const origin = retryOrigin(row.origin)
  if (!origin) return null
  const frame = row.request.startFrame
  if (frame?.kind === "inline") return null
  const { prompt, durationSec, aspectRatio, resolution, seed, fps } = row.request
  const params = Object.fromEntries(
    Object.entries({ durationSec, aspectRatio, resolution, seed, fps }).filter(
      ([, value]) => value !== undefined
    )
  ) as StartVideoJobInput["params"]
  return {
    prompt,
    ...(frame ? { startFrame: frame } : {}),
    providerId: row.provider.providerId,
    model: row.provider.modelId,
    params,
    origin,
    ...(row.projectId ? { projectId: row.projectId } : {}),
  }
}
