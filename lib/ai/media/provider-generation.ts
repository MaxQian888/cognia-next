import { createFal } from "@ai-sdk/fal"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createFireworks } from "@ai-sdk/fireworks"
import { createReplicate } from "@ai-sdk/replicate"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createXai } from "@ai-sdk/xai"
import { createByteDance } from "@ai-sdk/bytedance"
import { createOpenAI } from "@ai-sdk/openai"
import { createAlibaba } from "@ai-sdk/alibaba"
import type { Experimental_VideoModelV4, ImageModelV4, LanguageModelV4 } from "@ai-sdk/provider"
import { generateImage, type GenerateVideoPrompt } from "ai"
import { z } from "zod"
import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"
import { getBuiltInProviderDefaultBaseURL } from "@cognia/provider-types/built-in-provider-catalog"
import { resolveModelLifecycle } from "@cognia/provider-types/model-catalog"
import { getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import { withProviderTimeouts } from "@/lib/runtime/provider-timeout-fetch"

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
import { checkVideoJobParams } from "./video-jobs/params"
import type {
  ImageGenerationProviderId,
  ProviderImageGenerationRequest,
  ProviderImagePrompt,
} from "@cognia/plugin-contract/lib/ai/media/provider-generation"
export type {
  ImageGenerationProviderId,
  ProviderImageGenerationRequest,
  ProviderImagePrompt,
} from "@cognia/plugin-contract/lib/ai/media/provider-generation"

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

export type ProviderVideoPrompt = GenerateVideoPrompt

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

/** Outbound PII gate for a media prompt; throws `PII_BLOCKED`. */
export function assertSafeMediaPrompt(prompt: ProviderImagePrompt | ProviderVideoPrompt): void {
  const text = promptText(prompt)
  if (text && !hasNoLeakingPii(text)) {
    throw new MediaGenerationError(
      "PII_BLOCKED",
      "Media generation prompt failed the outbound PII gate."
    )
  }
}

/** Provider options include instructions, schema descriptions and verbatim keys. */
export function hasSafeMediaProviderOptions(value: unknown): boolean {
  return hasNoLeakingPiiDeep(value) && keysAreClean(value)
}

function keysAreClean(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (!value || typeof value !== "object") return true
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.every((item) => keysAreClean(item, seen))
  return Object.entries(value).every(
    ([key, child]) => hasNoLeakingPii(key) && keysAreClean(child, seen)
  )
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
  const lifecycle = resolveModelLifecycle(providerId, modelId)
  if (lifecycle.lifecycle === "retired") {
    throw new MediaGenerationError(
      "PROVIDER_CONFIGURATION",
      `Model "${modelId}" is retired.${lifecycle.replacementModelId ? ` Suggested replacement: ${lifecycle.replacementModelId}.` : ""}`,
      providerId
    )
  }
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
      }) as unknown as {
        image: (model: string) => ImageModelV4
        interactions: (model: string) => LanguageModelV4
      }
      if (providerId === "google" && modelId.startsWith("gemini-nano-banana-")) {
        return googleInteractionsImageModel(client.interactions(modelId), modelId)
      }
      return client.image(modelId)
    }
  }
}

/**
 * Resolve the provider a video job runs on: `preferredProviderId` when given
 * (it must be a video provider), else the default provider when it is one,
 * else the first configured video provider. Throws `UNSUPPORTED_PROVIDER` /
 * `NO_PROVIDER`.
 */
export function resolveVideoProvider(
  snapshot: ProviderSettingsSnapshot,
  preferredProviderId?: string
): ResolvedProvider {
  return resolveMediaProvider(snapshot, "video", preferredProviderId)
}

interface ProviderVideoModelOptions {
  /**
   * Transport for every request the model makes. Video providers are not on
   * the desktop WebView's `connect-src` allowlist, so the packaged app must
   * route them through the native bridge (`createPlatformFetch`).
   */
  fetch?: typeof globalThis.fetch
}

/**
 * Build the AI SDK video model for a resolved provider. Every supported
 * provider ships a v4 model with `doStart` / `doStatus`, which is what lets a
 * job be started now and checked from a later process.
 */
