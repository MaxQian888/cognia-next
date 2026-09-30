/**
 * `action.media.generateVideo` (ADR-0205): generate a video with a configured
 * video provider and hand the next node a file path.
 *
 * An adapter over the video job engine, like the chat tool and `/video`: the
 * node starts a durable job (origin `workflow`), waits on its row, and the
 * renderer's job host writes the finished video under AppData
 * (`generated-videos/<accountId>/<database>/<jobId>.<ext>`). The output's
 * `outputPath` is what `action.media.probe`, `frame`, `trim` and `concat` read.
 * Like their temp-root outputs it is outside every workspace root, so an
 * `action.fs.*` node cannot read it. A succeeded job's file is removed with its
 * row by the 30-day retention sweep, and with its database by "clear all data"
 * or account deletion.
 *
 * Provider, model and options fall back to Settings → Media generation the
 * same way `/video` does (`applyVideoDefaults`). The start image is optional
 * and takes the image nodes' four source fields, so a frame or image node's
 * `blobRef` chains straight in.
 *
 * `retryable: false`: every start is a paid generation, and the orchestrator
 * retrying a failed step would start (and bill) another. For the same reason a
 * step the orchestrator resumes after a crash picks up the job it already
 * started (same run, step and loop iteration) instead of starting a new one.
 * Cancelling the run cancels the job with the provider where the provider
 * allows it.
 *
 * Runs only in the desktop app with no remote host attached: the video is
 * written to this machine's disk, and the media nodes that read it run on the
 * attached host. A web or mobile run that reaches `media` through a paired
 * device would otherwise pay for a video it cannot store.
 */

import type { VideoGenerationSettings } from "@cognia/agent-config-types"

import type { StartVideoJobInput, StartVideoJobResult } from "@/lib/ai/media/video-jobs/engine"
import type { MediaGenerationJobRow, VideoJobOrigin } from "@/lib/ai/media/video-jobs/types"
import type { VideoProviderId } from "@/lib/ai/media/video-generation-sdk"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"
import { hasImageSource, resolveImageBytes } from "../shared/image-source"

const KIND = "action.media.generateVideo"

/**
 * The job deadline (30 minutes, after which the job settles `timed_out`) plus
 * room for the download. Past this the orchestrator aborts the step, which
 * cancels the job.
 */
export const GENERATE_VIDEO_TIMEOUT_MS = 45 * 60_000

type WorkflowOrigin = Extract<VideoJobOrigin, { surface: "workflow" }>

export interface GenerateVideoNodeDeps {
  /** Whether this renderer is the desktop app with no remote host attached. */
  runsOnThisMachine(): boolean
  start(input: StartVideoJobInput): Promise<StartVideoJobResult>
  wait(jobId: string, signal?: AbortSignal): Promise<MediaGenerationJobRow | undefined>
  /** Jobs that are running or succeeded, for picking up this step's own job. */
  liveJobs(): Promise<MediaGenerationJobRow[]>
  settings(): VideoGenerationSettings | undefined
  /** Configured video providers this shell can reach. */
  configuredProviders(): VideoProviderId[]
}

/**
 * The job this very step started before an interruption: same run, step and
 * loop iteration, still running or already done. Newest first, should a crash
 * ever have left two.
 */
