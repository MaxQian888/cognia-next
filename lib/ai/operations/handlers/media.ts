/**
 * `images.generate`, `videos.generate`, `speech.generate` and
 * `transcription.create`.
 *
 * Image and video generation for the vendors the media module already
 * drives go through `generateProviderImage` / `generateProviderVideo`, so the
 * plugin media API and this executor share one code path (the module keeps
 * its own prompt gate because the plugin API calls it directly). Every
 * other vendor is served through its AI SDK client's optional factories,
 * and a client without the factory fails typed as `capability-unsupported`.
 *
 * A generated video is registered as a locally completed job so `videos.get`
 * and `videos.content` can answer for it through the pinned handle.
 */

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
import type { ProviderResourceHandle } from "@cognia/provider-types"

import { makeResourceHandle, providerJobRegistry } from "../job-handle"
import type { ProviderOperationHandlerRegistration } from "../registry"
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
import { providerSdkClient, requireModelFactory, requireModelId } from "./sdk-client"

export interface GeneratedMediaFile {
  base64: string
  mimeType: string
}

interface GeneratedFileLike {
  base64: string
  mediaType: string
}

function fileOf(file: GeneratedFileLike): GeneratedMediaFile {
  return { base64: file.base64, mimeType: file.mediaType }
}

// ---- images ---------------------------------------------------------------------

export interface ImagesGenerateInput {
  model?: string
  prompt: string
  n?: number
  size?: `${number}x${number}`
  aspectRatio?: `${number}:${number}`
  seed?: number
}

export interface ImagesGenerateOutput {
  images: GeneratedMediaFile[]
}

function imageOptions(input: ImagesGenerateInput) {
  return {
    ...(input.n !== undefined ? { n: input.n } : {}),
    ...(input.size ? { size: input.size } : {}),
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
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
        ...(request.input.model ? { model: request.input.model } : {}),
        ...imageOptions(request.input),
        ...(signal ? { abortSignal: signal } : {}),
      })
      return { images: result.images.map(fileOf) }
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
    return { images: result.images.map(fileOf) }
  },
}

// ---- videos ---------------------------------------------------------------------

export interface VideosGenerateInput {
  model?: string
  prompt: string
  n?: number
  aspectRatio?: `${number}:${number}`
  resolution?: `${number}x${number}`
  duration?: number
  fps?: number
  seed?: number
}

export interface VideosGenerateOutput {
  handle: ProviderResourceHandle
  status: "succeeded"
  videos: GeneratedMediaFile[]
}

function videoOptions(input: VideosGenerateInput) {
  return {
    ...(input.n !== undefined ? { n: input.n } : {}),
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.duration !== undefined ? { duration: input.duration } : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  }
}

/** Register a synchronously produced video as a completed job and hand back its handle. */
export function recordLocalVideoJob(
  provider: ResolvedProvider,
  deploymentRef: string | undefined,
  videos: GeneratedMediaFile[],
  now = Date.now()
): VideosGenerateOutput {
  const handle = makeResourceHandle({
    kind: "video",
    id: `local-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    providerId: provider.providerId,
    deploymentRef,
    apiKey: provider.apiKey,
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
        ...(request.input.model ? { model: request.input.model } : {}),
        ...videoOptions(request.input),
        ...(signal ? { abortSignal: signal } : {}),
      })
      return recordLocalVideoJob(provider, request.deploymentRef, result.videos.map(fileOf))
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
    return recordLocalVideoJob(provider, request.deploymentRef, result.videos.map(fileOf))
  },
}

// ---- speech ---------------------------------------------------------------------

export interface SpeechGenerateInput {
  model?: string
  text: string
  voice?: string
  outputFormat?: string
  instructions?: string
  speed?: number
  language?: string
}

export interface SpeechGenerateOutput {
  audio: GeneratedMediaFile
}

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
    const result = await generateSpeechGated({
      model: make(requireModelId(provider, input.model)),
      text: input.text,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    })
    return { audio: fileOf(result.audio) }
  },
}

// ---- transcription --------------------------------------------------------------

export interface TranscriptionCreateInput {
  model?: string
  /** Base64 audio bytes. */
  audioBase64: string
}

export interface TranscriptionCreateOutput {
  text: string
  language?: string
  durationInSeconds?: number
  segments: Array<{ text: string; startSecond: number; endSecond: number }>
}

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
      audio: request.input.audioBase64,
      ...(signal ? { abortSignal: signal } : {}),
    })
    return {
      text: result.text,
      ...(result.language ? { language: result.language } : {}),
      ...(result.durationInSeconds !== undefined
        ? { durationInSeconds: result.durationInSeconds }
        : {}),
      segments: result.segments.map((segment) => ({
        text: segment.text,
        startSecond: segment.startSecond,
        endSecond: segment.endSecond,
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
