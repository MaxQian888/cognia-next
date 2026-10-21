/**
 * The plugin contract's share of `lib/ai/media/provider-generation.ts`, which re-exports these.
 */
import type { IMAGE_GENERATION_PROVIDER_IDS } from "@/lib/ai/media/provider-generation"
import type { ProviderSettingsSnapshot } from "../provider-consumption"
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
