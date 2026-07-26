/**
 * Image-generation model registry.
 *
 * Single source of truth for the image-generation models the app knows how to
 * drive. Two consumers rely on this module:
 *
 *  - The plugin Media AI flow (`lib/plugin/api/media-api.ts`) resolves an
 *    edit-capable provider + model here so plugin authors don't have to.
 *  - Any caller that needs a sane default model when the user hasn't pinned
 *    one explicitly via their `ImageProcessingOptions`.
 *
 * Default model ids are kept current with the provider catalog snapshot
 * (`lib/ai/providers/models-dev-snapshot.json`), which is the authority for
 * which models actually exist upstream. When in doubt the matchers below let a
 * user-configured (newer) model id pass through untouched, so the defaults are
 * only ever the *last* fallback.
 */

export type ImageEditProviderId = "openai" | "xai" | "togetherai" | "fireworks" | "deepinfra"

export type ImageProviderId =
  | ImageEditProviderId
  // `together` is the legacy short id some plugin code still uses; it mirrors
  // the canonical `togetherai` definition so callers don't need a migration.
  | "together"
  // Image-specialized / multimodal providers that generate (but do not expose
  // the OpenAI-compatible `/images/edits` endpoint, so they are text-to-image
  // only as far as the Media AI edit flow is concerned).
  | "google"
  | "azure"
  | "bedrock"
  | "doubao"
  | "volcengine"
  | "fal"
  | "replicate"
  | "nvidia"

export interface ImageProviderDefinition {
  id: ImageProviderId
  /** Last-fallback default model when the caller hasn't configured one. */
  defaultModel: string
  /** Known image models for this provider, newest first. */
  models: string[]
  /**
   * Whether the provider exposes the OpenAI-compatible `/images/edits`
   * endpoint. Only these providers can serve the plugin Media AI edit flow
   * (upscale / removeBackground / enhance / variation / inpaint).
   */
  supportsImageEdit: boolean
  /** Whether `/images/edits` accepts a `mask` upload for inpainting. */
  supportsMaskEdit: boolean
  /**
   * Lowercased substrings that mark a model id as image-capable. Used so a
   * user who pins a newer model than our default still routes correctly.
   */
  modelMatchers: string[]
}

// Black Forest Labs FLUX + generic diffusion matchers, shared by every
// open-weight image host (Together / Fireworks / DeepInfra / NVIDIA / fal /
// Replicate). Covers FLUX.1 / FLUX1.1 / FLUX.2 / Kontext, Qwen-Image and
// ByteDance Seedream.
const DIFFUSION_MATCHERS = [
  "flux",
  "kontext",
  "stable-diffusion",
  "diffusion",
  "sdxl",
  "sd3",
  "qwen-image",
  "seedream",
]

