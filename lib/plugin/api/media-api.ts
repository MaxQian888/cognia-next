/**
 * Media Plugin API - Image and Video Processing for Plugins
 *
 * Provides plugin access to image and video processing capabilities:
 * - Image manipulation (filters, transforms, effects)
 * - Video processing (trimming, transitions, effects)
 * - Custom filter/effect registration
 * - Media export utilities
 */

import { invoke } from "@tauri-apps/api/core"
import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
} from "@/lib/ai/provider-consumption"
import {
  IMAGE_EDIT_PROVIDER_IDS,
  isImageEditProvider,
  resolveImageModel,
  type ImageEditProviderId,
} from "@/lib/ai/media/image-generation-sdk"
import {
  generateProviderImage,
  generateProviderVideo,
  type ImageGenerationProviderId,
  type ProviderImageGenerationRequest,
  type ProviderVideoGenerationRequest,
} from "@/lib/ai/media/provider-generation"
import type { VideoProviderId } from "@/lib/ai/media/video-generation-sdk"
import {
  registerPluginMediaAsset,
  type MediaCatalogWriter,
  type PluginMediaAssetInput,
} from "@/lib/media/media-ingest"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { useSettingsStore } from "@/stores"
import { isTauri } from "@/lib/utils"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { createApiGuardedAPI } from "./api-permission-gate"
import { assertNoLeakingPii } from "./plugin-pii-gate"
import type { PluginManager } from "../core/manager"

// =============================================================================
// Types
// =============================================================================

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
  providerOptions?: ProviderVideoGenerationRequest["providerOptions"]
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

// =============================================================================
// Registry for Plugin-Registered Filters/Effects
// =============================================================================

class MediaRegistry {
  private filters = new Map<string, ImageFilterDefinition>()
  private effects = new Map<string, VideoEffectDefinition>()
  private transitions = new Map<string, VideoTransitionDefinition>()
  private pluginFilters = new Map<string, Set<string>>() // pluginId -> filterIds

  registerFilter(pluginId: string, filter: ImageFilterDefinition): void {
    const fullId = `${pluginId}:${filter.id}`
    this.filters.set(fullId, { ...filter, id: fullId })

    if (!this.pluginFilters.has(pluginId)) {
      this.pluginFilters.set(pluginId, new Set())
    }
    this.pluginFilters.get(pluginId)!.add(fullId)
  }

  unregisterFilter(filterId: string): void {
    this.filters.delete(filterId)
    for (const [, filterIds] of this.pluginFilters) {
      filterIds.delete(filterId)
    }
  }

  unregisterPluginFilters(pluginId: string): void {
    const filterIds = this.pluginFilters.get(pluginId)
    if (filterIds) {
      for (const id of filterIds) {
        this.filters.delete(id)
      }
      this.pluginFilters.delete(pluginId)
    }
  }

  getFilter(id: string): ImageFilterDefinition | undefined {
    return this.filters.get(id)
  }

  getAllFilters(): ImageFilterDefinition[] {
    return Array.from(this.filters.values())
  }

  getFiltersByCategory(category: string): ImageFilterDefinition[] {
    return this.getAllFilters().filter((f) => f.category === category)
  }

  registerEffect(pluginId: string, effect: VideoEffectDefinition): void {
    const fullId = `${pluginId}:${effect.id}`
    this.effects.set(fullId, { ...effect, id: fullId })
  }

  unregisterEffect(effectId: string): void {
    this.effects.delete(effectId)
  }

  getEffect(id: string): VideoEffectDefinition | undefined {
    return this.effects.get(id)
  }

  getAllEffects(): VideoEffectDefinition[] {
    return Array.from(this.effects.values())
  }

  registerTransition(pluginId: string, transition: VideoTransitionDefinition): void {
    const fullId = `${pluginId}:${transition.id}`
    this.transitions.set(fullId, { ...transition, id: fullId })
  }

  unregisterTransition(transitionId: string): void {
    this.transitions.delete(transitionId)
  }

  getTransition(id: string): VideoTransitionDefinition | undefined {
    return this.transitions.get(id)
  }

  getAllTransitions(): VideoTransitionDefinition[] {
    return Array.from(this.transitions.values())
  }
}

const mediaRegistry = new MediaRegistry()

export function getMediaRegistry(): MediaRegistry {
  return mediaRegistry
}

// =============================================================================
// Image Processing Utilities
// =============================================================================

function createOffscreenCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(width, height)
}

async function loadImage(source: string | Blob | File): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = "anonymous"

    img.onload = () => {
      const canvas = createOffscreenCanvas(img.width, img.height)
      const ctx = canvas.getContext("2d")
      if (!ctx) {
        reject(new Error("Failed to get canvas context"))
        return
      }
      ctx.drawImage(img, 0, 0)
      resolve(ctx.getImageData(0, 0, img.width, img.height))
    }

    img.onerror = () => reject(new Error("Failed to load image"))

    if (typeof source === "string") {
      img.src = source
    } else {
      img.src = URL.createObjectURL(source)
    }
  })
}

