/**
 * One daily-wallpaper fetch, start to finish.
 *
 * This is the only code path in the appearance subsystem that leaves the
 * machine, and it runs unattended on a timer, so every step is a gate rather
 * than a happy path with error handling bolted on:
 *
 *   1. The provider builds a URL. It cannot be user-freeform for the built-ins.
 *   2. The URL is SSRF-screened by `@cognia/network-guard`, the same
 *      classifier `web_fetch` and the connector media floor use. This is what
 *      stops a custom source pointing at loopback or cloud metadata.
 *   3. The URL's host is pinned to the provider's declared origins, so a
 *      compromised or changed response cannot redirect the download.
 *   4. The response is parsed by the provider, which is pure.
 *   5. The resolved IMAGE url is screened and pinned again. It came out of a
 *      remote JSON document, so it gets exactly the same treatment as step 2.
 *   6. The bytes are size-capped and content-type checked BEFORE being stored.
 *
 * Every failure returns a CODE. Nothing here throws for an ordinary outcome,
 * and nothing is swallowed, because a daily fetch that silently stopped
 * working is indistinguishable from one that was never switched on.
 */

import { evaluateFetchTarget } from "@cognia/network-guard"

import { createPlatformFetch, type PlatformFetch } from "@/lib/network/platform-fetch"
import { makeWallpaper, saveImage } from "@/lib/appearance/wallpaper-storage"
import {
  getDailyWallpaperProvider,
  isAllowedProviderHost,
  type DailyWallpaperCandidate,
} from "./providers"
import {
  MAX_DAILY_IMAGE_BYTES,
  type DailyWallpaperErrorCode,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"
import type { Wallpaper, WallpaperSource } from "@/types/appearance"

/** Prefix on every wallpaper id this module mints, so retention can find them. */
export const DAILY_WALLPAPER_ID_PREFIX = "daily_"

/** MIME types accepted for a downloaded wallpaper. */
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
])

export type DailyFetchResult =
  | { ok: true; wallpaper: Wallpaper; candidate: DailyWallpaperCandidate }
  | { ok: true; skipped: "already-current"; entryKey: string }
  | { ok: false; code: DailyWallpaperErrorCode; status?: number }

export interface FetchDailyWallpaperDeps {
  settings: DailyWallpaperSettings
  /** App locale, used to resolve Bing's `auto` market. */
  locale: string
  /** Injectable for tests. Production leaves it out and gets the shell's transport. */
  fetchImpl?: PlatformFetch
  /** Injectable for tests. */
  save?: typeof saveImage
  /** Injectable so the id is deterministic under test. */
  now?: () => number
}