export const IMAGE_PROVIDERS: Record<ImageProviderId, ImageProviderDefinition> = {
  openai: {
    id: "openai",
    // GPT Image 2 (2026-04-21) is OpenAI's flagship generation + editing model.
    defaultModel: "gpt-image-2",
    models: [
      "gpt-image-2",
      "gpt-image-1.5",
      "gpt-image-1-mini",
      "chatgpt-image-latest",
      "gpt-image-1",
      "dall-e-3",
    ],
    supportsImageEdit: true,
    supportsMaskEdit: true,
    modelMatchers: ["image", "dall-e"],
  },
  xai: {
    id: "xai",
    // Grok-2-Image is superseded by the Grok Imagine image models; the
    // "-quality" tier (2026-04) is the newest.
    defaultModel: "grok-imagine-image-quality",
    models: ["grok-imagine-image-quality", "grok-imagine-image", "grok-2-image"],
    supportsImageEdit: true,
    // xAI image edits are JSON-only and do not accept a mask upload.
    supportsMaskEdit: false,
    modelMatchers: ["image", "imagine"],
  },
  togetherai: {
    id: "togetherai",
    // Together is a FLUX.2 launch partner; FLUX.2 [dev] supersedes FLUX.1.1.
    defaultModel: "black-forest-labs/FLUX.2-dev",
    models: [
      "black-forest-labs/FLUX.2-dev",
      "black-forest-labs/FLUX.1-kontext-pro",
      "black-forest-labs/FLUX.1.1-pro",
      "black-forest-labs/FLUX.1-schnell",
    ],
    supportsImageEdit: true,
    supportsMaskEdit: true,
    modelMatchers: DIFFUSION_MATCHERS,
  },
  together: {
    id: "together",
    defaultModel: "black-forest-labs/FLUX.2-dev",
    models: [
      "black-forest-labs/FLUX.2-dev",
      "black-forest-labs/FLUX.1-kontext-pro",
      "black-forest-labs/FLUX.1.1-pro",
      "black-forest-labs/FLUX.1-schnell",
    ],
    supportsImageEdit: true,
    supportsMaskEdit: true,
    modelMatchers: DIFFUSION_MATCHERS,
  },
  fireworks: {
    id: "fireworks",
    // Fireworks tops out at the FLUX.1 family (no FLUX.2 host as of 2026-06).
    defaultModel: "accounts/fireworks/models/flux-1-schnell-fp8",
    models: [
      "accounts/fireworks/models/flux-1-schnell-fp8",
      "accounts/fireworks/models/flux-1-dev-fp8",
    ],
    supportsImageEdit: true,
    supportsMaskEdit: true,
    modelMatchers: DIFFUSION_MATCHERS,
  },
  deepinfra: {
    id: "deepinfra",
    // DeepInfra hosts the FLUX.2 family (dash naming) plus Seedream / Qwen.
    defaultModel: "black-forest-labs/FLUX-2-klein-9b",
    models: [
      "black-forest-labs/FLUX-2-klein-9b",
      "black-forest-labs/FLUX-2-klein-4b",
      "black-forest-labs/FLUX-1.1-pro",
      "ByteDance/Seedream-4.5",
      "Qwen/Qwen-Image-Max",
    ],
    supportsImageEdit: true,
    supportsMaskEdit: true,
    modelMatchers: DIFFUSION_MATCHERS,
  },
  google: {
    id: "google",
    // "Nano Banana" — Gemini-native image generation/editing.
    defaultModel: "gemini-3.1-flash-image-preview",
    models: [
      "gemini-3.1-flash-image-preview",
      "gemini-3-pro-image",
      "gemini-2.5-flash-image",
      "imagen-4.0-ultra-generate-001",
      "imagen-4.0-generate-001",
      "imagen-4.0-fast-generate-001",
    ],
    // Gemini/Imagen use the Gemini API, not OpenAI `/images/edits`.
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: ["image", "imagen", "nano-banana"],
  },
  azure: {
    id: "azure",
    // Azure uses the deployment id supplied by the caller. This is only the
    // fallback when the configured default is a chat deployment.
    defaultModel: "gpt-image-1",
    models: ["gpt-image-1", "dall-e-3"],
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: ["image", "dall-e"],
  },
  bedrock: {
    id: "bedrock",
    defaultModel: "amazon.nova-canvas-v1:0",
    models: ["amazon.nova-canvas-v1:0"],
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: ["nova-canvas", "canvas"],
  },
  doubao: {
    id: "doubao",
    defaultModel: "seedream-5-0-260128",
    models: [
      "seedream-5-0-260128",
      "seedream-5-0-lite-260128",
      "seedream-4-5-251128",
      "seedream-4-0-250828",
    ],
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: ["seedream"],
  },
  volcengine: {
    id: "volcengine",
    defaultModel: "seedream-5-0-260128",
    models: [
      "seedream-5-0-260128",
      "seedream-5-0-lite-260128",
      "seedream-4-5-251128",
      "seedream-4-0-250828",
    ],
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: ["seedream"],
  },
  fal: {
    id: "fal",
    defaultModel: "fal-ai/flux-2-pro",
    models: [
      "fal-ai/flux-2-pro",
      "fal-ai/flux-2-flex",
      "fal-ai/flux-2-max",
      "fal-ai/flux-pro/kontext",
      "fal-ai/qwen-image",
      "fal-ai/recraft-v3",
    ],
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: [...DIFFUSION_MATCHERS, "image", "recraft", "ideogram"],
  },
  replicate: {
    id: "replicate",
    defaultModel: "black-forest-labs/flux-2-pro",
    models: [
      "black-forest-labs/flux-2-pro",
      "black-forest-labs/flux-2-max",
      "black-forest-labs/flux-2-klein-4b",
      "black-forest-labs/flux-kontext-pro",
      "stability-ai/sdxl",
    ],
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: [...DIFFUSION_MATCHERS, "image", "imagen", "recraft", "ideogram"],
  },
  nvidia: {
    id: "nvidia",
    defaultModel: "black-forest-labs/flux_2-klein-4b",
    models: [
      "black-forest-labs/flux_2-klein-4b",
      "black-forest-labs/flux_1-kontext-dev",
      "black-forest-labs/flux.1-dev",
      "qwen/qwen-image",
      "qwen/qwen-image-edit",
    ],
    supportsImageEdit: false,
    supportsMaskEdit: false,
    modelMatchers: DIFFUSION_MATCHERS,
  },
}