function imageDataToDataUrl(
  imageData: ImageData,
  format: "png" | "jpeg" | "webp" = "png",
  quality = 0.92
): string {
  const canvas = createOffscreenCanvas(imageData.width, imageData.height)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Failed to get canvas context")

  ctx.putImageData(imageData, 0, 0)

  // OffscreenCanvas uses convertToBlob, need to use regular canvas for toDataURL
  const tempCanvas = document.createElement("canvas")
  tempCanvas.width = imageData.width
  tempCanvas.height = imageData.height
  const tempCtx = tempCanvas.getContext("2d")
  if (!tempCtx) throw new Error("Failed to get temp canvas context")
  tempCtx.putImageData(imageData, 0, 0)

  return tempCanvas.toDataURL(`image/${format}`, quality)
}

async function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  return loadImage(dataUrl)
}

function resizeImageData(
  imageData: ImageData,
  targetWidth: number,
  targetHeight: number,
  maintainAspect = true
): ImageData {
  let finalWidth = targetWidth
  let finalHeight = targetHeight

  if (maintainAspect) {
    const aspectRatio = imageData.width / imageData.height
    if (targetWidth / targetHeight > aspectRatio) {
      finalWidth = Math.round(targetHeight * aspectRatio)
    } else {
      finalHeight = Math.round(targetWidth / aspectRatio)
    }
  }

  const sourceCanvas = createOffscreenCanvas(imageData.width, imageData.height)
  const sourceCtx = sourceCanvas.getContext("2d")
  if (!sourceCtx) throw new Error("Failed to get source canvas context")
  sourceCtx.putImageData(imageData, 0, 0)

  const targetCanvas = createOffscreenCanvas(finalWidth, finalHeight)
  const targetCtx = targetCanvas.getContext("2d")
  if (!targetCtx) throw new Error("Failed to get target canvas context")

  targetCtx.drawImage(sourceCanvas, 0, 0, finalWidth, finalHeight)
  return targetCtx.getImageData(0, 0, finalWidth, finalHeight)
}

function transformImageData(imageData: ImageData, options: ImageTransformOptions): ImageData {
  const canvas = createOffscreenCanvas(imageData.width, imageData.height)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Failed to get canvas context")

  // Create source canvas
  const sourceCanvas = createOffscreenCanvas(imageData.width, imageData.height)
  const sourceCtx = sourceCanvas.getContext("2d")
  if (!sourceCtx) throw new Error("Failed to get source canvas context")
  sourceCtx.putImageData(imageData, 0, 0)

  // Apply transforms
  ctx.save()
  ctx.translate(canvas.width / 2, canvas.height / 2)

  if (options.rotate) {
    ctx.rotate((options.rotate * Math.PI) / 180)
  }

  if (options.scale) {
    ctx.scale(options.scale, options.scale)
  }

  if (options.flipHorizontal) {
    ctx.scale(-1, 1)
  }

  if (options.flipVertical) {
    ctx.scale(1, -1)
  }

  ctx.translate(-canvas.width / 2, -canvas.height / 2)
  ctx.drawImage(sourceCanvas, 0, 0)
  ctx.restore()

  let result = ctx.getImageData(0, 0, canvas.width, canvas.height)

  // Apply crop
  if (options.cropRegion) {
    const { x, y, width, height } = options.cropRegion
    const cropCanvas = createOffscreenCanvas(width, height)
    const cropCtx = cropCanvas.getContext("2d")
    if (!cropCtx) throw new Error("Failed to get crop canvas context")
    cropCtx.putImageData(result, -x, -y)
    result = cropCtx.getImageData(0, 0, width, height)
  }

  return result
}

function adjustImageData(imageData: ImageData, adjustments: ImageAdjustmentOptions): ImageData {
  const data = new Uint8ClampedArray(imageData.data)

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]
    let g = data[i + 1]
    let b = data[i + 2]

    // Brightness
    if (adjustments.brightness) {
      const brightness = adjustments.brightness * 2.55
      r = Math.min(255, Math.max(0, r + brightness))
      g = Math.min(255, Math.max(0, g + brightness))
      b = Math.min(255, Math.max(0, b + brightness))
    }

    // Contrast
    if (adjustments.contrast) {
      const contrast = (adjustments.contrast + 100) / 100
      const factor = (259 * (contrast * 255 + 255)) / (255 * (259 - contrast * 255))
      r = Math.min(255, Math.max(0, factor * (r - 128) + 128))
      g = Math.min(255, Math.max(0, factor * (g - 128) + 128))
      b = Math.min(255, Math.max(0, factor * (b - 128) + 128))
    }

    // Saturation
    if (adjustments.saturation) {
      const saturation = (adjustments.saturation + 100) / 100
      const gray = 0.2989 * r + 0.587 * g + 0.114 * b
      r = Math.min(255, Math.max(0, gray + saturation * (r - gray)))
      g = Math.min(255, Math.max(0, gray + saturation * (g - gray)))
      b = Math.min(255, Math.max(0, gray + saturation * (b - gray)))
    }

    // Hue shift
    if (adjustments.hue) {
      const hueShift = adjustments.hue / 180
      const [h, s, l] = rgbToHsl(r, g, b)
      const [newR, newG, newB] = hslToRgb((h + hueShift + 1) % 1, s, l)
      r = newR
      g = newG
      b = newB
    }

    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }

  return new ImageData(data, imageData.width, imageData.height)
}

