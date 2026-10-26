/**
 * The plugin contract's share of `lib/ai/media/provider-generation.ts`, which re-exports these.
 */

import type { ProviderSettingsSnapshot } from "../provider-consumption"
import type { ImageProviderId } from "./image-generation-sdk"
import type { generateImage } from "ai"

export type ImageGenerationProviderId = (typeof IMAGE_GENERATION_PROVIDER_IDS)[number]

export type ProviderImagePrompt = Parameters<typeof generateImage>[0]["prompt"]

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