export async function fetchDailyWallpaper(
  deps: FetchDailyWallpaperDeps
): Promise<DailyFetchResult> {
  const { settings, locale } = deps
  const now = deps.now ?? Date.now
  const provider = getDailyWallpaperProvider(settings.providerId)

  const request = provider.buildRequest(settings, locale)
  if (!request.url) return { ok: false, code: "bad-response" }

  const requestCheck = screenUrl(request.url, provider.allowedHosts)
  if (requestCheck) return { ok: false, code: requestCheck }

  let doFetch: PlatformFetch
  try {
    doFetch = deps.fetchImpl ?? createPlatformFetch()
  } catch {
    // No usable transport in this shell. A distinct code, because "your
    // network is down" and "this build cannot make requests at all" call for
    // completely different advice.
    return { ok: false, code: "no-transport" }
  }

  // Step 4: get the candidate. A direct image URL skips the JSON round-trip.
  let candidate: DailyWallpaperCandidate
  if (request.kind === "image") {
    const parsed = provider.parse(null, settings)
    if (!parsed.ok) return { ok: false, code: parsed.reason }
    candidate = parsed.candidate
  } else {
    let payload: unknown
    try {
      const response = await doFetch(request.url, {
        headers: { accept: "application/json" },
      })
      if (!response.ok) {
        return {
          ok: false,
          // 429 and NASA's 403-on-exhausted-DEMO_KEY both mean "come back
          // later", which is worth telling apart from a broken endpoint.
          code:
            response.status === 429 || response.status === 403 ? "rate-limited" : "bad-response",
          status: response.status,
        }
      }
      payload = await response.json()
    } catch {
      return { ok: false, code: "network" }
    }

    const parsed = provider.parse(payload, settings)
    if (!parsed.ok) return { ok: false, code: parsed.reason }
    candidate = parsed.candidate
  }

  // Nothing new today. Exiting here is the difference between a daily
  // wallpaper and a daily download of the same bytes.
  if (settings.lastEntryKey && settings.lastEntryKey === candidate.entryKey) {
    return { ok: true, skipped: "already-current", entryKey: candidate.entryKey }
  }

  // Step 5: the image URL came out of a remote document, so it is screened
  // and pinned exactly like the request URL was.
  const imageCheck = screenUrl(candidate.imageUrl, provider.allowedHosts)
  if (imageCheck) return { ok: false, code: imageCheck }

  let bytes: ArrayBuffer
  let mime: string
  try {
    const response = await doFetch(candidate.imageUrl, { headers: { accept: "image/*" } })
    if (!response.ok) {
      return { ok: false, code: "bad-response", status: response.status }
    }

    // Check the advertised length before reading the body, so an oversized
    // asset costs one header rather than twelve megabytes of memory.
    const declared = Number(response.headers.get("content-length") ?? "")
    if (Number.isFinite(declared) && declared > MAX_DAILY_IMAGE_BYTES) {
      return { ok: false, code: "too-large" }
    }

    mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    if (!ACCEPTED_IMAGE_TYPES.has(mime)) return { ok: false, code: "not-an-image" }

    bytes = await response.arrayBuffer()
  } catch {
    return { ok: false, code: "network" }
  }

  // Re-checked against the real body: a missing or lying content-length is
  // exactly the case the header check above cannot cover.
  if (bytes.byteLength > MAX_DAILY_IMAGE_BYTES) return { ok: false, code: "too-large" }
  if (bytes.byteLength === 0) return { ok: false, code: "not-an-image" }

  const dimensions = await readImageDimensions(bytes, mime)
  const id = `${DAILY_WALLPAPER_ID_PREFIX}${settings.providerId}_${now().toString(36)}`

  try {
    const saved = await (deps.save ?? saveImage)({
      id,
      bytes,
      mime,
      width: dimensions.width,
      height: dimensions.height,
    })
    return {
      ok: true,
      candidate,
      wallpaper: makeWallpaper({
        id,
        name: candidate.title,
        source: saved.source as WallpaperSource,
        // Explicit rather than defaulted: retention sorts on this field, so it
        // has to come from the same clock the caller can control.
        createdAt: now(),
      }),
    }
  } catch {
    return { ok: false, code: "storage-failed" }
  }
}

/**
 * The two-part screen every URL passes: SSRF classification, then origin
 * pinning. Returns an error code, or null when the URL is acceptable.
 */
function screenUrl(url: string, allowedHosts: readonly string[]): DailyWallpaperErrorCode | null {
  const decision = evaluateFetchTarget(url)
  if (!decision.allowed) {
    return decision.reason === "bad-url" || decision.reason === "bad-scheme"
      ? "bad-response"
      : "blocked-host"
  }
  if (!isAllowedProviderHost(url, allowedHosts)) return "blocked-host"
  return null
}

/**
 * Best-effort natural dimensions.
 *
 * Stored on the wallpaper row purely so the gallery tile can reserve the right
 * aspect ratio before the bytes decode. A failure here is not a failure of the
 * fetch, so it falls back to a 16:9 guess rather than discarding a good image.
 */
async function readImageDimensions(
  bytes: ArrayBuffer,
  mime: string
): Promise<{ width: number; height: number }> {
  const fallback = { width: 1920, height: 1080 }
  if (typeof createImageBitmap !== "function" || typeof Blob === "undefined") return fallback
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }))
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close?.()
    return size.width > 0 && size.height > 0 ? size : fallback
  } catch {
    return fallback
  }
}

/**
 * Which stored daily wallpapers should be deleted to honour `keepCount`.
 *
 * Pure, and separate from the fetch, because retention has to run even on the
 * days a fetch fails. Only ids this module minted are ever considered: a
 * user's own upload is never reaped by a setting they set for the daily
 * source.
 */
export function selectExpiredDailyWallpapers(
  gallery: readonly Wallpaper[],
  keepCount: number,
  protectedId: string | null
): Wallpaper[] {
  const daily = gallery
    .filter((w) => w.id.startsWith(DAILY_WALLPAPER_ID_PREFIX) && !w.builtin)
    .sort((a, b) => b.createdAt - a.createdAt)

  return (
    daily
      .slice(Math.max(0, keepCount))
      // Never delete the wallpaper currently on screen, whatever the retention
      // says. Reaping the active one would blank the background as a side effect
      // of a cleanup the user did not ask for.
      .filter((w) => w.id !== protectedId)
  )
}
