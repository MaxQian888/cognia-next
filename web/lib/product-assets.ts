/**
 * Product screenshot lookup (ADR-0092 §8).
 *
 * The capture script writes `web/content/generated/product-shots.json` listing
 * every image it produced, keyed *section × theme × locale*. Pages ask this
 * module for a shot; when the matrix has not been captured yet it answers null,
 * and the stage renders a labelled placeholder rather than a broken image or —
 * worse — a mocked-up interface presented as the product.
 */

import manifest from "@web/content/generated/product-shots.json"
import type { Locale } from "./locale"

export type Theme = "light" | "dark"

export interface ProductShot {
  /** Public path, e.g. `/product/hero-light-en.png`. */
  src: string
  width: number
  height: number
}

export interface ProductShotPair {
  light: ProductShot
  dark: ProductShot
}

interface ShotManifest {
  capturedAt: string | null
  shots: Record<string, ProductShot>
}

const SHOTS = manifest as ShotManifest

export function shotKey(section: string, theme: Theme, locale: Locale): string {
  return `${section}-${theme}-${locale}`
}

/** A single captured image, or null when the matrix does not have it yet. */
export function findShot(section: string, theme: Theme, locale: Locale): ProductShot | null {
  return SHOTS.shots[shotKey(section, theme, locale)] ?? null
}

/**
 * Both themes for a section, or null unless *both* exist. A page that showed
 * the light capture in dark mode because only one was taken would be worse than
 * one that showed neither: the reader would assume the product looks like that.
 */
export function findShotPair(section: string, locale: Locale): ProductShotPair | null {
  const light = findShot(section, "light", locale)
  const dark = findShot(section, "dark", locale)
  if (!light || !dark) return null
  return { light, dark }
}

/** When the committed matrix was produced, for the capture script's own report. */
export function capturedAt(): string | null {
  return SHOTS.capturedAt
}
