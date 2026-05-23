/**
 * A2UI Thumbnail Generation Module
 * Provides automatic thumbnail generation for A2UI apps
 */

import html2canvas from "html2canvas"
import { loggers } from "@/lib/logging"

const log = loggers.ui

// ============== Types ==============

export interface ThumbnailOptions {
  width?: number
  height?: number
  quality?: number
  format?: "png" | "jpeg" | "webp"
  backgroundColor?: string
  scale?: number
}

export interface ThumbnailResult {
  dataUrl: string
  width: number
  height: number
  format: string
  generatedAt: number
}

// ============== Constants ==============

const DEFAULT_OPTIONS: Required<ThumbnailOptions> = {
  width: 280,
  height: 180,
  quality: 0.8,
  format: "webp",
  backgroundColor: "#ffffff",
  scale: 1,
}

const THUMBNAIL_STORAGE_KEY = "a2ui-app-thumbnails"
const MAX_THUMBNAIL_SIZE = 50 * 1024 // 50KB max per thumbnail

// ============== Thumbnail Generation ==============

/**
 * Generate a thumbnail from an HTML element
 */
export async function generateThumbnail(
  element: HTMLElement,
  options: ThumbnailOptions = {}
): Promise<ThumbnailResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  try {
    // Capture the element using html2canvas
    const canvas = await html2canvas(element, {
      backgroundColor: opts.backgroundColor,
      scale: opts.scale,
      logging: false,
      useCORS: true,
      allowTaint: true,
      width: element.offsetWidth,
      height: element.offsetHeight,
    })

    // Create a scaled canvas for the thumbnail
    const thumbCanvas = document.createElement("canvas")
    thumbCanvas.width = opts.width
    thumbCanvas.height = opts.height
    const ctx = thumbCanvas.getContext("2d")

    if (!ctx) {
      throw new Error("Failed to get canvas context")
    }

    // Calculate scaling to fit the element in the thumbnail
    const sourceWidth = canvas.width
    const sourceHeight = canvas.height
    const targetWidth = opts.width
    const targetHeight = opts.height

    // Calculate aspect ratios
    const sourceRatio = sourceWidth / sourceHeight
    const targetRatio = targetWidth / targetHeight

    let drawWidth: number
    let drawHeight: number
    let offsetX = 0
    let offsetY = 0

    if (sourceRatio > targetRatio) {
      // Source is wider - fit to height
      drawHeight = targetHeight
      drawWidth = sourceWidth * (targetHeight / sourceHeight)
      offsetX = (targetWidth - drawWidth) / 2
    } else {
      // Source is taller - fit to width
      drawWidth = targetWidth
      drawHeight = sourceHeight * (targetWidth / sourceWidth)
      offsetY = (targetHeight - drawHeight) / 2
    }

    // Fill background
    ctx.fillStyle = opts.backgroundColor
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    // Draw the scaled image
    ctx.drawImage(canvas, offsetX, offsetY, drawWidth, drawHeight)

    // Convert to data URL
    const mimeType = `image/${opts.format}`
    let dataUrl = thumbCanvas.toDataURL(mimeType, opts.quality)

    // If the thumbnail is too large, reduce quality
    if (dataUrl.length > MAX_THUMBNAIL_SIZE && opts.quality > 0.3) {
      const reducedQuality = opts.quality - 0.2
      dataUrl = thumbCanvas.toDataURL(mimeType, reducedQuality)
    }

    return {
      dataUrl,
      width: opts.width,
      height: opts.height,
      format: opts.format,
      generatedAt: Date.now(),
    }
  } catch (error) {
    log.error("A2UI Thumbnail generation failed", error as Error)
    throw error
  }
}

/**
 * Generate a thumbnail for a specific A2UI surface by ID
 */
export async function captureSurfaceThumbnail(
  surfaceId: string,
  options?: ThumbnailOptions
): Promise<ThumbnailResult | null> {
  // Find the surface element in the DOM
  const surfaceElement = document.querySelector(`[data-surface-id="${surfaceId}"]`) as HTMLElement

  if (!surfaceElement) {
    log.warn(`A2UI Thumbnail: Surface element not found: ${surfaceId}`)
    return null
  }

  try {
    return await generateThumbnail(surfaceElement, options)
  } catch (error) {
    log.error(`A2UI Thumbnail: Failed to capture surface ${surfaceId}`, error as Error)
    return null
  }
}

/**
 * Generate a placeholder thumbnail with icon and text
 */
