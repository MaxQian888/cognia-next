/**
 * The agent's video generation tools (ADR-0205, delivery step 2).
 *
 * `video_generate` starts a durable video job and returns its id at once: a
 * provider takes minutes, and a renderer-relayed tool call times out long
 * before that. The job keeps going in the background (the reconciler checks
 * it, reloads included) and its card in the tool result shows progress and,
 * when it lands, the video. `video_status` reads a job back for the agent.
 * Nothing starts an agent turn when a job finishes (G4).
 *
 * Both names were declared in `BuiltInToolName` long before they existed; the
 * `DECLARED_MEDIA_TOOLS` pin in `types/agent/tool.test.ts` keeps the union and
 * this manifest one fact.
 *
 * ## Import discipline
 *
 * Static imports here are TYPE-ONLY: `plugin-tool-ipc` is imported by the Node
 * CLI, which has no DOM, so the job engine, Dexie and the settings store are
 * reached through `await import()` at call time. The CLI never offers these
 * tools (`build-options.ts` gates them on a chat surface with a dock).
 */

import type { VideoGenerationSettings } from "@cognia/agent-config-types"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { UIMessage } from "ai"

import type {
  StartVideoJobInput,
  StartVideoJobResult,
  VideoJobStartFrameInput,
} from "@/lib/ai/media/video-jobs/engine"
import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"
import type { VideoProviderId } from "@/lib/ai/media/video-generation-sdk"

export const MEDIA_BUILTIN_PLUGIN_ID = "cognia-media-builtin"

export const VIDEO_GENERATE_TOOL_NAME = "video_generate"
export const VIDEO_STATUS_TOOL_NAME = "video_status"

export const MEDIA_TOOL_NAMES = [VIDEO_GENERATE_TOOL_NAME, VIDEO_STATUS_TOOL_NAME] as const

const MEDIA_TOOL_NAME_SET: ReadonlySet<string> = new Set(MEDIA_TOOL_NAMES)

export function isMediaBuiltinTool(name: string): boolean {
  return MEDIA_TOOL_NAME_SET.has(name)
}

/** `image` value that picks the newest image in the conversation. */
export const LATEST_IMAGE = "latest"

const MAX_PROMPT_CHARS = 4000
const MEDIA_REF_PREFIX = "cognia-media:"

export interface MediaManifestEntry {
  name: string
  pluginId: string
  description: string
  jsonSchema: Record<string, unknown>
}

export function buildMediaManifestEntries(): MediaManifestEntry[] {
  return [
    {
      name: VIDEO_GENERATE_TOOL_NAME,
      pluginId: MEDIA_BUILTIN_PLUGIN_ID,
      description:
        "Start generating a short video from a text prompt, optionally animating an image from this conversation. Returns a job id immediately; generation takes minutes and continues in the background, and the video appears in the chat when it is ready. Do not poll in a loop: check once with video_status only if the user asks. Unset options use the user's defaults from Settings → Media generation.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PROMPT_CHARS,
            description: "What the video shows: subject, action, camera, style.",
          },
          image: {
            type: "string",
            minLength: 1,
            maxLength: 512,
            description: `Start frame. "${LATEST_IMAGE}" uses the newest image in this conversation; otherwise a cognia-media: reference or an attachment id from attachment_list.`,
          },
          durationSec: { type: "number", exclusiveMinimum: 0, maximum: 60 },
          aspectRatio: { type: "string", pattern: "^\\d+:\\d+$" },
          resolution: { type: "string", pattern: "^\\d+x\\d+$" },
          providerId: {
            type: "string",
            pattern: "^[a-z]{1,32}$",
            description: "A configured video provider id; omit to use the user's default.",
          },
          model: {
            type: "string",
            pattern: "^[\\w.:/-]{1,128}$",
            description: "Model id for the provider; omit for its default.",
          },
        },
      },
    },
    {
      name: VIDEO_STATUS_TOOL_NAME,
      pluginId: MEDIA_BUILTIN_PLUGIN_ID,
      description:
        "Read a video job started in this conversation: generating, succeeded (with the stored video's size and duration), failed, cancelled or timed_out, with a failure code.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["jobId"],
        properties: { jobId: { type: "string", minLength: 1, maxLength: 128 } },
      },
    },
  ]
}

