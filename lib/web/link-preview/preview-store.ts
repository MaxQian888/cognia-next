/**
 * In-memory link preview cache (ADR-0218).
 *
 * Deliberately not persisted: a preview is cheap to refetch, stale metadata is
 * worse than none, and a Dexie table would cost a schema bump for nothing a
 * reload cannot rebuild. What this owns:
 *
 *   - one LRU of page previews, 30 minutes for a success and 5 for a failure,
 *     so a dead link is not re-requested on every hover;
 *   - one shared in-flight request per URL, so two links to the same page (or
 *     the message and the composer) cost one fetch;
 *   - one weight-capped LRU of preview images as `data:` URLs for the desktop,
 *     whose CSP blocks remote `<img>` sources. Other shells load the remote URL
 *     directly and never fill it.
 *
 * Subscribers are notified when an entry settles, so every mounted card for a
 * URL updates together.
 */

import { LruCache } from "@cognia/primitives"
import { platformFetchKind, type PlatformFetchKind } from "@/lib/network/platform-fetch"
import {
  canFetchLinkPreviews,
  fetchLinkPreview,
  fetchPreviewImageAsDataUrl,
  type LinkPreview,
  type LinkPreviewDeps,
} from "./fetch-preview"

export const LINK_PREVIEW_TTL_MS = 30 * 60 * 1000
export const LINK_PREVIEW_ERROR_TTL_MS = 5 * 60 * 1000

export type LinkPreviewEntry =
  | { status: "ready"; preview: LinkPreview; expiresAt: number }
  | { status: "error"; expiresAt: number }

type Listener = () => void

const previews = new LruCache<LinkPreviewEntry>(200)
const inflight = new Map<string, Promise<LinkPreview | null>>()

// ~24 MB of UTF-16 `data:` strings; one oversized image is skipped, not cached.
const images = new LruCache<string>(150, {
  maxWeight: 24 * 1024 * 1024,
  weigh: (value, key) => 2 * (value.length + key.length),
})
const failedImages = new LruCache<number>(300)
const imageInflight = new Map<string, Promise<string | null>>()

const listeners = new Map<string, Set<Listener>>()
let deps: LinkPreviewDeps = {}

function notify(key: string): void {
  listeners.get(key)?.forEach((listener) => listener())
}

/** Subscribe to settle events for one URL (page or image). */
export function subscribeLinkPreview(key: string, listener: Listener): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

/** The live entry for `url`, or undefined when absent or expired. */
export function peekLinkPreview(url: string, now = Date.now()): LinkPreviewEntry | undefined {
  const entry = previews.get(url)
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    previews.delete(url)
    return undefined
  }
  return entry
}

/**
 * Load (or reuse) the preview for `url`. Resolves to null on any failure; the
 * failure is cached for {@link LINK_PREVIEW_ERROR_TTL_MS}. Never rejects.
 */
export function loadLinkPreview(url: string): Promise<LinkPreview | null> {
  const cached = peekLinkPreview(url)
  if (cached) return Promise.resolve(cached.status === "ready" ? cached.preview : null)
  const pending = inflight.get(url)
  if (pending) return pending

  const task = fetchLinkPreview(url, {}, deps)
    .then((preview) => {
      previews.set(url, { status: "ready", preview, expiresAt: Date.now() + LINK_PREVIEW_TTL_MS })
      return preview
    })
    .catch(() => {
      previews.set(url, { status: "error", expiresAt: Date.now() + LINK_PREVIEW_ERROR_TTL_MS })
      return null
    })
    .finally(() => {
      inflight.delete(url)
      notify(url)
    })
  inflight.set(url, task)
  return task
}

/** Whether images must be inlined as `data:` URLs on this shell. */
export function previewImagesNeedInlining(
  kind: PlatformFetchKind = deps.kind ?? platformFetchKind()
): boolean {
  return kind === "tauri"
}

/**
 * The `src` an `<img>` should use for `url` right now: the remote URL itself
 * where remote images load, the cached `data:` URL on the desktop, or null
 * while it is unknown or failed.
 */
export function peekPreviewImage(url: string, now = Date.now()): string | null {
  if (/^data:image\//i.test(url)) return url
  if (!previewImagesNeedInlining()) return url
  const failedUntil = failedImages.get(url)
  if (failedUntil !== undefined && failedUntil > now) return null
  return images.get(url) ?? null
}

/** Whether `url` is known not to load on this shell (until the error TTL lapses). */
export function previewImageFailed(url: string, now = Date.now()): boolean {
  const failedUntil = failedImages.get(url)
  return failedUntil !== undefined && failedUntil > now
}

/** Record that a remote `<img>` failed, so it is not retried for the error TTL. */
export function markPreviewImageFailed(url: string): void {
  failedImages.set(url, Date.now() + LINK_PREVIEW_ERROR_TTL_MS)
  notify(url)
}

/**
 * Make `url` displayable: on the desktop fetch it once as a `data:` URL, and
 * elsewhere it already is. Resolves to null when it cannot be shown.
 */
export function loadPreviewImage(url: string): Promise<string | null> {
  const ready = peekPreviewImage(url)
  if (ready) return Promise.resolve(ready)
  if (previewImageFailed(url)) return Promise.resolve(null)
  if (!canFetchLinkPreviews(deps.kind ?? platformFetchKind())) return Promise.resolve(null)
  const pending = imageInflight.get(url)
  if (pending) return pending

  const task = fetchPreviewImageAsDataUrl(url, {}, deps)
    .then((dataUrl) => {
      images.set(url, dataUrl)
      return dataUrl
    })
    .catch(() => {
      failedImages.set(url, Date.now() + LINK_PREVIEW_ERROR_TTL_MS)
      return null
    })
    .finally(() => {
      imageInflight.delete(url)
      notify(url)
    })
  imageInflight.set(url, task)
  return task
}

/** Test seam: pin the transport and clear every cache. */
export function __resetLinkPreviewStoreForTesting(next: LinkPreviewDeps = {}): void {
  deps = next
  previews.clear()
  images.clear()
  failedImages.clear()
  inflight.clear()
  imageInflight.clear()
  listeners.clear()
}
