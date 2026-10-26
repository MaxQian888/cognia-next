/**
 * Persisted Reader policy for `web_fetch` (`AppSettings.webReader`).
 *
 * Search and Reader are configured independently: enabling a vendor's Search
 * never enables its Reader, and a Reader never needs Search turned on. A
 * vendor Reader reuses the credential already stored for that vendor under
 * `searchProviders[<id>]` — no second copy of any secret lives here.
 *
 * Pure types and constants only; normalization lives in
 * `lib/web/reader/reader-settings.ts`.
 */

/**
 * Every reader `web_fetch` can route through.
 * - `direct`: the host's own HTTP request + local HTML extraction
 * - `platform`: origin-site scrapers (WeChat articles, YouTube watch pages);
 *   they read the target site itself, so no third party sees the URL
 * - `fxtwitter`: X/Twitter posts via the third-party FxTwitter API
 * - `jina`: Jina Reader (`r.jina.ai`), third party, no key
 * - `tavily` / `exa` / `deepseek` / `tinyfish`: vendor reader APIs on the
 *   vendor's stored search credential
 */
export type WebReaderId =
  "direct" | "platform" | "fxtwitter" | "jina" | "tavily" | "exa" | "deepseek" | "tinyfish"

export const WEB_READER_IDS: readonly WebReaderId[] = [
  "direct",
  "platform",
  "fxtwitter",
  "jina",
  "tavily",
  "exa",
  "deepseek",
  "tinyfish",
]

/** Readers that send the target URL to a third party. */
export const REMOTE_WEB_READER_IDS: readonly WebReaderId[] = [
  "fxtwitter",
  "jina",
  "tavily",
  "exa",
  "deepseek",
  "tinyfish",
]

/** Readers backed by a vendor credential stored under `searchProviders[id]`. */
export const CREDENTIALED_WEB_READER_IDS = ["tavily", "exa", "deepseek", "tinyfish"] as const
export type CredentialedWebReaderId = (typeof CREDENTIALED_WEB_READER_IDS)[number]

export interface WebReaderEntry {
  enabled: boolean
  /** Lower runs first among external readers in `auto` routing. */
  priority: number
}

/**
 * `off`: never distill unless the caller passes a `prompt` (best-effort).
 * `best-effort`: distill every readable page; on failure return the text,
 *   marked `distilled: false` with a reason.
 * `required`: never return undistilled page text; fail closed when no model
 *   is available, the call fails, is cancelled, or exceeds its budget.
 */
export type WebReaderDistillation = "off" | "best-effort" | "required"

export interface WebReaderSettingsV1 {
  version: 1
  /** `auto` = platform/direct first, then (if allowed) enabled external readers. */
  defaultReader: "auto" | WebReaderId
  readers: Partial<Record<WebReaderId, WebReaderEntry>>
  /** May `auto` fall back to an enabled external reader after direct reading fails? */
  externalFallback: "off" | "configured"
  distillation: WebReaderDistillation
  /** Whole-read budget, ms (bounded by the shared operation policy). */
  timeoutMs?: number
  /** Reader attempts per read (bounded by the shared operation policy). */
  maxAttempts?: number
}

/**
 * The stored value. A record with an unknown future `version` is kept
 * verbatim (never erased) but not activated; the effective policy falls back
 * to the compatibility profile.
 */
export type StoredWebReaderSettings =
  WebReaderSettingsV1 | { version: number; [key: string]: unknown }
