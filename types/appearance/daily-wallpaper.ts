// Daily wallpaper: opt-in, scheduled retrieval of ONE image per period from a
// remote source, which is then stored like any other wallpaper and (optionally)
// made active.
//
// This is the only part of the appearance subsystem that leaves the machine, so
// the shape below is written to make that fact impossible to lose track of:
//
//   - `enabled` defaults to FALSE. Nothing is fetched until the user opts in.
//   - The provider is an explicit id, never an inferred default. There is no
//     "just pick one for me" path that silently contacts a third party.
//   - Every provider declares its origins up front (see
//     `lib/appearance/daily-wallpaper/providers.ts`), and the fetcher pins the
//     resolved image URL to those origins. A provider that starts returning an
//     off-origin image URL is a failure, not a redirect to follow.
//   - Failures are RECORDED (`lastError`) rather than swallowed, because a
//     daily fetch that silently stopped working looks identical to a daily
//     fetch the user never enabled.
//
// Persistence rides on `AppSettings.background.daily`. No new table.

/**
 * Built-in sources.
 *
 * Both built-ins were chosen for the same three properties: a stable public
 * JSON endpoint, no mandatory API key, and a licence that permits personal
 * wallpaper use. Anything else the user wants goes through `custom`, where
 * they supply the URL themselves and own the consequences.
 */
export type DailyWallpaperProviderId = "bing" | "nasaApod" | "custom"

export const DAILY_WALLPAPER_PROVIDERS: readonly DailyWallpaperProviderId[] = [
  "bing",
  "nasaApod",
  "custom",
]

/**
 * Bing market. Decides WHICH daily image you get, because Bing runs different
 * homepage images per region, not just different copy.
 *
 * `auto` resolves from the app locale at fetch time rather than being written
 * into settings, so a user who switches language does not keep the old market.
 */
export type BingMarket = "auto" | "en-US" | "zh-CN" | "ja-JP" | "en-GB" | "de-DE" | "fr-FR"

export const BING_MARKETS: readonly BingMarket[] = [
  "auto",
  "en-US",
  "zh-CN",
  "ja-JP",
  "en-GB",
  "de-DE",
  "fr-FR",
]

/**
 * Bing image resolution. `uhd` is a 4K asset and can be several megabytes,
 * which matters because the fetched bytes are stored locally forever (up to
 * `keepCount`). The default stays at 1080p.
 */
export type BingResolution = "1080p" | "uhd"

export const BING_RESOLUTIONS: readonly BingResolution[] = ["1080p", "uhd"]

export interface BingProviderOptions {
  market: BingMarket
  resolution: BingResolution
}

export const DEFAULT_BING_OPTIONS: BingProviderOptions = {
  market: "auto",
  resolution: "1080p",
}

export interface NasaApodProviderOptions {
  /**
   * Personal api.nasa.gov key. Optional: the endpoint accepts `DEMO_KEY`,
   * which is what an empty value resolves to. DEMO_KEY is rate limited to a
   * handful of requests per hour PER IP, shared with every other DEMO_KEY
   * caller, so a user who hits the limit is told to supply their own key
   * rather than being left with a mystery failure.
   */
  apiKey?: string
  /**
   * Prefer `hdurl` over `url`. APOD's HD asset is frequently 3-6 MB, so this
   * is off by default for the same storage reason as Bing's `uhd`.
   */
  preferHd: boolean
}

export const DEFAULT_NASA_APOD_OPTIONS: NasaApodProviderOptions = { preferHd: false }

/**
 * How a custom endpoint's response is read.
 *
 * `image` means the URL IS the image and is fetched directly. `json` means the
 * URL returns JSON and `imagePath` says where the image URL lives inside it.
 */
export type CustomDailySourceKind = "image" | "json"

export const CUSTOM_DAILY_SOURCE_KINDS: readonly CustomDailySourceKind[] = ["image", "json"]

export interface CustomDailyWallpaperSource {
  /** The endpoint to contact. Must be https, and is SSRF-screened before use. */
  url: string
  kind: CustomDailySourceKind
  /**
   * Dot/bracket path to the image URL inside a JSON response, for example
   * `images.0.url` or `data.today.image`. Required when `kind === "json"`.
   *
   * Resolved by a deliberately tiny reader that walks plain object keys and
   * array indices only. No expression evaluation, because the path is user
   * input that runs on every scheduled fetch.
   */
  imagePath?: string
  /** Optional path to a human-readable title, used to name the wallpaper. */
  titlePath?: string
  /**
   * Prepended when the extracted image URL is relative. Bing-shaped APIs
   * return `/th?id=...` and need an origin put back on the front.
   */
  baseUrl?: string
}

