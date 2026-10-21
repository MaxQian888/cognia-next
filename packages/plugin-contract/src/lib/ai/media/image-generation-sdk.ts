/**
 * The plugin contract's share of `lib/ai/media/image-generation-sdk.ts`, which re-exports these.
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