export function jobOfStep(
  rows: readonly MediaGenerationJobRow[],
  origin: WorkflowOrigin
): MediaGenerationJobRow | undefined {
  return rows
    .filter((row) => {
      const o = row.origin
      return (
        o.surface === "workflow" &&
        o.runId === origin.runId &&
        o.stepId === origin.stepId &&
        o.iteration?.loopId === origin.iteration?.loopId &&
        o.iteration?.iterationIndex === origin.iteration?.iterationIndex
      )
    })
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

let testDeps: GenerateVideoNodeDeps | null = null

/** Test seam, mirroring `__setMediaToolDepsForTesting`. */
export function __setGenerateVideoDepsForTesting(deps: GenerateVideoNodeDeps | null): void {
  testDeps = deps
}

/** Renderer dependencies, reached lazily so the brain never loads the job host. */
async function resolveDeps(): Promise<GenerateVideoNodeDeps> {
  if (testDeps) return testDeps
  const [rendererHost, host, ffmpeg] = await Promise.all([
    import("@/lib/ai/media/video-jobs/renderer-host"),
    import("@/lib/ai/media/video-jobs/host"),
    import("@/lib/chat/attachments/video/ffmpeg-source"),
  ])
  rendererHost.ensureRendererVideoJobHost()
  return {
    // The same test the composer uses before handing a path to FFmpeg.
    runsOnThisMachine: ffmpeg.canUseLocalFfmpeg,
    start: (input) => host.getVideoJobEngine().start(input),
    wait: (jobId, signal) => host.getVideoJobEngine().wait(jobId, signal ? { signal } : {}),
    liveJobs: async () => {
      const store = host.getVideoJobHost().store
      const lists = await Promise.all(
        (["generating", "downloading", "succeeded"] as const).map((status) =>
          store.listByStatus(status)
        )
      )
      return lists.flat()
    },
    settings: rendererHost.currentVideoGenerationSettings,
    configuredProviders: rendererHost.reachableVideoProviderIds,
  }
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const value = p[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveInt(p: Record<string, unknown>, key: string): number | undefined {
  const value = p[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw nonRetryable(`${KIND}: '${key}' must be a whole number of at least 1`)
  }
  return value
}

async function startFrameOf(
  p: Record<string, unknown>
): Promise<StartVideoJobInput["startFrame"] | undefined> {
  if (!hasImageSource(p)) return undefined
  const { blob, mediaType } = await resolveImageBytes(p, KIND)
  const type = mediaType ?? blob.type
  if (!type.toLowerCase().startsWith("image/")) {
    throw nonRetryable(`${KIND}: the start image must be an image, not ${type || "unknown bytes"}`)
  }
  return { kind: "bytes", data: new Uint8Array(await readBlobAsArrayBuffer(blob)), mediaType: type }
}

registerNodeExecutor({
  kind: KIND,
  typeVersion: 1,
  retryable: false,
  timeoutMs: GENERATE_VIDEO_TIMEOUT_MS,
  execute: async (ctx: StepExecutionContext) => {
    const p = ctx.params as Record<string, unknown>
    const prompt = str(p, "prompt")
    if (!prompt) throw nonRetryable(`${KIND} requires 'prompt'`)
    const deps = await resolveDeps()
    if (!deps.runsOnThisMachine()) {
      throw nonRetryable(
        `${KIND} runs only in the desktop app with no remote host attached: the video is ` +
          `written to this computer's disk for the media nodes that read it.`
      )
    }
    const origin: WorkflowOrigin = {
      surface: "workflow",
      runId: ctx.runId,
      stepId: ctx.stepId,
      ...(ctx.iteration ? { iteration: ctx.iteration } : {}),
    }
    const resumed = jobOfStep(await deps.liveJobs(), origin)
    const jobId = resumed ? resumed.id : await startJob(ctx, p, prompt, origin, deps)

    const settled = await deps.wait(jobId, ctx.signal)
    if (ctx.signal?.aborted) {
      throw new Error(
        settled?.status === "cancelled"
          ? `${KIND}: the run was cancelled; the video job was cancelled with it`
          : `${KIND}: the run was cancelled while the video job was ${settled?.status ?? "missing"}`
      )
    }
    const content = settled?.result?.content
    if (!settled || settled.status !== "succeeded" || content?.kind !== "file") {
      const code = settled?.error?.code ?? settled?.status ?? "missing"
      const message =
        settled?.error?.message ?? `the video job ended ${settled?.status ?? "missing"}`
      throw nonRetryable(`${KIND}: ${code}: ${message}`)
    }
    const result = settled.result!
    return {
      output: {
        jobId: settled.id,
        outputPath: content.path,
        mediaType: result.mediaType,
        byteSize: result.byteSize,
        durationSeconds: result.durationSec ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
        providerId: settled.provider.providerId,
        modelId: settled.provider.modelId,
        warnings: settled.warnings ?? [],
      },
    }
  },
})

/** Start this step's job with the saved defaults under the node's own choices. */
async function startJob(
  ctx: StepExecutionContext,
  p: Record<string, unknown>,
  prompt: string,
  origin: WorkflowOrigin,
  deps: GenerateVideoNodeDeps
): Promise<string> {
  const startFrame = await startFrameOf(p)
  const { applyVideoDefaults } = await import("@/lib/ai/media/video-jobs/defaults")
  const selection = applyVideoDefaults(
    deps.settings(),
    {
      providerId: str(p, "providerId"),
      model: str(p, "model"),
      durationSec: positiveInt(p, "durationSec"),
      aspectRatio: str(p, "aspectRatio") as `${number}:${number}` | undefined,
      resolution: str(p, "resolution") as `${number}x${number}` | undefined,
    },
    deps.configuredProviders()
  )
  const started = await deps.start({
    prompt,
    ...(startFrame ? { startFrame } : {}),
    ...(selection.providerId ? { providerId: selection.providerId } : {}),
    ...(selection.model ? { model: selection.model } : {}),
    params: selection.params,
    origin,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
  })
  if (!started.ok) {
    throw nonRetryable(`${KIND}: ${started.error.code}: ${started.error.message}`)
  }
  return started.job.id
}