export const DEFAULT_CUSTOM_DAILY_SOURCE: CustomDailyWallpaperSource = {
  url: "",
  kind: "json",
}

/**
 * Why the last fetch failed. A CODE, not a message, so the UI renders a
 * translated explanation and the sentence never leaks a URL or a key into a
 * screenshot.
 */
export type DailyWallpaperErrorCode =
  | "network"
  | "blocked-host"
  | "bad-response"
  | "no-image"
  | "not-an-image"
  | "too-large"
  | "rate-limited"
  | "unsupported-media"
  | "storage-failed"
  | "no-transport"

export interface DailyWallpaperFailure {
  code: DailyWallpaperErrorCode
  at: number
  /** HTTP status when there was one. Absent for transport-level failures. */
  status?: number
}

/** Refresh cadence presets, in hours. */
export const DAILY_REFRESH_PRESETS: readonly number[] = [1, 3, 6, 12, 24, 48]

export const MIN_DAILY_REFRESH_HOURS = 1
export const MAX_DAILY_REFRESH_HOURS = 24 * 14

/** Bounds on how many fetched images are retained before the oldest is reaped. */
export const MIN_DAILY_KEEP_COUNT = 1
export const MAX_DAILY_KEEP_COUNT = 30

/**
 * Hard ceiling on a single fetched image. Below `MAX_WALLPAPER_BYTES` (32 MB)
 * on purpose: that cap is for a file the user deliberately chose, whereas this
 * one is for bytes an unattended timer pulled from a remote host.
 */
export const MAX_DAILY_IMAGE_BYTES = 12 * 1024 * 1024

export interface DailyWallpaperSettings {
  enabled: boolean
  providerId: DailyWallpaperProviderId
  bing: BingProviderOptions
  nasaApod: NasaApodProviderOptions
  custom: CustomDailyWallpaperSource
  /** Hours between fetches. Clamped on read. */
  refreshHours: number
  /**
   * How many fetched wallpapers to keep. Older ones are deleted from the
   * gallery AND from disk/IndexedDB, because the whole point of a daily image
   * is that it accumulates without supervision.
   */
  keepCount: number
  /** Make each newly fetched image the active wallpaper as it lands. */
  autoApply: boolean
  /**
   * Only fetch while the network is metered-free and the app is foregrounded.
   * On by default on mobile shells, where a background multi-megabyte pull on
   * cellular is a real cost.
   */
  wifiOnly: boolean
  /** Epoch-ms of the last SUCCESSFUL fetch. Written by the runtime. */
  lastFetchedAt?: number
  /**
   * Provider-scoped identity of the last stored image, for example Bing's
   * `startdate` or APOD's `date`. Lets a re-run inside the same period exit
   * without re-downloading bytes it already has.
   */
  lastEntryKey?: string
  /** The last failure, kept until the next success replaces it. */
  lastError?: DailyWallpaperFailure
}

export const DEFAULT_DAILY_WALLPAPER: DailyWallpaperSettings = {
  enabled: false,
  providerId: "bing",
  bing: DEFAULT_BING_OPTIONS,
  nasaApod: DEFAULT_NASA_APOD_OPTIONS,
  custom: DEFAULT_CUSTOM_DAILY_SOURCE,
  refreshHours: 24,
  keepCount: 7,
  autoApply: true,
  wifiOnly: true,
}

/** Narrow an arbitrary value to a {@link DailyWallpaperProviderId}. */
export function isDailyWallpaperProvider(value: unknown): value is DailyWallpaperProviderId {
  return DAILY_WALLPAPER_PROVIDERS.includes(value as DailyWallpaperProviderId)
}

/** Clamp a refresh cadence into the supported range. */
export function clampRefreshHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_DAILY_WALLPAPER.refreshHours
  return Math.min(MAX_DAILY_REFRESH_HOURS, Math.max(MIN_DAILY_REFRESH_HOURS, Math.round(hours)))
}

/** Clamp a retention count into the supported range. */
export function clampKeepCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULT_DAILY_WALLPAPER.keepCount
  return Math.min(MAX_DAILY_KEEP_COUNT, Math.max(MIN_DAILY_KEEP_COUNT, Math.round(count)))
}