// Color conversion utilities
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }

  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number

  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

function getHistogram(imageData: ImageData): {
  r: number[]
  g: number[]
  b: number[]
  luminance: number[]
} {
  const r = new Array(256).fill(0)
  const g = new Array(256).fill(0)
  const b = new Array(256).fill(0)
  const luminance = new Array(256).fill(0)

  for (let i = 0; i < imageData.data.length; i += 4) {
    r[imageData.data[i]]++
    g[imageData.data[i + 1]]++
    b[imageData.data[i + 2]]++
    const lum = Math.round(
      0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2]
    )
    luminance[lum]++
  }

  return { r, g, b, luminance }
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

interface NativeVideoProgressEvent {
  operation: string
  progress: number
  currentTime: number
  totalDuration?: number
  etaSeconds?: number
  error?: string
}

interface LocalVideoClipEntry {
  sourcePath: string
  sourceToken?: string
  clip: VideoClip
  effects: Array<{ id: string; params: Record<string, unknown> }>
}

interface NativeVideoClipInput {
  sourceToken: string
  startTime: number
  endTime: number
  volume: number
  playbackSpeed: number
  effects: Array<{ id: string; params: Record<string, unknown> }>
  transitionOut?: VideoTransition
}

type MediaAIError = Error & {
  code: "NO_IMAGE_PROVIDER" | "TIMEOUT" | "PROVIDER_ERROR" | "NO_IMAGE_RESULT"
  suggestion?: string
  details?: unknown
}

interface ResolvedImageProviderConfig {
  providerId: ImageEditProviderId
  apiKey: string | undefined
  baseURL: string | undefined
  model: string
}

const MEDIA_AI_TIMEOUT_MS = 30_000

const localVideoClipRegistry = new Map<string, LocalVideoClipEntry>()

function createClipId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function ensurePathSource(source: string | Blob | File): string {
  if (typeof source !== "string") {
    throw new Error("Only string file paths are supported for plugin video processing")
  }
  return source
}

async function getNativeVideoInfo(sourcePath: string): Promise<NativeVideoInfo> {
  return invoke<NativeVideoInfo>("video_get_info", { filePath: sourcePath })
}

function buildVideoClip(sourcePath: string, info: NativeVideoInfo): VideoClip {
  const duration = Math.max(0, info.durationMs / 1000)
  return {
    id: createClipId(),
    sourceUrl: sourcePath,
    startTime: 0,
    endTime: duration,
    duration,
    position: 0,
    track: 0,
    volume: 1,
    playbackSpeed: 1,
    filters: [],
    transitions: undefined,
  }
}

function persistClip(clip: VideoClip, sourcePath: string, sourceToken?: string): VideoClip {
  localVideoClipRegistry.set(clip.id, { clip, sourcePath, sourceToken, effects: [] })
  return clip
}

function updatePersistedClip(clipId: string, updater: (clip: VideoClip) => VideoClip): VideoClip {
  const entry = requireClip(clipId)
  const updated = updater(entry.clip)
  localVideoClipRegistry.set(clipId, {
    ...entry,
    clip: updated,
  })
  return updated
}

function toNativeVideoClip(entry: LocalVideoClipEntry): NativeVideoClipInput {
  if (!entry.sourceToken) {
    throw new Error(`Video clip is not backed by an authorized local source: ${entry.clip.id}`)
  }
  return {
    sourceToken: entry.sourceToken,
    startTime: entry.clip.startTime,
    endTime: entry.clip.endTime,
    volume: entry.clip.volume ?? 1,
    playbackSpeed: entry.clip.playbackSpeed ?? 1,
    effects: entry.effects.map((effect) => ({
      id: effect.id,
      params: { ...effect.params },
    })),
    transitionOut: entry.clip.transitions?.out,
  }
}

function requireClip(clipId: string): LocalVideoClipEntry {
  const entry = localVideoClipRegistry.get(clipId)
  if (!entry) {
    throw new Error(`Video clip not found: ${clipId}`)
  }
  return entry
}