export type MediaToolFailureCode =
  | "invalid_arguments"
  | "session_required"
  | "no_image"
  | "not_found"
  | "internal_error"
  | import("@/lib/ai/media/video-jobs/types").VideoJobErrorCode

interface Failure {
  ok: false
  code: MediaToolFailureCode
  error: string
}

function fail(code: MediaToolFailureCode, error: string): Failure {
  return { ok: false, code, error }
}

export interface MediaToolContext {
  sessionId: string
}

export interface MediaToolDeps {
  start(input: StartVideoJobInput): Promise<StartVideoJobResult>
  getJob(jobId: string): Promise<MediaGenerationJobRow | undefined>
  settings(): VideoGenerationSettings | undefined
  /** Configured providers this shell can reach, in the defaults' terms. */
  configuredProviders(): VideoProviderId[]
  listMessages(sessionId: string): Promise<UIMessage[]>
  projectIdOf(sessionId: string): Promise<string | undefined>
}

let testDepsFactory: (() => MediaToolDeps) | null = null

/** Test seam, mirroring `__setPetToolDepsForTesting`. */
export function __setMediaToolDepsForTesting(factory: (() => MediaToolDeps) | null): void {
  testDepsFactory = factory
}

/** Resolve the renderer dependencies; everything is reached lazily (see header). */
export async function resolveMediaToolDeps(): Promise<MediaToolDeps> {
  if (testDepsFactory) return testDepsFactory()
  const [rendererHost, host, defaults, settingsStore, providers, network, messages, sessions] =
    await Promise.all([
      import("@/lib/ai/media/video-jobs/renderer-host"),
      import("@/lib/ai/media/video-jobs/host"),
      import("@/lib/ai/media/video-jobs/defaults"),
      import("@/stores/settings"),
      import("@/lib/ai/provider-consumption"),
      import("@/lib/network/platform-fetch"),
      import("@/lib/db/messages"),
      import("@/lib/db/sessions"),
    ])
  rendererHost.ensureRendererVideoJobHost()
  const live = () => settingsStore.useSettingsStore.getState().settings
  return {
    start: (input) => host.getVideoJobEngine().start(input),
    getJob: (jobId) => host.getVideoJobHost().store.get(jobId),
    settings: () => live()?.videoGeneration,
    configuredProviders: () => {
      const settings = live()
      const snapshot = providers.createProviderSettingsSnapshot({
        defaultProvider: settings?.defaultProvider,
        providerSettings: settings?.providerSettings,
        customProviders: settings?.customProviders,
      })
      return defaults
        .listConfiguredVideoProviders(snapshot, network.reachesNonCorsHosts())
        .filter((provider) => provider.reachable)
        .map((provider) => provider.providerId)
    },
    listMessages: (sessionId) => messages.listMessages(sessionId),
    projectIdOf: async (sessionId) => (await sessions.getSession(sessionId))?.projectId,
  }
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The newest image part in the conversation, as a media reference. */
function latestImageRef(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j] as { type?: string; mediaType?: string; url?: string }
      if (
        part.type === "file" &&
        part.mediaType?.startsWith("image/") &&
        part.url?.startsWith(MEDIA_REF_PREFIX)
      ) {
        return part.url
      }
    }
  }
  return undefined
}

async function startFrameOf(
  image: string,
  deps: MediaToolDeps,
  sessionId: string
): Promise<VideoJobStartFrameInput | Failure> {
  if (image === LATEST_IMAGE) {
    const ref = latestImageRef(await deps.listMessages(sessionId))
    if (!ref) return fail("no_image", "There is no image in this conversation to animate.")
    return { kind: "media", ref }
  }
  if (image.startsWith(MEDIA_REF_PREFIX)) return { kind: "media", ref: image }
  return { kind: "session-asset", assetId: image }
}

