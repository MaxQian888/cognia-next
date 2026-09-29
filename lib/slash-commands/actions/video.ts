/**
 * `/video` — start a video job from the composer (ADR-0205, S1/G8).
 *
 *   /video <prompt> [--duration 5] [--aspect 16:9] [--resolution 1280x720]
 *                   [--provider google] [--model veo-3.1-generate-preview]
 *
 * The first staged image becomes the start frame. It is stored as an asset of
 * this conversation (so "try again" can reuse it and the agent can refer to
 * it) and taken out of the turn the composer sends after the command, so the
 * chat model does not receive it too. The job's card is pushed into the
 * conversation and follows the job from there.
 */

import type { VideoJobStartFrameInput } from "@/lib/ai/media/video-jobs/engine"
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS_SEC,
  VIDEO_GENERATION_PROVIDER_IDS,
  VIDEO_RESOLUTIONS,
} from "@/lib/ai/media/video-generation-sdk"
import type { MediaToolDeps } from "@/lib/claude/media-builtin-tools"
import type { SlashContext, SlashParamSpec } from "../builtin"

const USAGE =
  "Usage: `/video <prompt> [--duration s] [--aspect 16:9] [--resolution 1280x720] [--provider id] [--model id]`. Stage an image first to animate it."

/** Guided form for the command picker; emits the flags `parseVideoArgs` reads. */
export const VIDEO_COMMAND_PARAMS: SlashParamSpec[] = [
  {
    name: "prompt",
    label: "Prompt",
    type: "string",
    required: true,
    style: "positional",
    placeholder: "e.g. a paper boat drifting down a rainy street, slow dolly shot",
  },
  {
    name: "duration",
    label: "Duration (seconds)",
    type: "enum",
    options: VIDEO_DURATIONS_SEC.map(String),
  },
  { name: "aspect", label: "Aspect ratio", type: "enum", options: [...VIDEO_ASPECT_RATIOS] },
  { name: "resolution", label: "Resolution", type: "enum", options: [...VIDEO_RESOLUTIONS] },
  {
    name: "provider",
    label: "Provider",
    type: "enum",
    options: [...VIDEO_GENERATION_PROVIDER_IDS],
  },
  { name: "model", label: "Model", type: "string" },
]

export interface ParsedVideoArgs {
  prompt: string
  durationSec?: number
  aspectRatio?: `${number}:${number}`
  resolution?: `${number}x${number}`
  providerId?: string
  model?: string
}

const FLAG = /(?:^|\s)--([a-zA-Z-]+)(?:\s+(\S+))?/g

/** Extract the flags anywhere in the line; the rest, in order, is the prompt. */
export function parseVideoArgs(raw: string): ParsedVideoArgs {
  const out: Omit<ParsedVideoArgs, "prompt"> = {}
  const prompt = raw
    .replace(FLAG, (_match, rawFlag: string, value: string | undefined) => {
      const flag = rawFlag.toLowerCase()
      if (!value || value.startsWith("--")) throw new Error(`--${flag} requires a value`)
      switch (flag) {
        case "duration": {
          const seconds = Number(value)
          if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new Error("--duration must be a positive number of seconds")
          }
          out.durationSec = seconds
          break
        }
        case "aspect":
          if (!/^\d+:\d+$/.test(value)) throw new Error("--aspect must look like 16:9")
          out.aspectRatio = value as `${number}:${number}`
          break
        case "resolution":
          if (!/^\d+x\d+$/.test(value)) throw new Error("--resolution must look like 1280x720")
          out.resolution = value as `${number}x${number}`
          break
        case "provider":
          out.providerId = value
          break
        case "model":
          out.model = value
          break
        default:
          throw new Error(`Unknown flag: --${flag}`)
      }
      return " "
    })
    .replace(/\s+/g, " ")
    .trim()
  return { prompt, ...out }
}

export interface VideoCommandDeps extends Pick<
  MediaToolDeps,
  "start" | "settings" | "configuredProviders" | "projectIdOf"