export function createProviderVideoModel(
  resolved: ResolvedProvider,
  requestedModel?: string,
  options: ProviderVideoModelOptions = {}
): Experimental_VideoModelV4 {
  const providerId = resolved.providerId as VideoProviderId
  const modelId = resolveVideoModel(providerId, requestedModel ?? resolved.model)
  const baseURL = normalizedSpecializedBaseURL(resolved)
  const fetch = options.fetch ? { fetch: options.fetch } : {}

  switch (providerId) {
    case "google": {
      if (modelId.startsWith("gemini-omni-")) {
        return googleInteractionsVideoModel(resolved, modelId, options.fetch)
      }
      const client = createFeatureProviderClient({
        providerId: resolved.providerId,
        protocol: resolved.protocol,
        apiKey: resolved.apiKey,
        baseURL: resolved.baseURL,
        isCustomProvider: resolved.isCustomProvider,
        useProxy: resolved.useProxy,
        ...fetch,
      }) as unknown as { video: (model: string) => Experimental_VideoModelV4 }
      return client.video(modelId)
    }
    case "xai":
      return createXai({ apiKey: resolved.apiKey, baseURL, ...fetch }).video(modelId)
    case "fal":
      return createFal({ apiKey: resolved.apiKey, baseURL, ...fetch }).video(modelId)
    case "replicate":
      return createReplicate({ apiToken: resolved.apiKey, baseURL, ...fetch }).video(modelId)
    case "doubao":
    case "volcengine":
      return createByteDance({ ...clientSettings(resolved), ...fetch }).video(modelId)
    case "qwen":
      return createAlibaba({
        ...clientSettings(resolved),
        videoBaseURL: resolved.baseURL?.replace(/\/compatible-mode\/v1\/?$/, ""),
        ...fetch,
      }).video(modelId)
  }
}

function base64(data: string | Uint8Array): string {
  if (typeof data === "string") return data
  let binary = ""
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Adapt Interactions multimodal output to the SDK image generation seam. */
function googleInteractionsImageModel(model: LanguageModelV4, modelId: string): ImageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "google.interactions.image",
    modelId,
    maxImagesPerCall: 1,
    supportsFileInputs: true,
    supportsMaskInputs: false,
    async doGenerate(options) {
      if (options.mask)
        throw new Error("Gemini image models do not support mask-based image editing.")
      const { imageConfig, responseFormat, ...google } = options.providerOptions.google ?? {}
      const config = (imageConfig ?? {}) as Record<string, string>
      const content: Array<
        Extract<
          Parameters<LanguageModelV4["doGenerate"]>[0]["prompt"][number],
          { role: "user" }
        >["content"][number]
      > = []
      if (options.prompt) content.push({ type: "text", text: options.prompt })
      for (const file of options.files ?? []) {
        content.push({
          type: "file",
          mediaType: file.type === "url" ? "image/*" : file.mediaType,
          data:
            file.type === "url"
              ? { type: "url", url: new URL(file.url) }
              : { type: "data", data: file.data },
        })
      }
      const result = await model.doGenerate({
        prompt: [{ role: "user", content }],
        seed: options.seed,
        abortSignal: options.abortSignal,
        headers: options.headers,
        providerOptions: {
          google: {
            ...google,
            store: false,
            background: false,
            responseFormat: responseFormat ?? [
              {
                type: "image",
                mimeType: "image/png",
                ...config,
                ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
              },
            ],
          },
        },
      })
      const images = result.content.flatMap((part) =>
        part.type === "file" && part.mediaType.startsWith("image/") && part.data.type === "data"
          ? [base64(part.data.data)]
          : []
      )
      return {
        images,
        warnings: [
          ...(result.warnings ?? []),
          ...(options.size
            ? [
                {
                  type: "unsupported" as const,
                  feature: "size",
                  details: "Use aspectRatio or google.imageConfig.imageSize.",
                },
              ]
            : []),
        ],
        response: { timestamp: new Date(), modelId, headers: result.response?.headers },
        usage: {
          inputTokens: result.usage.inputTokens.total,
          outputTokens: result.usage.outputTokens.total,
          totalTokens:
            (result.usage.inputTokens.total ?? 0) + (result.usage.outputTokens.total ?? 0),
        },
      }
    },
  }
}