/**
 * Per-provider default model. Preserved for back-compat with callers that only
 * need the default id; derived from {@link IMAGE_PROVIDERS}.
 */
export const DEFAULT_IMAGE_MODELS: Record<ImageProviderId, string> = Object.fromEntries(
  Object.values(IMAGE_PROVIDERS).map((provider) => [provider.id, provider.defaultModel])
) as Record<ImageProviderId, string>

/**
 * Providers that expose the OpenAI-compatible `/images/edits` endpoint, in the
 * order the Media AI flow should try them as fallbacks. `together` is excluded
 * here because it is just an alias of `togetherai`.
 */
export const IMAGE_EDIT_PROVIDER_IDS: ImageEditProviderId[] = [
  "openai",
  "xai",
  "togetherai",
  "fireworks",
  "deepinfra",
]

export function isSupportedImageProvider(value: string): value is ImageProviderId {
  return Object.prototype.hasOwnProperty.call(IMAGE_PROVIDERS, value)
}

export function isImageEditProvider(value: string): value is ImageEditProviderId {
  return (IMAGE_EDIT_PROVIDER_IDS as string[]).includes(value)
}

/** Default model for a provider, or `undefined` for an unknown provider. */
export function resolveDefaultImageModel(providerId: string): string | undefined {
  return isSupportedImageProvider(providerId) ? IMAGE_PROVIDERS[providerId].defaultModel : undefined
}

/** Whether the given model id is image-capable for the given provider. */
export function isImageCapableModel(providerId: string, model: string | undefined): boolean {
  if (!model || !isSupportedImageProvider(providerId)) {
    return false
  }
  const normalized = model.toLowerCase()
  return IMAGE_PROVIDERS[providerId].modelMatchers.some((matcher) => normalized.includes(matcher))
}

/**
 * Resolve the model to use for a provider: the caller's configured model when
 * it is image-capable, otherwise the provider default.
 */
export function resolveImageModel(providerId: ImageProviderId, configuredModel?: string): string {
  if (isImageCapableModel(providerId, configuredModel)) {
    return configuredModel as string
  }
  return IMAGE_PROVIDERS[providerId].defaultModel
}

/** Whether the provider's edit endpoint accepts a mask upload (inpainting). */
export function providerSupportsMaskEdit(providerId: string): boolean {
  return isSupportedImageProvider(providerId) && IMAGE_PROVIDERS[providerId].supportsMaskEdit
}
