import { createFal } from "@ai-sdk/fal"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createFireworks } from "@ai-sdk/fireworks"
import { createReplicate } from "@ai-sdk/replicate"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createXai } from "@ai-sdk/xai"
import { createByteDance } from "@ai-sdk/bytedance"
import { createOpenAI } from "@ai-sdk/openai"
import { createAlibaba } from "@ai-sdk/alibaba"
import type { Experimental_VideoModelV3, ImageModelV3 } from "@ai-sdk/provider"
import { experimental_generateVideo, generateImage } from "ai"
import { hasNoLeakingPii } from "@cognia/redact"
import { getBuiltInProviderDefaultBaseURL } from "@cognia/provider-types/built-in-provider-catalog"

import {
  createFeatureProviderClient,
  resolveFeatureProvider,
  type ProviderSettingsSnapshot,
  type ResolvedProvider,
} from "@/lib/ai/provider-consumption"
import { resolveImageModel, type ImageProviderId } from "./image-generation-sdk"
import {
  VIDEO_GENERATION_PROVIDER_IDS,
  isSupportedVideoProvider,
  resolveVideoModel,
  type VideoProviderId,
} from "./video-generation-sdk"

export const IMAGE_GENERATION_PROVIDER_IDS = [
  "openai",
  "azure",
  "bedrock",
  "google",
  "xai",
  "togetherai",
  "fireworks",
  "deepinfra",
  "fal",
  "replicate",
  "nvidia",
  "doubao",
  "volcengine",
] as const satisfies readonly ImageProviderId[]

export type ImageGenerationProviderId = (typeof IMAGE_GENERATION_PROVIDER_IDS)[number]

export type ProviderImagePrompt = Parameters<typeof generateImage>[0]["prompt"]
export type ProviderVideoPrompt = Parameters<typeof experimental_generateVideo>[0]["prompt"]

export interface ProviderImageGenerationRequest {
  snapshot: ProviderSettingsSnapshot
  prompt: ProviderImagePrompt
  providerId?: ImageGenerationProviderId
  model?: string
  n?: number
  size?: `${number}x${number}`
  aspectRatio?: `${number}:${number}`
  seed?: number
  providerOptions?: Parameters<typeof generateImage>[0]["providerOptions"]
  abortSignal?: AbortSignal
}

export interface ProviderVideoGenerationRequest {
  snapshot: ProviderSettingsSnapshot
  prompt: ProviderVideoPrompt
  providerId?: VideoProviderId
  model?: string
  n?: number
  aspectRatio?: `${number}:${number}`
  resolution?: `${number}x${number}`
  duration?: number
  fps?: number
  seed?: number
  providerOptions?: Parameters<typeof experimental_generateVideo>[0]["providerOptions"]
  abortSignal?: AbortSignal
}

export type MediaGenerationErrorCode =
  "UNSUPPORTED_PROVIDER" | "NO_PROVIDER" | "PROVIDER_CONFIGURATION" | "PII_BLOCKED"

export class MediaGenerationError extends Error {
  constructor(
    public readonly code: MediaGenerationErrorCode,
    message: string,
    public readonly providerId?: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = "MediaGenerationError"
  }
}

function promptText(prompt: ProviderImagePrompt | ProviderVideoPrompt): string | undefined {
  return typeof prompt === "string" ? prompt : prompt.text
}

function assertSafePrompt(prompt: ProviderImagePrompt | ProviderVideoPrompt): void {
  const text = promptText(prompt)
  if (text && !hasNoLeakingPii(text)) {
    throw new MediaGenerationError(
      "PII_BLOCKED",
      "Media generation prompt failed the outbound PII gate."
    )
  }
}

function resolveMediaProvider(
  snapshot: ProviderSettingsSnapshot,
  modality: "image" | "video",
  preferredProviderId?: string
): ResolvedProvider {
  const supportedProviderIds =
    modality === "image" ? [...IMAGE_GENERATION_PROVIDER_IDS] : [...VIDEO_GENERATION_PROVIDER_IDS]

  if (
    preferredProviderId &&
    !(modality === "image"
      ? (IMAGE_GENERATION_PROVIDER_IDS as readonly string[]).includes(preferredProviderId)
      : isSupportedVideoProvider(preferredProviderId))
  ) {
    throw new MediaGenerationError(
      "UNSUPPORTED_PROVIDER",
      `Provider "${preferredProviderId}" does not support ${modality} generation.`,
      preferredProviderId
    )
  }

  const defaultProvider =
    snapshot.defaultProvider &&
    supportedProviderIds.some((providerId) => providerId === snapshot.defaultProvider)
      ? snapshot.defaultProvider
      : undefined
  const candidates = preferredProviderId
    ? [preferredProviderId]
    : (Array.from(new Set([defaultProvider, ...supportedProviderIds].filter(Boolean))) as string[])

  const resolution = resolveFeatureProvider(
    {
      featureId: `${modality}-generation`,
      routeProfile: "capability-bound",
      selectionMode: "supported-providers",
      supportedProviders: candidates,
      fallbackMode: "none",
      executionMode: "client",
      proxyMode: "preferred",
    },
    snapshot
  )

  if (resolution.kind !== "resolved") {
    throw new MediaGenerationError(
      "NO_PROVIDER",
      resolution.reason,
      preferredProviderId,
      resolution
    )
  }
  return resolution
}

