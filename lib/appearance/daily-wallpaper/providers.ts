/**
 * The daily-wallpaper providers, as pure request builders and response readers.
 *
 * No I/O happens here. A provider says what URL to ask and how to read the
 * answer, and `fetch-daily-wallpaper.ts` does the asking. That split is what
 * makes "Bing changed its JSON shape" a unit test rather than a network
 * experiment.
 *
 * ORIGIN PINNING is the security-relevant part. Every provider declares the
 * hosts it is allowed to talk to, for the API call AND for the image URL that
 * comes back. A JSON response is remote input, and a provider that starts
 * returning an image URL pointing somewhere else is a failure to report, not a
 * redirect to follow. Without this the endpoints below would be an arbitrary
 * fetch primitive driven by a third party.
 */

import { readJsonPathString } from "./json-path"
import type {
  BingProviderOptions,
  CustomDailyWallpaperSource,
  DailyWallpaperProviderId,
  DailyWallpaperSettings,
  NasaApodProviderOptions,
} from "@/types/appearance/daily-wallpaper"

/** What a provider produced from one successful response. */
export interface DailyWallpaperCandidate {
  /** Absolute https URL of the image to download. */
  imageUrl: string
  /** Human-readable name for the stored wallpaper. */
  title: string
  /**
   * Provider-scoped identity for this image, for example Bing's `startdate`
   * or APOD's `date`. Lets a re-run inside the same period exit before
   * downloading bytes it already has.
   */
  entryKey: string
  /** Attribution/copyright line, shown in the gallery where the source gives one. */
  attribution?: string
}

/** Why reading a response failed. Mirrors `DailyWallpaperErrorCode`. */
export type ProviderParseFailure = "bad-response" | "no-image" | "unsupported-media"

export type ProviderParseResult =
  { ok: true; candidate: DailyWallpaperCandidate } | { ok: false; reason: ProviderParseFailure }

export interface ProviderRequest {
  url: string
  /** A `json` response gets parsed. An `image` URL is the image itself. */
  kind: "json" | "image"
}

export interface DailyWallpaperProvider {
  id: DailyWallpaperProviderId
  /**
   * Hosts this provider may contact, for both the API call and the resolved
   * image. Compared case-insensitively against the exact hostname or a
   * dot-suffix, so `bing.com` also permits `www.bing.com` but never
   * `notbing.com` or `bing.com.evil.test`.
   */
  allowedHosts: readonly string[]
  buildRequest: (settings: DailyWallpaperSettings, locale: string) => ProviderRequest
  parse: (payload: unknown, settings: DailyWallpaperSettings) => ProviderParseResult
}

// ---------------------------------------------------------------------------
// Bing daily image
// ---------------------------------------------------------------------------

const BING_HOST = "bing.com"
const BING_ORIGIN = "https://www.bing.com"

/**
 * Bing markets, keyed by the app locale. Bing serves a DIFFERENT image per
 * region rather than the same image with different copy, so this changes what
 * you see, not just what it is called.
 */
const BING_MARKET_BY_LOCALE: Record<string, string> = {
  en: "en-US",
  "en-US": "en-US",
  "en-GB": "en-GB",
  zh: "zh-CN",
  "zh-CN": "zh-CN",
  ja: "ja-JP",
  "ja-JP": "ja-JP",
  de: "de-DE",
  fr: "fr-FR",
}

export function resolveBingMarket(options: BingProviderOptions, locale: string): string {
  if (options.market !== "auto") return options.market
  return BING_MARKET_BY_LOCALE[locale] ?? BING_MARKET_BY_LOCALE[locale.split("-")[0]] ?? "en-US"
}