export function generatePlaceholderThumbnail(
  iconName: string,
  title: string,
  options: ThumbnailOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const canvas = document.createElement("canvas")
  canvas.width = opts.width
  canvas.height = opts.height
  const ctx = canvas.getContext("2d")

  if (!ctx) {
    return ""
  }

  // Background gradient
  const gradient = ctx.createLinearGradient(0, 0, opts.width, opts.height)
  gradient.addColorStop(0, "#f8fafc")
  gradient.addColorStop(1, "#e2e8f0")
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, opts.width, opts.height)

  // Draw centered text
  ctx.fillStyle = "#64748b"
  ctx.font = "bold 14px system-ui, sans-serif"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"

  // Truncate title if too long
  const maxTitleLength = 20
  const displayTitle =
    title.length > maxTitleLength ? title.substring(0, maxTitleLength) + "..." : title

  ctx.fillText(displayTitle, opts.width / 2, opts.height / 2 + 20)

  // Draw icon placeholder (circle with first letter)
  const iconSize = 48
  const iconX = opts.width / 2
  const iconY = opts.height / 2 - 20

  ctx.fillStyle = "#3b82f6"
  ctx.beginPath()
  ctx.arc(iconX, iconY, iconSize / 2, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = "#ffffff"
  ctx.font = "bold 24px system-ui, sans-serif"
  ctx.fillText(title.charAt(0).toUpperCase(), iconX, iconY)

  return canvas.toDataURL(`image/${opts.format}`, opts.quality)
}

// ============== Storage Management ==============

interface ThumbnailCache {
  [appId: string]: {
    dataUrl: string
    updatedAt: number
  }
}

/**
 * Load thumbnails from localStorage
 */
function loadThumbnailCache(): ThumbnailCache {
  if (typeof window === "undefined") return {}

  try {
    const stored = localStorage.getItem(THUMBNAIL_STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored) as ThumbnailCache
    }
  } catch (error) {
    log.error("A2UI Thumbnail: Failed to load cache", error as Error)
  }
  return {}
}

/**
 * Save thumbnails to localStorage
 */
function saveThumbnailCache(cache: ThumbnailCache): void {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(THUMBNAIL_STORAGE_KEY, JSON.stringify(cache))
  } catch (error) {
    log.error("A2UI Thumbnail: Failed to save cache", error as Error)
    // If storage is full, try to clean up old thumbnails
    cleanupOldThumbnails(cache)
  }
}

/**
 * Clean up old/unused thumbnails
 */
function cleanupOldThumbnails(cache: ThumbnailCache): void {
  const now = Date.now()
  const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

  const cleanedCache: ThumbnailCache = {}
  for (const [appId, data] of Object.entries(cache)) {
    if (now - data.updatedAt < maxAge) {
      cleanedCache[appId] = data
    }
  }

  try {
    localStorage.setItem(THUMBNAIL_STORAGE_KEY, JSON.stringify(cleanedCache))
  } catch {
    // If still failing, clear all thumbnails
    localStorage.removeItem(THUMBNAIL_STORAGE_KEY)
  }
}

/**
 * Save a thumbnail for an app
 */
export function saveThumbnail(appId: string, dataUrl: string): void {
  const cache = loadThumbnailCache()
  cache[appId] = {
    dataUrl,
    updatedAt: Date.now(),
  }
  saveThumbnailCache(cache)
}

/**
 * Get a thumbnail for an app
 */
export function getThumbnail(appId: string): string | null {
  const cache = loadThumbnailCache()
  return cache[appId]?.dataUrl || null
}

/**
 * Delete a thumbnail for an app
 */
export function deleteThumbnail(appId: string): void {
  const cache = loadThumbnailCache()
  delete cache[appId]
  saveThumbnailCache(cache)
}

/**
 * Check if a thumbnail needs to be refreshed
 */
export function isThumbnailStale(appId: string, lastModified: number): boolean {
  const cache = loadThumbnailCache()
  const cached = cache[appId]

  if (!cached) return true

  // Thumbnail is stale if app was modified after thumbnail was generated
  return lastModified > cached.updatedAt
}

/**
 * Get all cached thumbnails
 */
export function getAllThumbnails(): ThumbnailCache {
  return loadThumbnailCache()
}

/**
 * Clear all cached thumbnails
 */
export function clearAllThumbnails(): void {
  if (typeof window === "undefined") return
  localStorage.removeItem(THUMBNAIL_STORAGE_KEY)
}

/**
 * Sync thumbnails with existing apps (remove orphaned thumbnails)
 */
export function syncThumbnailsWithApps(existingAppIds: string[]): void {
  const cache = loadThumbnailCache()
  const existingSet = new Set(existingAppIds)

  let changed = false
  for (const appId of Object.keys(cache)) {
    if (!existingSet.has(appId)) {
      delete cache[appId]
      changed = true
    }
  }

  if (changed) {
    saveThumbnailCache(cache)
  }
}
