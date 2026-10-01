"use client"

/**
 * Persisted wallpaper analyses for the legibility guard.
 *
 * The guard needs an analysis before it can cap the wallpaper, and decoding an
 * image takes a frame or two after the layer is already painted. Without a
 * cache every launch would paint the image uncapped, then dim it — a visible
 * flash on exactly the wallpapers that need the guard most. The analysis is a
 * handful of colours, so it is mirrored in `localStorage` keyed by the
 * wallpaper id AND the bytes it points at: swapping the file behind an id
 * (a plugin can) must not reuse a stale answer.
 *
 * A cache, never a source of truth. Every failure mode (no storage, quota,
 * malformed JSON, an entry written by another build) degrades to "not cached",
 * which only costs a re-analysis.
 */

import type { Wallpaper, WallpaperSource } from "@/types/appearance"
import type { WallpaperThemeAnalysis } from "./wallpaper-theme-generator"

const STORAGE_KEY = "cognia.wallpaper-analysis.v1"
/**
 * Entries kept. A rotation playlist cycles through a few dozen wallpapers at
 * most; beyond that the oldest entry is dropped, which bounds what deleted
 * wallpapers can leave behind.
 */
const MAX_ENTRIES = 32

/** In-memory layer over the mirror, so one session never re-parses it. */
const memory = new Map<string, WallpaperThemeAnalysis>()

/**
 * Told whenever an analysis lands. The guard produces analyses; wallpaper-driven
 * auto light/dark and the panel's theme-fit hint consume them, and must not
 * wait for their own next tick to notice a new wallpaper was measured.
 */
const listeners = new Set<() => void>()

export function subscribeAnalysisCache(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Stable identity for what a wallpaper paints. A data URL is hashed rather than
 * embedded — built-in presets inline whole images, and the key is stored.
 */
export function analysisCacheKey(wallpaper: Pick<Wallpaper, "id" | "source">): string {
  return `${wallpaper.id}:${sourceLocator(wallpaper.source)}`
}

function sourceLocator(source: WallpaperSource): string {
  switch (source.kind) {
    case "color":
      return `color:${source.value}`
    case "gradient":
      return `gradient:${hash(source.css)}`
    case "image":
      switch (source.storage) {
        case "disk":
          return `disk:${source.relPath}`
        case "indexeddb":
          return `idb:${source.blobKey}`
        case "data-url":
          return `data:${source.dataUrl.length}:${hash(source.dataUrl)}`
      }
  }
}

/** 32-bit FNV-1a. Collisions only cost a wrong cache hit on a colour summary. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const STRING_FIELDS = ["accent", "secondary", "dominant", "darkExtreme", "brightExtreme"] as const
const NUMBER_FIELDS = ["averageLuminance", "luminanceSpread"] as const

function isAnalysis(value: unknown): value is WallpaperThemeAnalysis {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    STRING_FIELDS.every((f) => typeof v[f] === "string") &&
    NUMBER_FIELDS.every((f) => typeof v[f] === "number" && Number.isFinite(v[f])) &&
    (v.baseVariant === "light" || v.baseVariant === "dark")
  )
}

type Mirror = Array<[string, WallpaperThemeAnalysis]>

function readMirror(): Mirror {
  if (typeof localStorage === "undefined") return []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is [string, WallpaperThemeAnalysis] =>
        Array.isArray(entry) && typeof entry[0] === "string" && isAnalysis(entry[1])
    )
  } catch {
    return []
  }
}

export function readCachedAnalysis(key: string): WallpaperThemeAnalysis | null {
  const hit = memory.get(key)
  if (hit) return hit
  const found = readMirror().find(([k]) => k === key)?.[1] ?? null
  if (found) memory.set(key, found)
  return found
}

export function writeCachedAnalysis(key: string, analysis: WallpaperThemeAnalysis): void {
  memory.set(key, analysis)
  persist(key, analysis)
  // A throwing listener must not stop the others, nor the writer.
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (err) {
      console.warn("wallpaper analysis listener failed", err)
    }
  }
}

function persist(key: string, analysis: WallpaperThemeAnalysis): void {
  if (typeof localStorage === "undefined") return
  // Most recent last; the oldest falls off the front.
  const next: Mirror = [...readMirror().filter(([k]) => k !== key), [key, analysis]]
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-MAX_ENTRIES)))
  } catch {
    // Quota or disabled storage: the in-memory entry still serves this session.
  }
}

/** The cached analysis of whatever wallpaper is `wallpaper`, or null. */
export function readCachedAnalysisFor(
  wallpaper: Pick<Wallpaper, "id" | "source"> | null
): WallpaperThemeAnalysis | null {
  return wallpaper ? readCachedAnalysis(analysisCacheKey(wallpaper)) : null
}

/** Exposed for tests. */
export const __INTERNALS__ = {
  STORAGE_KEY,
  MAX_ENTRIES,
  resetMemory: () => memory.clear(),
}
