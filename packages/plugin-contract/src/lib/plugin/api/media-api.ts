/**
 * The plugin contract's share of `lib/plugin/api/media-api.ts`, which re-exports these.
 */
import type {
  ImageGenerationProviderId,
  ProviderImageGenerationRequest,
} from "../../ai/media/provider-generation"
import type { MediaCatalogWriter, PluginMediaAssetInput } from "../../media/media-ingest"
import type { StartVideoJobInput } from "../../ai/media/video-jobs/engine"
import type { VideoProviderId } from "../../ai/media/video-generation-sdk"

export interface ImageProcessingOptions {
  format?: "png" | "jpeg" | "webp"
  quality?: number // 0-100 for jpeg/webp
  width?: number
  height?: number
  maintainAspectRatio?: boolean
}

export interface MediaImageGenerationOptions {
  providerId?: ImageGenerationProviderId
  model?: string
  size?: `${number}x${number}`
  aspectRatio?: `${number}:${number}`
  seed?: number
  referenceImages?: ImageData[]
  mask?: ImageData
  providerOptions?: ProviderImageGenerationRequest["providerOptions"]
  abortSignal?: AbortSignal
}

export interface MediaVideoGenerationOptions {
  providerId?: VideoProviderId
  model?: string
  aspectRatio?: `${number}:${number}`
  resolution?: `${number}x${number}`
  duration?: number
  fps?: number
  seed?: number
  inputImage?: ImageData
  providerOptions?: StartVideoJobInput["providerOptions"]
  abortSignal?: AbortSignal
}

export interface ImageFilterDefinition {
  id: string
  name: string
  description?: string
  category: "color" | "blur" | "stylize" | "distort" | "enhance" | "custom"
  icon?: string
  parameters?: FilterParameterDefinition[]
  apply: (imageData: ImageData, params?: Record<string, unknown>) => ImageData | Promise<ImageData>
  preview?: (imageData: ImageData, params?: Record<string, unknown>) => ImageData
}

export interface FilterParameterDefinition {
  id: string
  name: string
  type: "number" | "boolean" | "string" | "color" | "select"
  default: unknown
  min?: number
  max?: number
  step?: number
  options?: Array<{ value: string; label: string }>
}

export interface ImageTransformOptions {
  rotate?: number // degrees
  flipHorizontal?: boolean
  flipVertical?: boolean
  scale?: number
  cropRegion?: { x: number; y: number; width: number; height: number }
}

export interface ImageAdjustmentOptions {
  brightness?: number // -100 to 100
  contrast?: number // -100 to 100
  saturation?: number // -100 to 100
  hue?: number // -180 to 180
  blur?: number // 0 to 100
  sharpen?: number // 0 to 100
  exposure?: number // -100 to 100
  gamma?: number // 0.1 to 10
  vibrance?: number // -100 to 100
  temperature?: number // -100 to 100
  tint?: number // -100 to 100
}

export interface VideoClip {
  id: string
  sourceUrl: string
  startTime: number // seconds
  endTime: number // seconds
  duration: number // seconds
  position: number // position in timeline
  track: number // layer/track index
  volume?: number // 0-1
  playbackSpeed?: number // 0.1-10
  filters?: string[] // applied filter IDs
  transitions?: {
    in?: VideoTransition
    out?: VideoTransition
  }
}

export interface VideoTransition {
  type: "fade" | "dissolve" | "wipe" | "slide" | "zoom" | "blur" | "custom"
  duration: number // seconds
  parameters?: Record<string, unknown>
}

export interface VideoEffectDefinition {
  id: string
  name: string
  description?: string
  category: "color" | "blur" | "stylize" | "distort" | "motion" | "custom"
  icon?: string
  parameters?: FilterParameterDefinition[]
  supportsKeyframes?: boolean
  apply: (
    frame: ImageData,
    params?: Record<string, unknown>,
    time?: number
  ) => ImageData | Promise<ImageData>
}

export interface VideoTransitionDefinition {
  id: string
  name: string
  description?: string
  icon?: string
  minDuration: number
  maxDuration: number
  defaultDuration: number
  parameters?: FilterParameterDefinition[]
  render: (
    fromFrame: ImageData,
    toFrame: ImageData,
    progress: number, // 0-1
    params?: Record<string, unknown>
  ) => ImageData
}

export interface VideoExportOptions {
  abortSignal?: AbortSignal
  format: "mp4" | "webm" | "gif"
  resolution: "480p" | "720p" | "1080p" | "4k"
  fps: number
  quality: "low" | "medium" | "high" | "maximum"
  codec?: string
  audioBitrate?: number
  videoBitrate?: number
  includeSubtitles?: boolean
  subtitleMode?: "burn-in" | "sidecar" | "both"
  subtitleTracks?: Array<{
    id: string
    format: "srt" | "vtt" | "ass"
    content: string
    burnIn?: boolean
  }>
  destinationPath?: string
  overwrite?: boolean
  onProgress?: (progress: ExportProgress) => void
}

export type VideoAnalysisMode = "keyframes" | "scene"

export interface VideoAnalysisOptions {
  mode?: VideoAnalysisMode
  startTime?: number
  endTime?: number
  maxFrames?: number
  width?: number
  deduplicate?: boolean
  duplicateThreshold?: number
}

export interface VideoAnalysisFrame {
  path: string
  /** Readable image bytes for frames produced on a remote execution host. */
  dataUrl?: string
  timestamp: number
  reason: "keyframe" | "scene-change" | "uniform-fallback"
}

