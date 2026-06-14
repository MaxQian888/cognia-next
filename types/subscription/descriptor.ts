// Declarative source descriptor — the data shape that lets a new coding-plan /
// credit provider be added as *config* instead of a hand-written adapter.
//
// A `SourceDescriptor` says three things: which accounts it applies to
// (`match`), how to request the provider's balance/usage endpoint (`request`,
// with `{{token}}`/`{{baseUrl}}`/`{{accountId}}` placeholders), and how to pull
// the numbers out of the JSON response (`extract`, by dot-path). The engine
// (`engine.ts`) turns one into an ordinary `LimitsSource`, so it renders through
// the existing meter UI with zero new rendering code. This mirrors CCSwitch's
// `usage_script` (request-config + extractor) but uses safe path extraction
// rather than an eval/JS sandbox.

/** How a reset timestamp is encoded in the provider response. */
export type ResetUnit = "unix" | "ms" | "iso" | "relativeSeconds"

/**
 * Pick one element out of a discriminated array before reading a window's paths.
 * Lets each window pull from a different element — e.g. Zhipu's `data.limits[]`,
 * where each entry is tagged `TOKENS_LIMIT: "five_hour" | "weekly"` and the
 * engine selects the entry whose tag matches this window's tier.
 */
export interface WindowSelect {
  /** Dot-path to the array to search, e.g. "data.limits". */
  arrayPath: string
  /** Field within each element whose value identifies it, e.g. "TOKENS_LIMIT". */
  by: string
  /** Value that element's `by` field must equal, e.g. "five_hour". */
  equals: string | number
}

/** One window inside a `window`-kind descriptor (utilization that resets). */
export interface WindowSpec {
  /** Meter id within the snapshot, e.g. "session" | "weekly". */
  id: string
  /** i18n key the renderer resolves (built-ins under `subscription.limits.meter.*`). */
  labelKey: string
  /**
   * Dot-path to a pre-computed utilization value (a percent unless `usedPctScale`
   * rescales it). Optional: when omitted, the engine derives utilization from the
   * `usedPath`/`totalPath` (or `remainingPath`/`totalPath`) counts below.
   */
  usedPctPath?: string
  /**
   * Multiply the raw value before use, e.g. a provider reporting a 0–1 fraction
   * uses `usedPctScale: 100`. Defaults to 1.
   */
  usedPctScale?: number
  /**
   * When the provider reports *remaining* percent instead of *used*, set this so
   * the engine stores `100 - value`. Applied after `usedPctScale`.
   */
  invert?: boolean
  /**
   * Count-based alternative to `usedPctPath`: derive utilization from
   * `usedPath / totalPath` (or, when `usedPath` is absent, `1 - remainingPath /
   * totalPath`). Used by Coding Plan providers that report request/token counts
   * rather than a pre-computed percentage (MiniMax, Kimi-coding).
   */
  usedPath?: string
  /** Dot-path to the window's total/count capacity (pairs with `usedPath`). */
  totalPath?: string
  /** Dot-path to the window's remaining count (used when `usedPath` is absent). */
  remainingPath?: string
  /**
   * Select a specific array element before reading this window's paths. Each
   * window can select independently, so a discriminated array yields one meter
   * per tier (see `WindowSelect`).
   */
  select?: WindowSelect
  /** Dot-path to the reset timestamp (interpreted per `resetUnit`). */
  resetAtPath?: string
  resetUnit?: ResetUnit
  /**
   * Dot-path to a window length in seconds (e.g. 18000=5h, 604800=7d). When
   * present and no `id` override is wanted, the engine can map it to a tier
   * label — but `id`/`labelKey` always win. Kept for parity with providers that
   * report `limit_window_seconds` instead of a stable window name.
   */
  windowSecondsPath?: string
}

/** Extract a resetting utilization window (or several). */
export interface WindowExtract {
  kind: "window"
  windows: WindowSpec[]
}

/** Extract a credit/quota balance. */
export interface BalanceExtract {
  kind: "balance"
  totalPath?: string
  usedPath?: string
  remainingPath?: string
  /** Display unit, "USD" | "CNY" | "tokens" | "requests". */
  unit?: string
  /** ISO-4217 currency for credit meters. */
  currency?: string
  /**
   * Multiply raw amounts by this before display (e.g. Novita reports 1/10000
   * USD → scale 0.0001). Defaults to 1.
   */
  scale?: number
}

export type DescriptorExtract = WindowExtract | BalanceExtract

/** A declarative limits/usage source. */
export interface SourceDescriptor {
  /** Stable id (also the resulting `LimitsSource.key`). */
  id: string
  /** Provider-match signals. At least one should be set or it matches nothing. */
  match: {
    /** Exact preset `templateId` / provider key, e.g. "stepfun". */
    providerKey?: string
    /** Substring the account's resolved baseUrl must contain, e.g. "stepfun.com". */
    baseUrlIncludes?: string
  }
  request: {
    /** Path appended to the resolved baseUrl. Supports `{{...}}` placeholders. */
    path: string
    method?: "GET"
    /**
     * Extra headers; values support `{{token}}`/`{{baseUrl}}`/`{{accountId}}`.
     * Provide an `Authorization` header to override the default
     * `Bearer {{token}}` (e.g. Zhipu uses the raw key with no scheme; New-API
     * relays add a `New-Api-User` header alongside the bearer).
     */
    headers?: Record<string, string>
  }
  extract: DescriptorExtract
}

/**
 * A user-defined source: a self-contained descriptor that carries its own
 * endpoint + token (it has no vault account). Stored in app settings and run by
 * the custom runner; surfaced as its own provider block.
 */
export interface CustomLimitsSource {
  /** UUID-ish stable id. */
  id: string
  /** User-facing name shown as the provider header. */
  name: string
  /** Endpoint host the `request.path` is appended to. */
  baseUrl: string
  /** Bearer token (stored in the renderer settings store — see security note). */
  token: string
  request: SourceDescriptor["request"]
  extract: DescriptorExtract
}