> {
  /** Read a staged file's bytes (its composer `blob:` URL). */
  readStaged(url: string): Promise<Blob>
  /** Store the start frame as an asset of the conversation. */
  saveFrame(input: {
    sessionId: string
    assetId: string
    blob: Blob
    filename: string
    mediaType: string
  }): Promise<void>
  /** Drop a stored start frame again when the job did not start. */
  releaseFrame(sessionId: string, assetId: string): Promise<void>
  newFrameId(): string
  /** Put the job's card into the conversation and its transcript. */
  postCard(sessionId: string, jobId: string): Promise<void>
}

async function resolveVideoCommandDeps(): Promise<VideoCommandDeps> {
  const [{ resolveMediaToolDeps }, assets, card] = await Promise.all([
    import("@/lib/claude/media-builtin-tools"),
    import("@/lib/db/session-assets"),
    import("@/lib/chat/video-job-card"),
  ])
  const media = await resolveMediaToolDeps()
  return {
    start: media.start,
    settings: media.settings,
    configuredProviders: media.configuredProviders,
    projectIdOf: media.projectIdOf,
    readStaged: async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error("The staged image could not be read.")
      return response.blob()
    },
    saveFrame: async (input) => {
      await assets.putSessionAsset(input)
    },
    releaseFrame: (sessionId, assetId) => assets.releaseSessionAsset(sessionId, assetId),
    newFrameId: () =>
      `video-frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    postCard: card.postVideoJobCard,
  }
}

export async function handleVideoCommand(
  ctx: SlashContext,
  injected?: VideoCommandDeps
): Promise<void> {
  // Taken before anything can refuse: the user staged it for this video, and
  // an image left staged would go to the chat model as a turn of its own.
  const image = ctx.stagedFiles?.find((file) => file.mediaType.startsWith("image/"))
  if (image) ctx.consumeStagedFiles?.([image.id])

  const sessionId = ctx.activeSessionId
  if (!sessionId) {
    ctx.pushSystemMessage(
      "Start a chat session first — `/video` puts the video into a conversation."
    )
    return
  }
  let args: ParsedVideoArgs
  try {
    args = parseVideoArgs(ctx.args)
  } catch (error) {
    ctx.pushSystemMessage(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`)
    return
  }
  if (!args.prompt) {
    ctx.pushSystemMessage(USAGE)
    return
  }

  const deps = injected ?? (await resolveVideoCommandDeps())
  let startFrame: VideoJobStartFrameInput | undefined
  let frameAssetId: string | undefined
  if (image) {
    try {
      const blob = await deps.readStaged(image.url)
      frameAssetId = deps.newFrameId()
      await deps.saveFrame({
        sessionId,
        assetId: frameAssetId,
        blob,
        filename: image.filename ?? `${frameAssetId}.png`,
        mediaType: blob.type || image.mediaType,
      })
      startFrame = { kind: "session-asset", assetId: frameAssetId }
    } catch (error) {
      ctx.pushSystemMessage(
        `Could not use the staged image: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
  }

  let jobId: string | undefined
  try {
    const { applyVideoDefaults } = await import("@/lib/ai/media/video-jobs/defaults")
    const selection = applyVideoDefaults(
      deps.settings(),
      {
        providerId: args.providerId,
        model: args.model,
        durationSec: args.durationSec,
        aspectRatio: args.aspectRatio,
        resolution: args.resolution,
      },
      deps.configuredProviders()
    )
    const projectId = await deps.projectIdOf(sessionId)
    const started = await deps.start({
      prompt: args.prompt,
      ...(startFrame ? { startFrame } : {}),
      ...(selection.providerId ? { providerId: selection.providerId } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      params: selection.params,
      origin: { surface: "slash", sessionId },
      ...(projectId ? { projectId } : {}),
    })
    if (!started.ok) {
      ctx.pushSystemMessage(`Could not start the video: ${started.error.message}`)
      return
    }
    jobId = started.job.id
  } finally {
    // A frame stored for a job that never started belongs to nothing.
    if (!jobId && frameAssetId) {
      await deps.releaseFrame(sessionId, frameAssetId).catch(() => undefined)
    }
  }
  await deps.postCard(sessionId, jobId)
}
