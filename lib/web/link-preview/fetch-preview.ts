/**
 * Fetch one link preview (ADR-0218).
 *
 * The request leaves from the user's machine, for a URL a model (or a user)
 * wrote, so every guard runs before a byte is sent:
 *
 *   - only http(s), via `normalizeHttpUrl`;
 *   - `assertFetchTargetAllowed` refuses loopback, private-network and
 *     metadata hosts, and the desktop proxy re-checks redirects
 *     (`blockPrivateHosts`);
 *   - `isUrlSafeToDereference` refuses a URL whose own path or query carries
 *     PII, the same rule the send-time link context applies.
 *
 * Transport is `createPlatformFetch`: the native proxy on the desktop, native
 * HTTP on Capacitor. The browser build cannot read a cross-origin page (there
 * is no server, `app/api` does not exist at runtime), so it never calls this;
 * `canFetchLinkPreviews` is the gate the UI checks first.
 */

import { isUrlSafeToDereference, normalizeHttpUrl } from "@/lib/chat/link-context"
import {
  createPlatformFetch,
  platformFetchKind,
  type PlatformFetch,
  type PlatformFetchKind,
} from "@/lib/network/platform-fetch"
import { assertFetchTargetAllowed } from "@/lib/web/fetch-guard"
import { parseLinkMetadata, type ParsedLinkMetadata } from "./parse-metadata"

/** What a preview describes: an HTML page, an image URL, or any other file. */
export type LinkPreviewKind = "page" | "image" | "file"

export interface LinkPreview extends ParsedLinkMetadata {
  /** The URL that was asked for. */
  url: string
  /** Where the response came from after redirects, when the transport says. */
  finalUrl: string
  /** `finalUrl`'s host without `www.`. */
  host: string
  kind: LinkPreviewKind
  /** Response MIME type, without parameters. */
  contentType?: string
}

export type LinkPreviewRefusal = "unsupported-shell" | "invalid-url" | "blocked-host" | "pii"

/** Thrown before any request is made. Not retried: the answer will not change. */
export class LinkPreviewRefusedError extends Error {
  constructor(readonly reason: LinkPreviewRefusal) {
    super(`Link preview refused: ${reason}`)
    this.name = "LinkPreviewRefusedError"
  }
}

/** Thrown for a non-2xx response. */
export class LinkPreviewHttpError extends Error {
  constructor(readonly status: number) {
    super(`Link preview request failed with HTTP ${status}`)
    this.name = "LinkPreviewHttpError"
  }
}

export const LINK_PREVIEW_TIMEOUT_MS = 8_000
/** Only the head is needed; a page larger than this is cut before parsing. */
export const LINK_PREVIEW_MAX_HTML_BYTES = 512 * 1024
/** Preview images larger than this are not inlined. */
export const LINK_PREVIEW_MAX_IMAGE_BYTES = 4 * 1024 * 1024

export interface LinkPreviewDeps {
  kind?: PlatformFetchKind
  fetchImpl?: PlatformFetch
}

/** Whether this shell can read cross-origin pages at all. */
export function canFetchLinkPreviews(kind: PlatformFetchKind = platformFetchKind()): boolean {
  return kind !== "browser"
}

function stripWww(host: string): string {
  return host.replace(/^www\./i, "")
}

/**
 * Validate `url` for a preview request and return its normalized form.
 * Throws {@link LinkPreviewRefusedError}; never touches the network.
 */
export function checkLinkPreviewTarget(url: string): string {
  const normalized = normalizeHttpUrl(url)
  if (!normalized) throw new LinkPreviewRefusedError("invalid-url")
  try {
    assertFetchTargetAllowed(normalized)
  } catch {
    throw new LinkPreviewRefusedError("blocked-host")
  }
  if (!isUrlSafeToDereference(normalized)) throw new LinkPreviewRefusedError("pii")
  return normalized
}

function mimeType(response: Response): string | undefined {
  const raw = response.headers.get("content-type")
  return raw ? raw.split(";")[0]?.trim().toLowerCase() || undefined : undefined
}

function isHtml(type: string | undefined): boolean {
  return type === undefined || type === "text/html" || type === "application/xhtml+xml"
}

/**
 * One signal that fires on the caller's abort or after `ms`, without
 * `AbortSignal.any` / `AbortSignal.timeout` (iOS 17.4 / 16), which the oldest
 * supported mobile WebViews lack. `dispose` clears the timer and listener.
 */
export function deadlineSignal(
  parent: AbortSignal | undefined,
  ms: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  const timer = setTimeout(
    () => controller.abort(new DOMException("Timed out", "TimeoutError")),
    ms
  )
  if (parent?.aborted) abort()
  else parent?.addEventListener("abort", abort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", abort)
    },
  }
}