export const bingProvider: DailyWallpaperProvider = {
  id: "bing",
  allowedHosts: [BING_HOST],
  buildRequest: (settings, locale) => {
    const market = resolveBingMarket(settings.bing, locale)
    return {
      kind: "json",
      url: `${BING_ORIGIN}/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=${encodeURIComponent(market)}`,
    }
  },
  parse: (payload, settings) => {
    const images = (payload as { images?: unknown })?.images
    if (!Array.isArray(images) || images.length === 0) return { ok: false, reason: "bad-response" }
    const first = images[0] as Record<string, unknown>

    // `urlbase` is the resolution-independent stem, which is the only way to
    // ask for UHD. `url` is a fully-formed 1080p path and the fallback when a
    // response omits the stem.
    const urlBase = typeof first.urlbase === "string" ? first.urlbase : null
    const url = typeof first.url === "string" ? first.url : null

    let path: string | null = null
    if (settings.bing.resolution === "uhd" && urlBase) {
      path = `${urlBase}_UHD.jpg`
    } else if (url) {
      path = url
    } else if (urlBase) {
      path = `${urlBase}_1920x1080.jpg`
    }
    if (!path) return { ok: false, reason: "no-image" }

    const copyright = typeof first.copyright === "string" ? first.copyright : undefined
    return {
      ok: true,
      candidate: {
        // Bing returns a root-relative path, so the origin goes back on here.
        imageUrl: path.startsWith("http") ? path : `${BING_ORIGIN}${path}`,
        // The title field is frequently empty, and the copyright line is the
        // part that actually names the photograph.
        title: firstNonEmpty(first.title, stripCopyrightSuffix(copyright)) ?? "Bing",
        entryKey: typeof first.startdate === "string" ? first.startdate : String(Date.now()),
        attribution: copyright,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// NASA Astronomy Picture of the Day
// ---------------------------------------------------------------------------

const NASA_API_HOST = "api.nasa.gov"
/** APOD hosts its images on apod.nasa.gov, a different host from the API. */
const NASA_IMAGE_HOSTS = ["apod.nasa.gov", "www.nasa.gov", "nasa.gov"]

export function resolveNasaApiKey(options: NasaApodProviderOptions): string {
  const key = options.apiKey?.trim()
  return key && key.length > 0 ? key : "DEMO_KEY"
}

export const nasaApodProvider: DailyWallpaperProvider = {
  id: "nasaApod",
  allowedHosts: [NASA_API_HOST, ...NASA_IMAGE_HOSTS],
  buildRequest: (settings) => ({
    kind: "json",
    url: `https://${NASA_API_HOST}/planetary/apod?api_key=${encodeURIComponent(
      resolveNasaApiKey(settings.nasaApod)
    )}`,
  }),
  parse: (payload, settings) => {
    const doc = payload as Record<string, unknown>
    if (!doc || typeof doc !== "object") return { ok: false, reason: "bad-response" }

    // APOD publishes a video on a meaningful fraction of days. That is not a
    // failure of the request, it is a day with no wallpaper, and saying so
    // distinctly is what stops the UI reporting a broken integration.
    if (doc.media_type !== "image") return { ok: false, reason: "unsupported-media" }

    const hd = typeof doc.hdurl === "string" ? doc.hdurl : null
    const standard = typeof doc.url === "string" ? doc.url : null
    const imageUrl = settings.nasaApod.preferHd ? (hd ?? standard) : (standard ?? hd)
    if (!imageUrl) return { ok: false, reason: "no-image" }

    return {
      ok: true,
      candidate: {
        imageUrl,
        title: firstNonEmpty(doc.title) ?? "NASA APOD",
        entryKey: typeof doc.date === "string" ? doc.date : String(Date.now()),
        attribution: typeof doc.copyright === "string" ? doc.copyright : undefined,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Custom source
// ---------------------------------------------------------------------------

/**
 * A custom source pins to whatever host the USER typed.
 *
 * There is no allowlist to consult, because the allowlist IS their URL. What
 * still applies is the SSRF screen in the fetcher: a custom source may not
 * reach loopback, private ranges or cloud metadata, however it is spelled.
 */
export const customProvider: DailyWallpaperProvider = {
  id: "custom",
  allowedHosts: [],
  buildRequest: (settings) => ({
    kind: settings.custom.kind,
    url: settings.custom.url.trim(),
  }),
  parse: (payload, settings) => {
    const source = settings.custom
    if (source.kind === "image") {
      return {
        ok: true,
        candidate: {
          imageUrl: source.url.trim(),
          title: "Daily",
          // A direct image URL carries no identity, so the calendar day is the
          // best available "have I already got this" key.
          entryKey: new Date().toISOString().slice(0, 10),
        },
      }
    }

    if (!source.imagePath) return { ok: false, reason: "no-image" }
    const found = readJsonPathString(payload, source.imagePath)
    if (!found) return { ok: false, reason: "no-image" }

    const imageUrl = resolveCustomImageUrl(found, source)
    if (!imageUrl) return { ok: false, reason: "no-image" }

    const title = source.titlePath ? readJsonPathString(payload, source.titlePath) : undefined
    return {
      ok: true,
      candidate: {
        imageUrl,
        title: title ?? "Daily",
        entryKey: `${new Date().toISOString().slice(0, 10)}:${imageUrl}`,
      },
    }
  },
}

/** Put an origin back on a relative image path, the way Bing-shaped APIs need. */
export function resolveCustomImageUrl(
  found: string,
  source: CustomDailyWallpaperSource
): string | null {
  if (/^https?:\/\//i.test(found)) return found
  const base = source.baseUrl?.trim() || originOf(source.url)
  if (!base) return null
  try {
    return new URL(found, base.endsWith("/") ? base : `${base}/`).toString()
  } catch {
    return null
  }
}

export const DAILY_WALLPAPER_PROVIDER_REGISTRY: Record<
  DailyWallpaperProviderId,
  DailyWallpaperProvider
> = {
  bing: bingProvider,
  nasaApod: nasaApodProvider,
  custom: customProvider,
}

export function getDailyWallpaperProvider(id: DailyWallpaperProviderId): DailyWallpaperProvider {
  return DAILY_WALLPAPER_PROVIDER_REGISTRY[id] ?? bingProvider
}

/**
 * Whether a URL's host is one this provider is allowed to reach.
 *
 * An empty allowlist means "the user named the host themselves", which the
 * custom provider relies on. Matching is exact-or-dot-suffix so `bing.com`
 * covers `www.bing.com` and never `bing.com.example.test`.
 */
export function isAllowedProviderHost(url: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:") return false
    host = parsed.hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedHosts.some((allowed) => {
    const target = allowed.toLowerCase()
    return host === target || host.endsWith(`.${target}`)
  })
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return undefined
}

/**
 * Bing's copyright reads "Some Place, Some Country (© Photographer/Agency)".
 * The part before the parenthesis is the only half that works as a name.
 */
function stripCopyrightSuffix(copyright: string | undefined): string | undefined {
  if (!copyright) return undefined
  const cut = copyright.indexOf(" (©")
  return cut > 0 ? copyright.slice(0, cut) : copyright
}
