/**
 * `images.generate`, `videos.generate`, `speech.generate` and
 * `transcription.create`, in the contract shapes.
 *
 * Image and video generation for the vendors the media module already
 * drives go through `generateProviderImage` / `generateProviderVideo`, so the
 * plugin media API and this executor share one code path (the module keeps
 * its own prompt gate because the plugin API calls it directly). Every
 * other vendor is served through its AI SDK client's optional factories,
 * and a client without the factory fails typed as `capability-unsupported`.
 *
 * A generated video is registered as a locally completed job so `videos.get`
 * and `videos.content` can answer for it through the pinned handle. Vendor
 * knobs the contract does not name (`n`, `seed`, `resolution`, `fps`) ride
 * `extra`.
 */

import type { z } from "zod"
import type {
  imagesGenerateInput,
  imagesGenerateOutput,
  speechGenerateInput,
  speechGenerateOutput,
  transcriptionCreateInput,
  transcriptionCreateOutput,
  videosGenerateInput,
  videosGenerateOutput,
} from "@cognia/provider-types"
import {
  IMAGE_GENERATION_PROVIDER_IDS,
  generateProviderImage,
  generateProviderVideo,
  type ImageGenerationProviderId,
} from "@/lib/ai/media/provider-generation"
import {
  VIDEO_GENERATION_PROVIDER_IDS,
  type VideoProviderId,
} from "@/lib/ai/media/video-generation-sdk"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import { providerJobRegistry } from "../job-handle"
import type { ProviderOperationHandlerRegistration } from "../registry"
import { handleFor } from "../resource-handle"
import {
  generateImageGated,
  generateSpeechGated,
  generateVideoGated,
  transcribeGated,
  type GenerateImageArgs,
  type GenerateSpeechArgs,
  type GenerateVideoArgs,
  type TranscribeArgs,
} from "./ai-sdk-surface"
import { bytesRefOfGenerated, dataContentOf, type BytesRef } from "./bytes"
import { providerSdkClient, requireModelFactory, requireModelId } from "./sdk-client"

export type ImagesGenerateInput = z.infer<typeof imagesGenerateInput>
export type ImagesGenerateOutput = z.infer<typeof imagesGenerateOutput>
export type VideosGenerateInput = z.infer<typeof videosGenerateInput>
export type SpeechGenerateInput = z.infer<typeof speechGenerateInput>
export type SpeechGenerateOutput = z.infer<typeof speechGenerateOutput>
export type TranscriptionCreateInput = z.infer<typeof transcriptionCreateInput>
export type TranscriptionCreateOutput = z.infer<typeof transcriptionCreateOutput>

/** The contract output plus the bytes, which the job registry also keeps. */
export interface VideosGenerateOutput extends z.infer<typeof videosGenerateOutput> {
  videos: BytesRef[]
}

type Size = `${number}x${number}`
type Ratio = `${number}:${number}`

function sizeOf(value: string | undefined): Size | undefined {
  if (value === undefined) return undefined
  if (!/^\d+x\d+$/.test(value)) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: `size must look like 1024x1024, got "${value}"`,
    })
  }
  return value as Size
}

function ratioOf(value: string | undefined): Ratio | undefined {
  if (value === undefined) return undefined
  if (!/^\d+:\d+$/.test(value)) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: `aspectRatio must look like 16:9, got "${value}"`,
    })
  }
  return value as Ratio
}

