"use client"

import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"
import type { WallpaperSource } from "@/types/appearance"
import { ensureForegroundContrast } from "./ensure-contrast"
import { DEFAULT_FALLBACKS } from "./vscode-theme/token-mapping"
import { disposeUrl, resolveSourceToCss } from "./wallpaper-storage"

const SAMPLE_WIDTH = 48
const MIN_SAMPLE_HEIGHT = 12
const MAX_SAMPLE_HEIGHT = 96
const VISIBLE_ALPHA = 96
const LIGHT_VARIANT_THRESHOLD = 0.58

export interface WallpaperThemeAnalysis {
  accent: string
  averageLuminance: number
  baseVariant: "light" | "dark"
}

/**
 * Analyze a small RGBA raster and extract the only image-derived decisions
 * Cognia needs for theme generation: a usable accent and the image's overall
 * light/dark character. The saturation/luminance weighting is adapted from
 * the MIT-licensed Codex Dream Skin renderer, but kept independent of DOM and
 * persistence so callers and tests cross one small seam.
 */
export function analyzeWallpaperPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number
): WallpaperThemeAnalysis {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("wallpaper dimensions are invalid")
  }
  if (data.length < width * height * 4) {
    throw new Error("wallpaper pixel buffer is incomplete")
  }

  let count = 0
  let totalRed = 0
  let totalGreen = 0
  let totalBlue = 0
  let totalLuminance = 0
  let accentRed = 0
  let accentGreen = 0
  let accentBlue = 0
  let accentWeight = 0

  for (let offset = 0; offset < width * height * 4; offset += 4) {
    if ((data[offset + 3] ?? 0) < VISIBLE_ALPHA) continue
    const red = data[offset] ?? 0
    const green = data[offset + 1] ?? 0
    const blue = data[offset + 2] ?? 0
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255

    totalRed += red
    totalGreen += green
    totalBlue += blue
    totalLuminance += luminance
    count += 1

    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    const saturation = max === 0 ? 0 : (max - min) / max
    const usableLuminance = 1 - Math.min(1, Math.abs(luminance - 0.46) / 0.54)
    const weight = saturation ** 2 * (0.15 + usableLuminance)
    accentRed += red * weight
    accentGreen += green * weight
    accentBlue += blue * weight
    accentWeight += weight
  }

  if (count === 0) throw new Error("wallpaper contains no visible pixels")

  const averageLuminance = totalLuminance / count
  const average = [totalRed / count, totalGreen / count, totalBlue / count]
  const accent =
    accentWeight > 1
      ? [accentRed / accentWeight, accentGreen / accentWeight, accentBlue / accentWeight]
      : average

  return {
    accent: rgbToHex(accent),
    averageLuminance,
    baseVariant: averageLuminance >= LIGHT_VARIANT_THRESHOLD ? "light" : "dark",
  }
}

/** Decode and downsample one persisted Cognia wallpaper locally. */
export async function analyzeWallpaperSource(
  source: Extract<WallpaperSource, { kind: "image" }>
): Promise<WallpaperThemeAnalysis> {
  const css = await resolveSourceToCss(source)
  try {
    const imageUrl = extractCssUrl(css)
    const image = await loadImage(imageUrl)
    const height = Math.max(
      MIN_SAMPLE_HEIGHT,
      Math.min(
        MAX_SAMPLE_HEIGHT,
        Math.round((SAMPLE_WIDTH * image.naturalHeight) / image.naturalWidth)
      )
    )
    const canvas = document.createElement("canvas")
    canvas.width = SAMPLE_WIDTH
    canvas.height = height
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) throw new Error("wallpaper analysis canvas is unavailable")
    context.drawImage(image, 0, 0, SAMPLE_WIDTH, height)
    return analyzeWallpaperPixels(
      context.getImageData(0, 0, SAMPLE_WIDTH, height).data,
      SAMPLE_WIDTH,
      height
    )
  } finally {
    disposeUrl(css)
  }
}

/** Build a persistent dual-variant Cognia theme from a wallpaper analysis. */
export function buildWallpaperTheme(
  name: string,
  analysis: WallpaperThemeAnalysis
): Omit<CustomTheme, "id"> {
  const light = ensureForegroundContrast(applyAccent(DEFAULT_FALLBACKS.light, analysis.accent))
  const dark = ensureForegroundContrast(applyAccent(DEFAULT_FALLBACKS.dark, analysis.accent))
  const tokens = { light, dark }
  const colors = tokens[analysis.baseVariant]

  return {
    name,
    baseVariant: analysis.baseVariant,
    tokens,
    colors,
    isDark: analysis.baseVariant === "dark",
  }
}

function applyAccent(tokens: ThemeColors, accent: string): ThemeColors {
  return {
    ...tokens,
    primary: accent,
    accent,
    ring: accent,
    sidebarPrimary: accent,
    sidebarRing: accent,
  }
}

function rgbToHex(channels: number[]): string {
  return `#${channels
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`
}

function extractCssUrl(css: string): string {
  const match = /^url\((['"]?)(.*)\1\)$/.exec(css.trim())
  if (!match?.[2]) throw new Error("wallpaper source is not an image URL")
  return match[2]
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("wallpaper image could not be decoded"))
    image.src = url
  })
}