const interactionSchema = z.object({
  id: z.string().optional(),
  status: z.enum(["in_progress", "requires_action", "completed", "failed", "cancelled"]),
  error: z.object({ message: z.string() }).nullish(),
  steps: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(
            z.object({
              type: z.string(),
              data: z.string().optional(),
              uri: z.string().optional(),
              mime_type: z.string().optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
})

/** Keep restartable video jobs while using Omni's Interactions contract. */
function googleInteractionsVideoModel(
  resolved: ResolvedProvider,
  modelId: string,
  fetchImpl?: typeof globalThis.fetch
): Experimental_VideoModelV4 {
  const baseURL = (resolved.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    ""
  )
  const transport = withProviderTimeouts(fetchImpl ?? getStreamingFetch())
  const responseInfo = (headers?: Record<string, string>) => ({
    timestamp: new Date(),
    modelId,
    headers,
  })
  async function request(path: string, init: RequestInit) {
    const headers = new Headers(init.headers)
    headers.set("Content-Type", "application/json")
    if (resolved.apiKey) headers.set("x-goog-api-key", resolved.apiKey)
    const response = await transport(`${baseURL}${path}`, { ...init, headers })
    if (!response.ok)
      throw new Error(`Google Interactions request failed (HTTP ${response.status}).`)
    return {
      value: interactionSchema.parse(await response.json()),
      headers: Object.fromEntries(response.headers),
    }
  }
  return {
    specificationVersion: "v4",
    provider: "google.interactions.video",
    modelId,
    maxVideosPerCall: 1,
    async doStart(options) {
      assertSafeMediaPrompt(options.prompt ?? "")
      const checked = checkVideoJobParams(
        "google",
        modelId,
        {
          durationSec: options.duration,
          aspectRatio: options.aspectRatio === "adaptive" ? undefined : options.aspectRatio,
          resolution: options.resolution,
          seed: options.seed,
          fps: options.fps,
        },
        Boolean(options.image)
      )
      if (!checked.ok) throw new Error(checked.message)
      if (
        options.n !== 1 ||
        options.frameImages?.length ||
        options.inputReferences?.length ||
        options.aspectRatio === "adaptive" ||
        options.generateAudio === false
      ) {
        throw new Error(
          "Omni supports one video, an optional start image, and native audio through this generation surface."
        )
      }
      if (Object.keys(options.providerOptions.google ?? {}).length) {
        throw new Error(
          "Veo provider options cannot be used with Gemini Omni; select Veo explicitly for its legacy controls."
        )
      }
      const image = options.image
      const input = image
        ? [
            {
              type: "image",
              ...(image.type === "url"
                ? { uri: image.url }
                : { data: base64(image.data), mime_type: image.mediaType }),
            },
            { type: "text", text: `<FIRST_FRAME> ${options.prompt ?? ""}` },
          ]
        : (options.prompt ?? "")
      const resolution = options.resolution
        ? (
            {
              "640x360": "360p",
              "1280x720": "720p",
              "1920x1080": "1080p",
              "3840x2160": "4k",
            } as Record<string, string>
          )[options.resolution]
        : undefined
      const { value, headers } = await request("/interactions", {
        method: "POST",
        signal: options.abortSignal,
        headers: options.headers as Record<string, string>,
        body: JSON.stringify({
          model: modelId,
          input,
          background: true,
          store: true,
          response_format: {
            type: "video",
            ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(options.duration ? { duration: `${options.duration}s` } : {}),
          },
        }),
      })
      if (!value.id)
        throw new Error("Google Interactions did not return a resumable interaction ID.")
      return {
        operation: { interactionId: value.id },
        warnings: [],
        response: responseInfo(headers),
      }
    },
    async doStatus(options) {
      const operation = z.object({ interactionId: z.string().min(1) }).parse(options.operation)
      const { value, headers } = await request(
        `/interactions/${encodeURIComponent(operation.interactionId)}`,
        {
          method: "GET",
          signal: options.abortSignal,
          headers: options.headers as Record<string, string>,
        }
      )
      const response = responseInfo(headers)
      if (value.status === "in_progress") return { status: "pending", response }
      if (value.status !== "completed")
        return {
          status: "error",
          error: value.error?.message ?? `Google Interactions finished with ${value.status}.`,
          response,
        }
      const videos = (value.steps ?? [])
        .filter((step) => step.type === "model_output")
        .flatMap((step) =>
          (step.content ?? []).flatMap((part) =>
            part.type === "video" && part.data
              ? [
                  {
                    type: "base64" as const,
                    data: part.data,
                    mediaType: part.mime_type ?? "video/mp4",
                  },
                ]
              : []
          )
        )
      if (!videos.length)
        return { status: "error", error: "Google Interactions returned no video data.", response }
      return { status: "completed", videos, warnings: [], response }
    },
  }
}

export async function generateProviderImage(request: ProviderImageGenerationRequest) {
  assertSafeMediaPrompt(request.prompt)
  if (!hasSafeMediaProviderOptions(request.providerOptions)) {
    throw new MediaGenerationError(
      "PII_BLOCKED",
      "Image provider options failed the outbound PII gate."
    )
  }
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