function frameResponseToImageData(response: ArrayBuffer | Uint8Array): ImageData {
  const bytes = response instanceof Uint8Array ? response : new Uint8Array(response)
  if (bytes.byteLength < 8) {
    throw new Error("Native video frame response is missing its dimension header")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(0, true)
  const height = view.getUint32(4, true)
  const expectedLength = width * height * 4
  if (bytes.byteLength !== expectedLength + 8) {
    throw new Error(
      `Native video frame response has ${bytes.byteLength - 8} pixels bytes; expected ${expectedLength}`
    )
  }
  return new ImageData(new Uint8ClampedArray(bytes.slice(8)), width, height)
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(
    new Set(
      values.filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  )
}

function normalizeProviderBaseUrl(baseURL?: string, providerId?: ImageEditProviderId): string {
  if (baseURL) return baseURL.replace(/\/$/, "")
  // Per-provider defaults — without these, every provider that omits baseURL
  // gets routed to the OpenAI host, which silently breaks xAI / Together AI /
  // Fireworks / DeepInfra image edit requests.
  switch (providerId) {
    case "xai":
      return "https://api.x.ai/v1"
    case "togetherai":
      return "https://api.together.xyz/v1"
    case "fireworks":
      return "https://api.fireworks.ai/inference/v1"
    case "deepinfra":
      return "https://api.deepinfra.com/v1/openai"
    case "openai":
    default:
      return "https://api.openai.com/v1"
  }
}

function createMediaAIError(
  code: MediaAIError["code"],
  message: string,
  suggestion?: string,
  details?: unknown
): MediaAIError {
  return Object.assign(new Error(message), {
    code,
    suggestion,
    details,
  })
}

function getMediaAIProviderSuggestion(): string {
  return "在 Settings -> Providers 中配置并启用支持图像的 provider（OpenAI、xAI、Together AI、Fireworks 或 DeepInfra）。"
}

function currentProviderSettingsSnapshot() {
  const settings = useSettingsStore.getState()
  return createProviderSettingsSnapshot({
    defaultProvider: settings.defaultProvider,
    providerSettings: settings.providerSettings,
    customProviders: settings.customProviders,
  })
}

function resolveConfiguredImageProvider(): ResolvedImageProviderConfig {
  const settings = useSettingsStore.getState()
  const snapshot = currentProviderSettingsSnapshot()

  const candidateProviderIds = uniqueStrings([
    isImageEditProvider(settings.defaultProvider || "") ? settings.defaultProvider : undefined,
    ...IMAGE_EDIT_PROVIDER_IDS,
  ]) as ImageEditProviderId[]

  let blockedReason: string | undefined
  let blockedDetails: unknown

  for (const providerId of candidateProviderIds) {
    const resolution = resolveFeatureProvider(
      {
        featureId: "plugin-media-ai",
        routeProfile: "capability-bound",
        selectionMode: "explicit-provider",
        providerId,
        fallbackMode: "none",
        proxyMode: "preferred",
      },
      snapshot
    )

    if (resolution.kind === "resolved") {
      return {
        providerId,
        apiKey: resolution.apiKey,
        baseURL: normalizeProviderBaseUrl(resolution.baseURL, providerId),
        model: resolveImageModel(providerId, resolution.model),
      }
    }

    blockedReason ||= resolution.reason
    blockedDetails ||= resolution
  }

  throw createMediaAIError(
    "NO_IMAGE_PROVIDER",
    blockedReason || "No configured image provider is available for plugin media AI.",
    getMediaAIProviderSuggestion(),
    blockedDetails
  )
}

async function imageDataToPngFile(imageData: ImageData, filename: string): Promise<File> {
  const canvas = createOffscreenCanvas(imageData.width, imageData.height)
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("Failed to get canvas context")
  }
  ctx.putImageData(imageData, 0, 0)

  const blob = await canvas.convertToBlob({ type: "image/png" })
  return new File([blob], filename, { type: "image/png" })
}

async function withMediaAITimeout<T>(
  runner: (signal: AbortSignal) => Promise<T>,
  timeoutMs = MEDIA_AI_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeoutId = setTimeout(() => {
      controller.abort()
      if (settled) {
        return
      }
      settled = true
      reject(
        createMediaAIError(
          "TIMEOUT",
          `Image AI request timed out after ${timeoutMs}ms.`,
          "请检查 provider 连通性，或在重试前缩小图片尺寸。"
        )
      )
    }, timeoutMs)

    runner(controller.signal)
      .then((value) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        resolve(value)
      })
      .catch((error) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        if (error instanceof DOMException && error.name === "AbortError") {
          reject(
            createMediaAIError(
              "TIMEOUT",
              `Image AI request timed out after ${timeoutMs}ms.`,
              "请检查 provider 连通性，或在重试前缩小图片尺寸。"
            )
          )
          return
        }
        reject(error)
      })
  })
}

async function runImageAi(
  pluginId: string,
  site: string,
  runner: () => Promise<ImageData>
): Promise<ImageData> {
  try {
    return await runner()
  } catch (error) {
    recordSilentFailure(
      pluginId,
      {
        site,
        message: `Image AI call failed: ${site}`,
        expected: false,
      },
      error
    )
    throw error
  }
}

async function runGeneratedMediaAi<T>(
  pluginId: string,
  site: string,
  runner: () => Promise<T>
): Promise<T> {
  try {
    return await runner()
  } catch (error) {
    recordSilentFailure(
      pluginId,
      {
        site,
        message: `Generated media AI call failed: ${site}`,
        expected: false,
      },
      error
    )
    throw error
  }
}

