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