/**
 * Provider text goes back to the model. The engine scrubs it when storing; a
 * row written before that still must not turn a status read into a refusal of
 * the whole result by the relay's PII gate.
 */
function safeText(text: string): string {
  return hasNoLeakingPii(text) ? text : redactText(text).redacted
}

/** What the agent sees of a job; never the prompt it already wrote. */
function describeJob(row: MediaGenerationJobRow): Record<string, unknown> {
  return {
    ok: true,
    jobId: row.id,
    status: row.status,
    providerId: row.provider.providerId,
    model: row.provider.modelId,
    ...(row.error ? { code: row.error.code, error: safeText(row.error.message) } : {}),
    ...(row.status === "cancelled" ? { remoteCancelled: row.remoteCancelled === true } : {}),
    ...(row.result
      ? {
          video: {
            mediaType: row.result.mediaType,
            byteSize: row.result.byteSize,
            ...(row.result.durationSec !== undefined
              ? { durationSec: row.result.durationSec }
              : {}),
            ...(row.result.width !== undefined ? { width: row.result.width } : {}),
            ...(row.result.height !== undefined ? { height: row.result.height } : {}),
          },
        }
      : {}),
    ...(row.warnings?.length ? { warnings: row.warnings.map(safeText) } : {}),
  }
}

/**
 * Run one media tool. Never throws: every failure is an `ok: false` envelope
 * the model can read and adapt to (see the note in `plugin-tool-ipc.ts`).
 */
export async function runMediaBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: MediaToolDeps,
  context: MediaToolContext
): Promise<unknown> {
  if (!context.sessionId.trim()) {
    return fail("session_required", "Video jobs belong to a conversation.")
  }
  try {
    switch (name) {
      case VIDEO_GENERATE_TOOL_NAME: {
        const prompt = str(args, "prompt")
        if (!prompt) return fail("invalid_arguments", "prompt is required")
        if (prompt.length > MAX_PROMPT_CHARS) {
          return fail("invalid_arguments", `prompt must be ${MAX_PROMPT_CHARS} characters or fewer`)
        }
        const image = str(args, "image")
        let startFrame: VideoJobStartFrameInput | undefined
        if (image) {
          const frame = await startFrameOf(image, deps, context.sessionId)
          if ("ok" in frame) return frame
          startFrame = frame
        }
        const { applyVideoDefaults } = await import("@/lib/ai/media/video-jobs/defaults")
        const selection = applyVideoDefaults(
          deps.settings(),
          {
            providerId: str(args, "providerId"),
            model: str(args, "model"),
            durationSec: num(args, "durationSec"),
            aspectRatio: str(args, "aspectRatio") as `${number}:${number}` | undefined,
            resolution: str(args, "resolution") as `${number}x${number}` | undefined,
          },
          deps.configuredProviders()
        )
        const projectId = await deps.projectIdOf(context.sessionId)
        const started = await deps.start({
          prompt,
          ...(startFrame ? { startFrame } : {}),
          ...(selection.providerId ? { providerId: selection.providerId } : {}),
          ...(selection.model ? { model: selection.model } : {}),
          params: selection.params,
          origin: { surface: "chat-tool", sessionId: context.sessionId },
          ...(projectId ? { projectId } : {}),
        })
        if (!started.ok) return fail(started.error.code, started.error.message)
        return describeJob(started.job)
      }

      case VIDEO_STATUS_TOOL_NAME: {
        const jobId = str(args, "jobId")
        if (!jobId) return fail("invalid_arguments", "jobId is required")
        const row = await deps.getJob(jobId)
        // A job from another conversation is not this agent's to read.
        if (!row || row.sessionId !== context.sessionId) {
          return fail("not_found", `No video job "${jobId}" in this conversation.`)
        }
        return describeJob(row)
      }

      default:
        return fail("invalid_arguments", `Unknown media tool "${name}"`)
    }
  } catch (error) {
    return fail("internal_error", error instanceof Error ? error.message : String(error))
  }
}
