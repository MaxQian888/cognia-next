export type VideoProviderId =
  "google" | "xai" | "fal" | "replicate" | "doubao" | "volcengine" | "qwen"

export interface VideoProviderDefinition {
  id: VideoProviderId
  defaultModel: string
  models: string[]
  modelMatchers: string[]
}

export const VIDEO_PROVIDERS: Record<VideoProviderId, VideoProviderDefinition> = {
  google: {
    id: "google",
    defaultModel: "veo-3.1-generate-preview",
    models: [
      "veo-3.1-generate-preview",
      "veo-3.1-fast-generate-preview",
      "veo-3.1-generate",
      "veo-3.0-generate-001",
      "veo-3.0-fast-generate-001",
      "veo-2.0-generate-001",
    ],
    modelMatchers: ["veo"],
  },
  xai: {
    id: "xai",
    defaultModel: "grok-imagine-video",
    models: ["grok-imagine-video"],
    modelMatchers: ["video"],
  },
  fal: {
    id: "fal",
    defaultModel: "luma-ray-2",
    models: [
      "luma-ray-2",
      "luma-ray-2-flash",
      "luma-dream-machine",
      "minimax-video",
      "minimax-video-01",
      "hunyuan-video",
    ],
    modelMatchers: ["video", "luma", "ray-2", "hunyuan"],
  },
  replicate: {
    id: "replicate",
    defaultModel: "minimax/video-01",
    models: ["minimax/video-01", "stability-ai/stable-video-diffusion"],
    modelMatchers: ["video"],
  },
  doubao: {
    id: "doubao",
    defaultModel: "dreamina-seedance-2-0-260128",
    models: [
      "dreamina-seedance-2-0-260128",
      "dreamina-seedance-2-0-fast-260128",
      "seedance-1-5-pro-251215",
      "seedance-1-0-pro-250528",
      "seedance-1-0-pro-fast-251015",
      "seedance-1-0-lite-t2v-250428",
      "seedance-1-0-lite-i2v-250428",
    ],
    modelMatchers: ["seedance"],
  },
  volcengine: {
    id: "volcengine",
    defaultModel: "dreamina-seedance-2-0-260128",
    models: [
      "dreamina-seedance-2-0-260128",
      "dreamina-seedance-2-0-fast-260128",
      "seedance-1-5-pro-251215",
      "seedance-1-0-pro-250528",
      "seedance-1-0-pro-fast-251015",
      "seedance-1-0-lite-t2v-250428",
      "seedance-1-0-lite-i2v-250428",
    ],
    modelMatchers: ["seedance"],
  },
  qwen: {
    id: "qwen",
    defaultModel: "wan2.7-t2v",
    models: [
      "wan2.7-t2v",
      "wan2.7-t2v-2026-06-12",
      "wan2.6-t2v",
      "wan2.5-t2v-preview",
      "wan2.6-i2v",
      "wan2.6-i2v-flash",
      "wan2.7-r2v",
      "wan2.6-r2v",
      "wan2.6-r2v-flash",
    ],
    modelMatchers: ["wan"],
  },
}

export const VIDEO_GENERATION_PROVIDER_IDS = Object.keys(VIDEO_PROVIDERS) as VideoProviderId[]

export function isSupportedVideoProvider(value: string): value is VideoProviderId {
  return Object.prototype.hasOwnProperty.call(VIDEO_PROVIDERS, value)
}

export function isVideoCapableModel(providerId: string, model: string | undefined): boolean {
  if (!model || !isSupportedVideoProvider(providerId)) {
    return false
  }
  const normalized = model.toLowerCase()
  return VIDEO_PROVIDERS[providerId].modelMatchers.some((matcher) => normalized.includes(matcher))
}

export function resolveVideoModel(providerId: VideoProviderId, configuredModel?: string): string {
  return isVideoCapableModel(providerId, configuredModel)
    ? (configuredModel as string)
    : VIDEO_PROVIDERS[providerId].defaultModel
}

/**
 * Which standard `startVideo` options a provider's AI SDK adapter forwards.
 * Read from each adapter's request builder (an unsupported option is dropped
 * with a warning there), so the settings UI and the job engine can refuse or
 * hide a control instead of letting it vanish silently. Values themselves are
 * validated by the provider; a rejected value comes back as a job error.
 */
export interface VideoProviderOptionSupport {
  aspectRatio: boolean
  resolution: boolean
  duration: boolean
  seed: boolean
  fps: boolean
}

export const VIDEO_PROVIDER_OPTIONS: Record<VideoProviderId, VideoProviderOptionSupport> = {
  google: { aspectRatio: true, resolution: true, duration: true, seed: true, fps: false },
  // fal takes resolution only through model-specific providerOptions.
  fal: { aspectRatio: true, resolution: false, duration: true, seed: true, fps: false },
  // Replicate is the only adapter that forwards `fps`.
  replicate: { aspectRatio: true, resolution: true, duration: true, seed: true, fps: true },
  // xAI warns "video models do not support seed" (and custom FPS).
  xai: { aspectRatio: true, resolution: true, duration: true, seed: false, fps: false },
  doubao: { aspectRatio: true, resolution: true, duration: true, seed: true, fps: false },
  volcengine: { aspectRatio: true, resolution: true, duration: true, seed: true, fps: false },
  // DashScope Wan warns on aspectRatio and fps; size comes from resolution.
  qwen: { aspectRatio: false, resolution: true, duration: true, seed: true, fps: false },
}

/**
 * How a model treats a start frame. Seedance and Wan encode the mode in the
 * model id (`…-t2v-…` text only, `…-i2v…` image required); every other model
 * takes an optional start frame.
 */
export type VideoStartFrameMode = "optional" | "required" | "unsupported"

export function videoStartFrameMode(model: string): VideoStartFrameMode {
  const normalized = model.toLowerCase()
  if (normalized.includes("i2v")) return "required"
  if (normalized.includes("t2v") || normalized.includes("r2v")) return "unsupported"
  return "optional"
}

/**
 * Providers the web build can call directly. A browser `fetch` reaches a
 * provider only if it serves CORS headers for any origin; Google's
 * Generative Language API does (the chat path already streams from it in the
 * browser). The others are not known to, so on the web build they are listed
 * but inert ("desktop app required") rather than failing with an opaque
 * network error — the desktop and mobile shells reach them natively.
 */
export const BROWSER_DIRECT_VIDEO_PROVIDERS: ReadonlySet<VideoProviderId> = new Set(["google"])

/**
 * Whether this shell can reach a provider at all: every provider from the
 * desktop and mobile shells, only {@link BROWSER_DIRECT_VIDEO_PROVIDERS} from
 * the web build. The job engine refuses the rest with `unavailable_on_web`;
 * the settings card, the agent tool gate and `/video` use the same answer.
 */
export function isVideoProviderReachable(
  providerId: VideoProviderId,
  reachesNonCorsHosts: boolean
): boolean {
  return reachesNonCorsHosts || BROWSER_DIRECT_VIDEO_PROVIDERS.has(providerId)
}

/** Choices the settings card and `/video` offer; the provider has the last word on each value. */
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const
export const VIDEO_RESOLUTIONS = ["1280x720", "1920x1080"] as const
export const VIDEO_DURATIONS_SEC = [4, 5, 6, 8, 10] as const

export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number]
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]