function clientSettings(resolved: ResolvedProvider): {
  apiKey?: string
  baseURL?: string
} {
  return {
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
  }
}

function normalizedSpecializedBaseURL(resolved: ResolvedProvider): string | undefined {
  if (
    resolved.providerId === "fal" &&
    resolved.baseURL === getBuiltInProviderDefaultBaseURL("fal")
  ) {
    return "https://fal.run"
  }
  return resolved.baseURL
}

function createProviderImageModel(resolved: ResolvedProvider, requestedModel?: string) {
  const providerId = resolved.providerId as ImageGenerationProviderId
  const modelId = resolveImageModel(providerId, requestedModel ?? resolved.model)
  const baseURL = normalizedSpecializedBaseURL(resolved)

  switch (providerId) {
    case "xai":
      return createXai({ apiKey: resolved.apiKey, baseURL }).image(modelId)
    case "togetherai":
      return createTogetherAI({ apiKey: resolved.apiKey, baseURL }).image(modelId)
    case "fireworks":
      return createFireworks({ apiKey: resolved.apiKey, baseURL }).image(modelId)
    case "deepinfra":
      return createDeepInfra({ apiKey: resolved.apiKey, baseURL }).image(modelId)
    case "fal":
      return createFal({ apiKey: resolved.apiKey, baseURL }).image(modelId)
    case "replicate":
      return createReplicate({ apiToken: resolved.apiKey, baseURL }).image(modelId)
    case "nvidia": {
      const catalogBaseURL = getBuiltInProviderDefaultBaseURL("nvidia")
      if (resolved.baseURL === catalogBaseURL) {
        throw new MediaGenerationError(
          "PROVIDER_CONFIGURATION",
          "NVIDIA image generation requires a Visual GenAI NIM OpenAI-compatible base URL.",
          providerId
        )
      }
      return createOpenAI(clientSettings(resolved)).image(modelId)
    }
    case "doubao":
    case "volcengine":
      return createByteDance(clientSettings(resolved)).image(modelId)
    case "openai":
    case "azure":
    case "bedrock":
    case "google": {
      const client = createFeatureProviderClient({
        providerId: resolved.providerId,
        protocol: resolved.protocol,
        apiKey: resolved.apiKey,
        baseURL: resolved.baseURL,
        bedrock: resolved.bedrock,
        isCustomProvider: resolved.isCustomProvider,
        useProxy: resolved.useProxy,
      }) as unknown as { image: (model: string) => ImageModelV3 }
      return client.image(modelId)
    }
  }
}

function createProviderVideoModel(resolved: ResolvedProvider, requestedModel?: string) {
  const providerId = resolved.providerId as VideoProviderId
  const modelId = resolveVideoModel(providerId, requestedModel ?? resolved.model)
  const baseURL = normalizedSpecializedBaseURL(resolved)

  switch (providerId) {
    case "google": {
      const client = createFeatureProviderClient({
        providerId: resolved.providerId,
        protocol: resolved.protocol,
        apiKey: resolved.apiKey,
        baseURL: resolved.baseURL,
        isCustomProvider: resolved.isCustomProvider,
        useProxy: resolved.useProxy,
      }) as unknown as { video: (model: string) => Experimental_VideoModelV3 }
      return client.video(modelId)
    }
    case "xai":
      return createXai({ apiKey: resolved.apiKey, baseURL }).video(modelId)
    case "fal":
      return createFal({ apiKey: resolved.apiKey, baseURL }).video(modelId)
    case "replicate":
      return createReplicate({ apiToken: resolved.apiKey, baseURL }).video(modelId)
    case "doubao":
    case "volcengine":
      return createByteDance(clientSettings(resolved)).video(modelId)
    case "qwen":
      return createAlibaba({
        ...clientSettings(resolved),
        videoBaseURL: resolved.baseURL?.replace(/\/compatible-mode\/v1\/?$/, ""),
      }).video(modelId)
  }
}

export async function generateProviderImage(request: ProviderImageGenerationRequest) {
  assertSafePrompt(request.prompt)
  const resolved = resolveMediaProvider(request.snapshot, "image", request.providerId)
  const model = createProviderImageModel(resolved, request.model)

  return generateImage({
    model,
    prompt: request.prompt,
    ...(request.n !== undefined ? { n: request.n } : {}),
    ...(request.size ? { size: request.size } : {}),
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
  })
}

export async function generateProviderVideo(request: ProviderVideoGenerationRequest) {
  assertSafePrompt(request.prompt)
  const resolved = resolveMediaProvider(request.snapshot, "video", request.providerId)
  const model = createProviderVideoModel(resolved, request.model)

  return experimental_generateVideo({
    model,
    prompt: request.prompt,
    ...(request.n !== undefined ? { n: request.n } : {}),
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    ...(request.resolution ? { resolution: request.resolution } : {}),
    ...(request.duration !== undefined ? { duration: request.duration } : {}),
    ...(request.fps !== undefined ? { fps: request.fps } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
    ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
  })
}