export async function fetchLinkPreview(
  url: string,
  options: { signal?: AbortSignal } = {},
  deps: LinkPreviewDeps = {}
): Promise<LinkPreview> {
  const kind = deps.kind ?? platformFetchKind()
  if (!canFetchLinkPreviews(kind)) throw new LinkPreviewRefusedError("unsupported-shell")
  const target = checkLinkPreviewTarget(url)
  const fetchImpl = deps.fetchImpl ?? createPlatformFetch({ kind })

  const deadline = deadlineSignal(options.signal, LINK_PREVIEW_TIMEOUT_MS)
  try {
    return await readLinkPreview(target, fetchImpl, deadline.signal)
  } finally {
    deadline.dispose()
  }
}

async function readLinkPreview(
  target: string,
  fetchImpl: PlatformFetch,
  signal: AbortSignal
): Promise<LinkPreview> {
  const response = await fetchImpl(target, {
    method: "GET",
    headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal,
    timeout: LINK_PREVIEW_TIMEOUT_MS,
    blockPrivateHosts: true,
  })
  if (!response.ok) throw new LinkPreviewHttpError(response.status)

  // The native bridges build a fresh `Response`, whose `url` is empty; only the
  // browser transport reports the post-redirect address.
  const finalUrl = response.url || target
  const host = stripWww(new URL(finalUrl).hostname)
  const contentType = mimeType(response)

  if (contentType?.startsWith("image/")) {
    return { url: target, finalUrl, host, kind: "image", contentType, imageUrl: finalUrl }
  }
  if (!isHtml(contentType)) {
    return {
      url: target,
      finalUrl,
      host,
      kind: "file",
      ...(contentType ? { contentType } : {}),
      faviconUrl: new URL("/favicon.ico", finalUrl).href,
    }
  }

  const html = (await response.text()).slice(0, LINK_PREVIEW_MAX_HTML_BYTES)
  return {
    url: target,
    finalUrl,
    host,
    kind: "page",
    ...(contentType ? { contentType } : {}),
    ...parseLinkMetadata(html, finalUrl),
  }
}

/**
 * Read a preview image (an `og:image` or a favicon) as a `data:` URL.
 *
 * Only the desktop needs this: its CSP allows `img-src 'self' data: blob:`, so
 * a remote URL in an `<img>` never loads there. A `data:` URL needs no revoke,
 * so an evicted cache entry is simply garbage. Same guards as the page fetch.
 */
export async function fetchPreviewImageAsDataUrl(
  src: string,
  options: { signal?: AbortSignal } = {},
  deps: LinkPreviewDeps = {}
): Promise<string> {
  if (/^data:image\//i.test(src)) return src
  const kind = deps.kind ?? platformFetchKind()
  if (!canFetchLinkPreviews(kind)) throw new LinkPreviewRefusedError("unsupported-shell")
  const target = checkLinkPreviewTarget(src)
  const fetchImpl = deps.fetchImpl ?? createPlatformFetch({ kind })
  const deadline = deadlineSignal(options.signal, LINK_PREVIEW_TIMEOUT_MS)
  try {
    return await readPreviewImage(target, fetchImpl, deadline.signal)
  } finally {
    deadline.dispose()
  }
}

async function readPreviewImage(
  target: string,
  fetchImpl: PlatformFetch,
  signal: AbortSignal
): Promise<string> {
  const response = await fetchImpl(target, {
    method: "GET",
    headers: { Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8" },
    redirect: "follow",
    signal,
    timeout: LINK_PREVIEW_TIMEOUT_MS,
    binaryResponse: true,
    blockPrivateHosts: true,
  })
  if (!response.ok) throw new LinkPreviewHttpError(response.status)
  const type = mimeType(response)
  // `/favicon.ico` is often served as `application/octet-stream`; accept that
  // one shape for `.ico` paths and nothing else that is not an image.
  const isIco = /\.ico(?:[?#]|$)/i.test(target)
  if (!type?.startsWith("image/") && !(isIco && type === "application/octet-stream")) {
    throw new LinkPreviewHttpError(415)
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0 || bytes.byteLength > LINK_PREVIEW_MAX_IMAGE_BYTES) {
    throw new LinkPreviewHttpError(413)
  }
  const imageType = type?.startsWith("image/") ? type : "image/x-icon"
  return blobToDataUrl(new Blob([bytes], { type: imageType }))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("Could not read preview image"))
    reader.readAsDataURL(blob)
  })
}
