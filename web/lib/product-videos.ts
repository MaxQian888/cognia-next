/**
 * Product film lookup (ADR-0092, product footage amendment).
 *
 * `web/scripts/render-video.mjs` renders the HyperFrames project in
 * `web/video/` from real recordings of the application and writes
 * `web/content/generated/product-videos.json`, keyed *film × locale*. Pages
 * ask this module for a film; when it has not been rendered it answers null
 * and the caller keeps its previous visual, so a missing render degrades to
 * the reconstruction rather than to a broken player.
 */

import manifest from "@web/content/generated/product-videos.json"
import type { Locale } from "./locale"

/** The films the render script produces (`web/video/index.html`, `compositions/hero-loop.html`). */
export type ProductFilmId = "hero-loop" | "product-film"

export interface ProductVideo {
  /** Public path of the H.264 MP4, content-hashed so it can be cached forever. */
  src: string
  /** Public path of the still shown before playback and under reduced motion. */
  poster: string
  width: number
  height: number
  /** Encoded size, for the render script's budget report. */
  bytes: number
  durationS: number
  /** WebVTT caption track, for films a reader watches rather than glances at. */
  captions?: string
  /** Whether the file carries an audio track. */
  hasAudio: boolean
}

interface VideoManifest {
  renderedAt: string | null
  videos: Record<string, ProductVideo>
}

const VIDEOS = manifest as VideoManifest

export function videoKey(id: ProductFilmId, locale: Locale): string {
  return `${id}-${locale}`
}

/** One rendered film, or null when the render has not produced it. */
export function findVideo(id: ProductFilmId, locale: Locale): ProductVideo | null {
  return VIDEOS.videos[videoKey(id, locale)] ?? null
}

/** When the committed films were rendered, for the render script's own report. */
export function renderedAt(): string | null {
  return VIDEOS.renderedAt
}