async function executeProviderImageEdit(
  prompt: string,
  imageData: ImageData,
  mask?: ImageData
): Promise<ImageData> {
  const provider = resolveConfiguredImageProvider()

  return withMediaAITimeout(async (signal) => {
    const response =
      provider.providerId === "xai"
        ? await (async () => {
            if (mask) {
              throw createMediaAIError(
                "PROVIDER_ERROR",
                "xAI image edit requests do not support mask uploads.",
                "请切换到支持蒙版编辑的 provider（如 OpenAI），或去掉蒙版后重试。",
                {
                  providerId: provider.providerId,
                  capability: "mask-edit",
                }
              )
            }

            return proxyFetch(`${provider.baseURL}/images/edits`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${provider.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: provider.model,
                prompt,
                image: {
                  type: "image_url",
                  url: imageDataToDataUrl(imageData),
                },
              }),
              signal,
            })
          })()
        : await (async () => {
            const formData = new FormData()
            formData.append("model", provider.model)
            formData.append("image", await imageDataToPngFile(imageData, "plugin-media-input.png"))
            formData.append("prompt", prompt)
            formData.append("n", "1")
            formData.append("response_format", "b64_json")

            if (mask) {
              formData.append("mask", await imageDataToPngFile(mask, "plugin-media-mask.png"))
            }

            return proxyFetch(`${provider.baseURL}/images/edits`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${provider.apiKey}`,
              },
              body: formData,
              signal,
            })
          })()

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw createMediaAIError(
        "PROVIDER_ERROR",
        `Image provider request failed with status ${response.status}.`,
        errorText || "请确认当前模型支持图像编辑能力。",
        {
          providerId: provider.providerId,
          status: response.status,
        }
      )
    }

    const payload = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>
    }
    const generated = payload.data?.[0]

    if (generated?.b64_json) {
      return dataUrlToImageData(`data:image/png;base64,${generated.b64_json}`)
    }

    if (generated?.url) {
      return loadImage(generated.url)
    }

    throw createMediaAIError(
      "NO_IMAGE_RESULT",
      "The image provider did not return any image output.",
      "请确认当前模型支持图像编辑能力，并检查 provider 返回值。",
      {
        providerId: provider.providerId,
      }
    )
  })
}

async function withTimelineProgress<T>(
  onProgress: VideoExportOptions["onProgress"],
  runner: () => Promise<T>
): Promise<T> {
  if (!onProgress || !isTauri()) {
    return runner()
  }

  const { listen } = await import("@tauri-apps/api/event")
  const unlistenFns: Array<() => void> = []
  const startedAt = Date.now()

  const unlistenStarted = await listen<NativeVideoProgressEvent>(
    "video-processing-started",
    (event) => {
      if (event.payload.operation !== "timeline-render") {
        return
      }
      onProgress({
        phase: "preparing",
        percent: 0,
        message: "Preparing timeline render...",
      })
    }
  )

  const unlistenProgress = await listen<NativeVideoProgressEvent>(
    "video-processing-progress",
    (event) => {
      if (event.payload.operation !== "timeline-render") {
        return
      }
      onProgress({
        phase: event.payload.progress < 0.85 ? "rendering" : "encoding",
        percent: Math.max(0, Math.min(100, Math.round((event.payload.progress ?? 0) * 100))),
        elapsedMs: Date.now() - startedAt,
        estimatedRemainingMs:
          typeof event.payload.etaSeconds === "number"
            ? Math.round(event.payload.etaSeconds * 1000)
            : undefined,
        message: "Rendering timeline...",
      })
    }
  )

  const unlistenCompleted = await listen<{ operation: string; outputPath: string }>(
    "video-processing-completed",
    (event) => {
      if (event.payload.operation !== "timeline-render") {
        return
      }
      onProgress({
        phase: "finalizing",
        percent: 95,
        elapsedMs: Date.now() - startedAt,
        message: "Finalizing export...",
      })
    }
  )

  const unlistenError = await listen<NativeVideoProgressEvent>(
    "video-processing-error",
    (event) => {
      if (event.payload.operation !== "timeline-render") {
        return
      }
      onProgress({
        phase: "error",
        percent: 0,
        message: event.payload.error ?? "Timeline render failed",
      })
    }
  )

  unlistenFns.push(unlistenStarted, unlistenProgress, unlistenCompleted, unlistenError)

  try {
    const result = await runner()
    onProgress({
      phase: "complete",
      percent: 100,
      elapsedMs: Date.now() - startedAt,
      message: "Export complete",
    })
    return result
  } finally {
    for (const unlisten of unlistenFns) {
      unlisten()
    }
  }
}

// =============================================================================
// Create Media API
// =============================================================================

export function createMediaAPI(pluginId: string, _manager: PluginManager): PluginMediaAPI {
  const api: PluginMediaAPI = {
    image: {
      load: loadImage,

      save: async (imageData: ImageData, options?: ImageProcessingOptions): Promise<Blob> => {
        const format = options?.format || "png"
        const quality = (options?.quality || 92) / 100

        let processedData = imageData
        if (options?.width || options?.height) {
          const width = options.width || imageData.width
          const height = options.height || imageData.height
          processedData = resizeImageData(imageData, width, height, options.maintainAspectRatio)
        }

        const canvas = createOffscreenCanvas(processedData.width, processedData.height)
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("Failed to get canvas context")
        ctx.putImageData(processedData, 0, 0)

        return canvas.convertToBlob({ type: `image/${format}`, quality })
      },

      toDataUrl: imageDataToDataUrl,
      fromDataUrl: dataUrlToImageData,
      resize: resizeImageData,
      transform: transformImageData,
      adjust: adjustImageData,

      applyFilter: async (
        imageData: ImageData,
        filterId: string,
        params?: Record<string, unknown>
      ): Promise<ImageData> => {
        const filter = mediaRegistry.getFilter(filterId)
        if (!filter) {
          throw new Error(`Filter not found: ${filterId}`)
        }
        return filter.apply(imageData, params)
      },

      getHistogram,

      compare: (image1: ImageData, image2: ImageData): { similarity: number; diff?: ImageData } => {
        if (image1.width !== image2.width || image1.height !== image2.height) {
          return { similarity: 0 }
        }

        let diffSum = 0
        const diffData = new Uint8ClampedArray(image1.data.length)

        for (let i = 0; i < image1.data.length; i += 4) {
          const dr = Math.abs(image1.data[i] - image2.data[i])
          const dg = Math.abs(image1.data[i + 1] - image2.data[i + 1])
          const db = Math.abs(image1.data[i + 2] - image2.data[i + 2])

          diffSum += (dr + dg + db) / 3

          diffData[i] = dr
          diffData[i + 1] = dg
          diffData[i + 2] = db
          diffData[i + 3] = 255
        }

        const maxDiff = (image1.data.length / 4) * 255
        const similarity = 1 - diffSum / maxDiff

        return {
          similarity,
          diff: new ImageData(diffData, image1.width, image1.height),
        }
      },
    },

    video: {
      loadClip: async (source: string | Blob | File): Promise<VideoClip> => {
        const sourcePath = ensurePathSource(source)
        const info = await getNativeVideoInfo(sourcePath)
        return persistClip(buildVideoClip(sourcePath, info), sourcePath, info.sourceToken)
      },

      getFrame: async (clipId: string, time: number): Promise<ImageData> => {
        const entry = requireClip(clipId)
        if (!entry.sourceToken) {
          throw new Error(`Video clip is not backed by an authorized local source: ${clipId}`)
        }
        const frame = await invoke<ArrayBuffer>("plugin_media_get_video_frame", {
          sourceToken: entry.sourceToken,
          time,
        })
        return frameResponseToImageData(frame)
      },

      getMetadata: async (source: string | Blob | File) => {
        const sourcePath = ensurePathSource(source)
        const info = await getNativeVideoInfo(sourcePath)
        return {
          duration: info.durationMs / 1000,
          width: info.width,
          height: info.height,
          fps: info.fps,
          codec: info.codec,
          bitrate: 0,
          hasAudio: info.hasAudio,
        }
      },

      analyze: async (
        source: string | Blob | File,
        options: VideoAnalysisOptions = {}
      ): Promise<VideoAnalysisManifest> => {
        const filePath = ensurePathSource(source)
        const info = await getNativeVideoInfo(filePath)
        return invoke<VideoAnalysisManifest>("video_analyze", {
          options: {
            sourceToken: info.sourceToken,
            ...options,
          },
        })
      },

      cleanupAnalysis: async (manifest: VideoAnalysisManifest): Promise<void> => {
        await invoke<void>("video_cleanup_analysis", {
          outputDirectory: manifest.outputDirectory,
        })
      },

      trim: async (clipId: string, startTime: number, endTime: number): Promise<VideoClip> => {
        const entry = requireClip(clipId)
        if (!entry.sourceToken) {
          throw new Error(`Video clip is not backed by an authorized local source: ${clipId}`)
        }
        const safeStart = Math.max(0, startTime)
        const safeEnd = Math.max(safeStart, endTime)
        const result = await invoke<{ outputPath: string }>("video_trim", {
          options: {
            sourceToken: entry.sourceToken,
            startTime: safeStart,
            endTime: safeEnd,
            format: "mp4",
          },
        })
        const trimmedPath = result.outputPath
        const info = await getNativeVideoInfo(trimmedPath)
        return persistClip(buildVideoClip(trimmedPath, info), trimmedPath, info.sourceToken)
      },

      concatenate: async (clipIds: string[]): Promise<VideoClip> => {
        if (clipIds.length === 0) {
          throw new Error("No clips provided for concatenation")
        }
        const result = await invoke<{ outputPath: string }>("plugin_media_concatenate_videos", {
          clips: clipIds.map((clipId) => toNativeVideoClip(requireClip(clipId))),
        })
        const info = await getNativeVideoInfo(result.outputPath)
        return persistClip(
          buildVideoClip(result.outputPath, info),
          result.outputPath,
          info.sourceToken
        )
      },

      applyEffect: async (
        clipId: string,
        effectId: string,
        params?: Record<string, unknown>
      ): Promise<void> => {
        const entry = requireClip(clipId)
        if (!entry.sourceToken) {
          throw new Error(`Video clip is not backed by an authorized local source: ${clipId}`)
        }
        const effect = { id: effectId, params: params ?? {} }
        await invoke<void>("plugin_media_apply_video_effect", {
          sourceToken: entry.sourceToken,
          effect,
        })

        entry.effects.push(effect)
        updatePersistedClip(clipId, (clip) => {
          const nextFilters = clip.filters ? [...clip.filters] : []
          if (!nextFilters.includes(effectId)) {
            nextFilters.push(effectId)
          }
          return {
            ...clip,
            filters: nextFilters,
          }
        })
      },

      addTransition: async (
        fromClipId: string,
        toClipId: string,
        transition: VideoTransition
      ): Promise<void> => {
        const fromEntry = requireClip(fromClipId)
        const toEntry = requireClip(toClipId)
        await invoke<void>("plugin_media_add_transition", {
          fromClip: toNativeVideoClip(fromEntry),
          toClip: toNativeVideoClip(toEntry),
          transition,
        })

        updatePersistedClip(fromClipId, (clip) => ({
          ...clip,
          transitions: {
            ...(clip.transitions ?? {}),
            out: transition,
          },
        }))
      },

      export: async (clipIds: string[], options: VideoExportOptions): Promise<Blob> => {
        if (clipIds.length === 0) {
          throw new Error("No clips provided for export")
        }

        const bytes = await withTimelineProgress(options.onProgress, async () =>
          invoke<ArrayBuffer | number[] | Uint8Array>("plugin_media_export_video", {
            clips: clipIds.map((clipId) => toNativeVideoClip(requireClip(clipId))),
            options: {
              format: options.format,
              resolution: options.resolution,
              fps: options.fps,
              quality: options.quality,
              codec: options.codec,
              audioBitrate: options.audioBitrate,
              videoBitrate: options.videoBitrate,
              includeSubtitles: options.includeSubtitles ?? true,
              subtitleMode: options.subtitleMode ?? "both",
              overwrite: options.overwrite ?? true,
            },
          })
        )

        const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        const blob = new Blob([toBlobPart(payload)], { type: `video/${options.format}` })

        if (options.destinationPath) {
          const { writeFile, exists } = await import("@tauri-apps/plugin-fs")
          const fileExists = await exists(options.destinationPath).catch(() => false)
          if (fileExists && options.overwrite === false) {
            throw new Error(`File already exists: ${options.destinationPath}`)
          }
          await writeFile(options.destinationPath, payload)
        }

        return blob
      },
    },

    filters: {
      register: (filter: ImageFilterDefinition) => {
        mediaRegistry.registerFilter(pluginId, filter)
      },

      unregister: (filterId: string) => {
        mediaRegistry.unregisterFilter(`${pluginId}:${filterId}`)
      },

      getAll: () => mediaRegistry.getAllFilters(),
      getById: (filterId: string) => mediaRegistry.getFilter(filterId),
      getByCategory: (category: string) => mediaRegistry.getFiltersByCategory(category),
    },

    effects: {
      register: (effect: VideoEffectDefinition) => {
        mediaRegistry.registerEffect(pluginId, effect)
      },

      unregister: (effectId: string) => {
        mediaRegistry.unregisterEffect(`${pluginId}:${effectId}`)
      },

      getAll: () => mediaRegistry.getAllEffects(),
      getById: (effectId: string) => mediaRegistry.getEffect(effectId),
    },

    transitions: {
      register: (transition: VideoTransitionDefinition) => {
        mediaRegistry.registerTransition(pluginId, transition)
      },

      unregister: (transitionId: string) => {
        mediaRegistry.unregisterTransition(`${pluginId}:${transitionId}`)
      },

      getAll: () => mediaRegistry.getAllTransitions(),
      getById: (transitionId: string) => mediaRegistry.getTransition(transitionId),
    },

    ai: {
      generateImage: async (
        prompt: string,
        options?: MediaImageGenerationOptions
      ): Promise<ImageData> => {
        assertNoLeakingPii(pluginId, "ctx.media.ai.generateImage", [prompt])
        return runGeneratedMediaAi(pluginId, "ai.generateImage", async () => {
          const referenceImages = options?.referenceImages?.map((image) =>
            imageDataToDataUrl(image)
          )
          const generationPrompt =
            referenceImages?.length || options?.mask
              ? {
                  text: prompt,
                  images: referenceImages ?? [],
                  ...(options?.mask ? { mask: imageDataToDataUrl(options.mask) } : {}),
                }
              : prompt
          const result = await generateProviderImage({
            snapshot: currentProviderSettingsSnapshot(),
            prompt: generationPrompt,
            ...(options?.providerId ? { providerId: options.providerId } : {}),
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.size ? { size: options.size } : {}),
            ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
            ...(options?.seed !== undefined ? { seed: options.seed } : {}),
            ...(options?.providerOptions ? { providerOptions: options.providerOptions } : {}),
            ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
          })
          return dataUrlToImageData(`data:${result.image.mediaType};base64,${result.image.base64}`)
        })
      },

      generateVideo: async (
        prompt: string,
        options?: MediaVideoGenerationOptions
      ): Promise<Blob> => {
        assertNoLeakingPii(pluginId, "ctx.media.ai.generateVideo", [prompt])
        return runGeneratedMediaAi(pluginId, "ai.generateVideo", async () => {
          const generationPrompt = options?.inputImage
            ? {
                text: prompt,
                image: imageDataToDataUrl(options.inputImage),
              }
            : prompt
          const result = await generateProviderVideo({
            snapshot: currentProviderSettingsSnapshot(),
            prompt: generationPrompt,
            ...(options?.providerId ? { providerId: options.providerId } : {}),
            ...(options?.model ? { model: options.model } : {}),
            ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
            ...(options?.resolution ? { resolution: options.resolution } : {}),
            ...(options?.duration !== undefined ? { duration: options.duration } : {}),
            ...(options?.fps !== undefined ? { fps: options.fps } : {}),
            ...(options?.seed !== undefined ? { seed: options.seed } : {}),
            ...(options?.providerOptions ? { providerOptions: options.providerOptions } : {}),
            ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
          })
          return new Blob([toBlobPart(result.video.uint8Array)], {
            type: result.video.mediaType,
          })
        })
      },

      upscale: async (imageData: ImageData, factor: 2 | 4): Promise<ImageData> => {
        return runImageAi(pluginId, "ai.upscale", () =>
          executeProviderImageEdit(
            `Upscale this image by ${factor}x while preserving composition, colors, and fine details.`,
            imageData
          )
        )
      },

      removeBackground: async (imageData: ImageData): Promise<ImageData> => {
        return runImageAi(pluginId, "ai.removeBackground", () =>
          executeProviderImageEdit(
            "Remove the background from this image and keep the main subject cleanly isolated.",
            imageData
          )
        )
      },

      enhanceImage: async (
        imageData: ImageData,
        type: "denoise" | "sharpen" | "restore"
      ): Promise<ImageData> => {
        return runImageAi(pluginId, "ai.enhanceImage", () =>
          executeProviderImageEdit(
            `Enhance this image with a ${type} pass while preserving the original subject and composition.`,
            imageData
          )
        )
      },

      generateVariation: async (imageData: ImageData, prompt?: string): Promise<ImageData> => {
        // PII red-line: the free-form prompt goes verbatim to the image
        // provider (executeProviderImageEdit → /images/edits).
        assertNoLeakingPii(pluginId, "ctx.media.ai.generateVariation", [prompt])
        return runImageAi(pluginId, "ai.generateVariation", () =>
          executeProviderImageEdit(
            prompt
              ? `Create a variation of this image. ${prompt}`
              : "Create a faithful variation of this image while preserving the core subject.",
            imageData
          )
        )
      },

      inpaint: async (
        imageData: ImageData,
        mask: ImageData,
        prompt: string
      ): Promise<ImageData> => {
        assertNoLeakingPii(pluginId, "ctx.media.ai.inpaint", [prompt])
        return runImageAi(pluginId, "ai.inpaint", () =>
          executeProviderImageEdit(
            `Modify only the masked region of this image. ${prompt}`,
            imageData,
            mask
          )
        )
      },
    },

    utils: {
      createCanvas: createOffscreenCanvas,

      getImageDataFromCanvas: (canvas: OffscreenCanvas | HTMLCanvasElement): ImageData => {
        const ctx = canvas.getContext("2d") as
          CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
        if (!ctx) throw new Error("Failed to get canvas context")
        return ctx.getImageData(0, 0, canvas.width, canvas.height)
      },

      putImageDataToCanvas: (
        imageData: ImageData,
        canvas: OffscreenCanvas | HTMLCanvasElement
      ): void => {
        const ctx = canvas.getContext("2d") as
          CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
        if (!ctx) throw new Error("Failed to get canvas context")
        ctx.putImageData(imageData, 0, 0)
      },

      blobToBase64: (blob: Blob): Promise<string> => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      },

      base64ToBlob: (base64: string, mimeType: string): Blob => {
        const byteString = atob(base64.split(",")[1] || base64)
        const arrayBuffer = new ArrayBuffer(byteString.length)
        const uint8Array = new Uint8Array(arrayBuffer)
        for (let i = 0; i < byteString.length; i++) {
          uint8Array[i] = byteString.charCodeAt(i)
        }
        return new Blob([arrayBuffer], { type: mimeType })
      },

      downloadFile: (blob: Blob, filename: string): void => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      },

      registerCatalogAsset: (
        catalog: MediaCatalogWriter,
        asset: Omit<PluginMediaAssetInput, "pluginId">
      ): string => {
        return registerPluginMediaAsset(catalog, {
          ...asset,
          pluginId,
        })
      },
    },
  }

  // `image`/`filters`/`effects`/`transitions`/`utils` are pure in-memory
  // transforms over caller-supplied data — no host resource to protect. The
  // `video` pipeline touches decoded media state and disk-weight exports, and
  // `ai.*` spends the user's provider quota (executeProviderImageEdit), so
  // both namespaces are permission-gated.
  return {
    ...api,
    video: createApiGuardedAPI(pluginId, api.video, {
      loadClip: "media:video:read",
      getFrame: "media:video:read",
      getMetadata: "media:video:read",
      analyze: "media:video:read",
      cleanupAnalysis: "media:video:write",
      trim: "media:video:write",
      concatenate: "media:video:write",
      applyEffect: "media:video:write",
      addTransition: "media:video:write",
      export: "media:video:export",
    }),
    ai: createApiGuardedAPI(pluginId, api.ai, {
      generateImage: "ai:chat",
      generateVideo: "ai:chat",
      upscale: "ai:chat",
      removeBackground: "ai:chat",
      enhanceImage: "ai:chat",
      generateVariation: "ai:chat",
      inpaint: "ai:chat",
    }),
  }
}