function numberExtra(extra: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = extra?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// ---- images ---------------------------------------------------------------------

function imageOptions(input: ImagesGenerateInput) {
  const size = sizeOf(input.size)
  const aspectRatio = ratioOf(input.aspectRatio)
  const seed = numberExtra(input.extra, "seed")
  return {
    ...(input.n !== undefined ? { n: input.n } : {}),
    ...(size ? { size } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(seed !== undefined ? { seed } : {}),
  }
}

function mediaModuleImageHandler(
  providerId: ImageGenerationProviderId
): ProviderOperationHandlerRegistration<ImagesGenerateInput, ImagesGenerateOutput> {
  return {
    operationId: "images.generate",
    providerMatch: { kind: "provider", providerId },
    support: "native",
    async handler({ settings, request, signal }) {
      const result = await generateProviderImage({
        snapshot: settings,
        prompt: request.input.prompt,
        providerId,
        model: request.input.model,
        ...imageOptions(request.input),
        ...(signal ? { abortSignal: signal } : {}),
      })
      return { images: result.images.map(bytesRefOfGenerated) }
    },
  }
}

export const imagesGenerateSdkHandler: ProviderOperationHandlerRegistration<
  ImagesGenerateInput,
  ImagesGenerateOutput
> = {
  operationId: "images.generate",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const client = providerSdkClient(provider)
    const make = requireModelFactory<GenerateImageArgs["model"]>(
      client,
      provider,
      ["imageModel"],
      "image"
    )
    const result = await generateImageGated({
      model: make(requireModelId(provider, request.input.model)),
      prompt: request.input.prompt,
      ...imageOptions(request.input),
      ...(signal ? { abortSignal: signal } : {}),
    })
    return { images: result.images.map(bytesRefOfGenerated) }
  },
}

// ---- videos ---------------------------------------------------------------------

function videoOptions(input: VideosGenerateInput) {
  const aspectRatio = ratioOf(input.aspectRatio)
  const resolution =
    typeof input.extra?.resolution === "string" ? sizeOf(input.extra.resolution) : undefined
  const n = numberExtra(input.extra, "n")
  const fps = numberExtra(input.extra, "fps")
  const seed = numberExtra(input.extra, "seed")
  return {
    ...(n !== undefined ? { n } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(input.durationSeconds !== undefined ? { duration: input.durationSeconds } : {}),
    ...(fps !== undefined ? { fps } : {}),
    ...(seed !== undefined ? { seed } : {}),
  }
}

/** Register a synchronously produced video as a completed job and hand back its handle. */
export function recordLocalVideoJob(
  provider: ResolvedProvider,
  deploymentRef: string | undefined,
  videos: BytesRef[],
  now = Date.now()
): VideosGenerateOutput {
  const handle = handleFor({
    kind: "video",
    id: `local-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    owner: provider,
    deploymentRef,
    createdAt: now,
  })
  const first = videos[0]
  providerJobRegistry.register(
    {
      handle,
      status: "succeeded",
      ...(first ? { content: { base64: first.base64, mimeType: first.mimeType } } : {}),
    },
    now
  )
  return { handle, status: "succeeded", videos }
}

function mediaModuleVideoHandler(
  providerId: VideoProviderId
): ProviderOperationHandlerRegistration<VideosGenerateInput, VideosGenerateOutput> {
  return {
    operationId: "videos.generate",
    providerMatch: { kind: "provider", providerId },
    support: "native",
    async handler({ provider, settings, request, signal }) {
      const result = await generateProviderVideo({
        snapshot: settings,
        prompt: request.input.prompt,
        providerId,
        model: request.input.model,
        ...videoOptions(request.input),
        ...(signal ? { abortSignal: signal } : {}),
      })
      return recordLocalVideoJob(
        provider,
        request.deploymentRef,
        result.videos.map(bytesRefOfGenerated)
      )
    },
  }
}

export const videosGenerateSdkHandler: ProviderOperationHandlerRegistration<
  VideosGenerateInput,
  VideosGenerateOutput
> = {
  operationId: "videos.generate",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const client = providerSdkClient(provider)
    const make = requireModelFactory<GenerateVideoArgs["model"]>(
      client,
      provider,
      ["videoModel"],
      "video"
    )
    const result = await generateVideoGated({
      model: make(requireModelId(provider, request.input.model)),
      prompt: request.input.prompt,
      ...videoOptions(request.input),
      ...(signal ? { abortSignal: signal } : {}),
    })
    return recordLocalVideoJob(
      provider,
      request.deploymentRef,
      result.videos.map(bytesRefOfGenerated)
    )
  },
}

// ---- speech ---------------------------------------------------------------------

export const speechGenerateHandler: ProviderOperationHandlerRegistration<
  SpeechGenerateInput,
  SpeechGenerateOutput
> = {
  operationId: "speech.generate",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const client = providerSdkClient(provider)
    const make = requireModelFactory<GenerateSpeechArgs["model"]>(
      client,
      provider,
      ["speechModel"],
      "speech"
    )
    const input = request.input
    const instructions =
      typeof input.extra?.instructions === "string" ? input.extra.instructions : undefined
    const language = typeof input.extra?.language === "string" ? input.extra.language : undefined
    const speed = numberExtra(input.extra, "speed")
    const result = await generateSpeechGated({
      model: make(requireModelId(provider, input.model)),
      text: input.text,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.format ? { outputFormat: input.format } : {}),
      ...(instructions ? { instructions } : {}),
      ...(speed !== undefined ? { speed } : {}),
      ...(language ? { language } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    })
    return { audio: bytesRefOfGenerated(result.audio) }
  },
}

// ---- transcription --------------------------------------------------------------

export const transcriptionCreateHandler: ProviderOperationHandlerRegistration<
  TranscriptionCreateInput,
  TranscriptionCreateOutput
> = {
  operationId: "transcription.create",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const client = providerSdkClient(provider)
    const make = requireModelFactory<TranscribeArgs["model"]>(
      client,
      provider,
      ["transcriptionModel"],
      "transcription"
    )
    const result = await transcribeGated({
      model: make(requireModelId(provider, request.input.model)),
      audio: dataContentOf(request.input.audio),
      ...(signal ? { abortSignal: signal } : {}),
    })
    return {
      text: result.text,
      ...(result.language ? { language: result.language } : {}),
      segments: result.segments.map((segment) => ({
        start: segment.startSecond,
        end: segment.endSecond,
        text: segment.text,
      })),
    }
  },
}

export const MEDIA_HANDLERS: ProviderOperationHandlerRegistration[] = [
  ...IMAGE_GENERATION_PROVIDER_IDS.map(mediaModuleImageHandler),
  imagesGenerateSdkHandler,
  ...VIDEO_GENERATION_PROVIDER_IDS.map(mediaModuleVideoHandler),
  videosGenerateSdkHandler,
  speechGenerateHandler,
  transcriptionCreateHandler,
] as ProviderOperationHandlerRegistration[]
