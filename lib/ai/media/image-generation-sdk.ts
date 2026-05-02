/**
 * Default image-generation model selection per provider.
 *
 * The plugin Media API picks a model when the user hasn't explicitly
 * configured one. This map is consulted as the last fallback — plugins
 * authors that want a specific model should pass it through their
 * `ImageProcessingOptions`.
 */

export type ImageProviderId =
  | "openai"
  | "xai"
  | "togetherai"
  | "together"
  | "fireworks"
  | "deepinfra"

export const DEFAULT_IMAGE_MODELS: Record<ImageProviderId, string> = {
  openai: "gpt-image-1",
  xai: "grok-2-image",
  togetherai: "black-forest-labs/FLUX.1-schnell",
  // `together` is the legacy short id some plugin code still uses; we
  // mirror the canonical `togetherai` model so callers don't need a
  // migration step.
  together: "black-forest-labs/FLUX.1-schnell",
  fireworks: "accounts/fireworks/models/flux-1-schnell-fp8",
  deepinfra: "black-forest-labs/FLUX-1-schnell",
}

export function isSupportedImageProvider(value: string): value is ImageProviderId {
  return Object.prototype.hasOwnProperty.call(DEFAULT_IMAGE_MODELS, value)
}
