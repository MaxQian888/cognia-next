// Phase-3 balance / usage acquisition types (ADR 0025).
//
// A `BalanceSnapshot` is a normalized, provider-agnostic view of "how much
// credit / quota is left" for one subscription account, produced by a pure
// `BalanceAdapter` from a raw provider response. The renderer persists these
// in the `subscriptionBalance` Dexie table (capped) and renders the latest
// one as a per-account card in the Usage tab.
//
// Adapters are pure: they only describe an authed GET request and parse its
// body. The Tauri-side `subscription_authed_get` performs the actual HTTP so
// the renderer never hits CORS.

/** Normalized balance reading for one account at one point in time. */
export interface BalanceSnapshot {
  fetchedAt: number
  /** Adapter key, e.g. "deepseek" | "openrouter" | "siliconflow" | "moonshot". */
  providerKey: string
  accountId: string
  kind: "credit" | "quota" | "usage"
  currency?: string
  total?: number
  remaining?: number
  used?: number
  /** "USD" | "CNY" | "tokens" | "requests". */
  unit?: string
  raw: Record<string, unknown>
  /** Set when a query failed; kept so the UI can surface the error inline. */
  error?: string
}

/** Persisted form of a `BalanceSnapshot` — Dexie auto-increment primary key. */
export interface SubscriptionBalanceRow extends BalanceSnapshot {
  localId?: number
}

/** Fully-resolved inputs an adapter needs to build + parse a balance query. */
export interface BalanceQuery {
  accountId: string
  providerKey: string
  baseUrl: string
  token: string
}

/** A GET-only HTTP request description (no body — balance APIs are all reads). */
export interface BalanceRequestDescriptor {
  url: string
  headers: Record<string, string>
}

/** Pure, per-provider balance adapter. */
export interface BalanceAdapter {
  key: string
  matches(q: { providerKey?: string; baseUrl?: string }): boolean
  request(q: BalanceQuery): BalanceRequestDescriptor
  parse(status: number, body: string, q: BalanceQuery): BalanceSnapshot
}