export interface VideoAnalysisManifest {
  sourcePath: string
  outputDirectory: string
  mode: VideoAnalysisMode
  range: {
    startTime: number
    endTime: number
  }
  metadata: NativeVideoInfo
  candidateCount: number
  deduplicatedCount: number
  frames: VideoAnalysisFrame[]
  warnings: string[]
}

export interface ExportProgress {
  phase: "preparing" | "rendering" | "encoding" | "finalizing" | "complete" | "error"
  percent: number
  currentFrame?: number
  totalFrames?: number
  elapsedMs?: number
  estimatedRemainingMs?: number
  message?: string
}

export interface MediaProcessingResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  duration?: number // processing time in ms
}

export interface PluginMediaAPI {
  // Image Processing
  image: {
    load: (source: string | Blob | File) => Promise<ImageData>
    save: (imageData: ImageData, options?: ImageProcessingOptions) => Promise<Blob>
    toDataUrl: (imageData: ImageData, format?: "png" | "jpeg" | "webp", quality?: number) => string
    fromDataUrl: (dataUrl: string) => Promise<ImageData>
    resize: (
      imageData: ImageData,
      width: number,
      height: number,
      maintainAspect?: boolean
    ) => ImageData
    transform: (imageData: ImageData, options: ImageTransformOptions) => ImageData
    adjust: (imageData: ImageData, adjustments: ImageAdjustmentOptions) => ImageData
    applyFilter: (
      imageData: ImageData,
      filterId: string,
      params?: Record<string, unknown>
    ) => Promise<ImageData>
    getHistogram: (imageData: ImageData) => {
      r: number[]
      g: number[]
      b: number[]
      luminance: number[]
    }
    compare: (image1: ImageData, image2: ImageData) => { similarity: number; diff?: ImageData }
  }

  // Video Processing
  video: {
    loadClip: (source: string | Blob | File) => Promise<VideoClip>
    getFrame: (clipId: string, time: number) => Promise<ImageData>
    getMetadata: (source: string | Blob | File) => Promise<{
      duration: number
      width: number
      height: number
      fps: number
      codec: string
      bitrate: number
      hasAudio: boolean
    }>
    analyze: (
      source: string | Blob | File,
      options?: VideoAnalysisOptions
    ) => Promise<VideoAnalysisManifest>
    cleanupAnalysis: (manifest: VideoAnalysisManifest) => Promise<void>
    trim: (clipId: string, startTime: number, endTime: number) => Promise<VideoClip>
    concatenate: (clipIds: string[]) => Promise<VideoClip>
    applyEffect: (
      clipId: string,
      effectId: string,
      params?: Record<string, unknown>
    ) => Promise<void>
    addTransition: (
      fromClipId: string,
      toClipId: string,
      transition: VideoTransition
    ) => Promise<void>
    export: (clipIds: string[], options: VideoExportOptions) => Promise<Blob>
  }

  // Filter & Effect Registration
  filters: {
    register: (filter: ImageFilterDefinition) => void
    unregister: (filterId: string) => void
    getAll: () => ImageFilterDefinition[]
    getById: (filterId: string) => ImageFilterDefinition | undefined
    getByCategory: (category: string) => ImageFilterDefinition[]
  }

  effects: {
    register: (effect: VideoEffectDefinition) => void
    unregister: (effectId: string) => void
    getAll: () => VideoEffectDefinition[]
    getById: (effectId: string) => VideoEffectDefinition | undefined
  }

  transitions: {
    register: (transition: VideoTransitionDefinition) => void
    unregister: (transitionId: string) => void
    getAll: () => VideoTransitionDefinition[]
    getById: (transitionId: string) => VideoTransitionDefinition | undefined
  }

  // AI Processing
  ai: {
    generateImage: (prompt: string, options?: MediaImageGenerationOptions) => Promise<ImageData>
    generateVideo: (prompt: string, options?: MediaVideoGenerationOptions) => Promise<Blob>
    upscale: (imageData: ImageData, factor: 2 | 4) => Promise<ImageData>
    removeBackground: (imageData: ImageData) => Promise<ImageData>
    enhanceImage: (
      imageData: ImageData,
      type: "denoise" | "sharpen" | "restore"
    ) => Promise<ImageData>
    generateVariation: (imageData: ImageData, prompt?: string) => Promise<ImageData>
    inpaint: (imageData: ImageData, mask: ImageData, prompt: string) => Promise<ImageData>
  }

  // Utilities
  utils: {
    createCanvas: (width: number, height: number) => OffscreenCanvas
    getImageDataFromCanvas: (canvas: OffscreenCanvas | HTMLCanvasElement) => ImageData
    putImageDataToCanvas: (
      imageData: ImageData,
      canvas: OffscreenCanvas | HTMLCanvasElement
    ) => void
    blobToBase64: (blob: Blob) => Promise<string>
    base64ToBlob: (base64: string, mimeType: string) => Blob
    downloadFile: (blob: Blob, filename: string) => void
    registerCatalogAsset: (
      catalog: MediaCatalogWriter,
      asset: Omit<PluginMediaAssetInput, "pluginId">
    ) => string
  }
}

export interface NativeVideoInfo {
  durationMs: number
  width: number
  height: number
  fps: number
  codec: string
  fileSize: number
  hasAudio: boolean
  sourceToken: string
}
