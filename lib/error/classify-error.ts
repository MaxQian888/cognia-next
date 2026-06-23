/**
 * Pure error categorization for the route-level error boundaries.
 *
 * Mature crash surfaces (Sentry, VS Code, Chrome) don't show the same generic
 * "try again" for every failure — a stale code-split chunk needs a full reload,
 * a dropped network needs a reconnect, a render crash needs a boundary reset.
 * `classifyError` maps an arbitrary thrown `Error` (plus the live online flag)
 * onto a small set of categories and the recovery action each one warrants.
 *
 * Kept pure (no DOM / no React) so `components/error/error-page.tsx` and its
 * `staticLocale="en"` global-error path can both call it, and so the full
 * branch matrix is unit-testable without a renderer.
 */

export type ErrorCategory = "chunk-load" | "network" | "offline" | "render" | "unknown"

/**
 * Recovery affordance the category warrants:
 * - `reload`       — full `window.location.reload()` (stale chunk: a boundary
 *                    reset just re-imports the missing chunk and re-throws).
 * - `retry-online` — wait for connectivity, then retry (auto-retry on reconnect).
 * - `reset`        — re-run the segment via the boundary's `reset()`.
 */
export type RecoveryKind = "reload" | "retry-online" | "reset"

export interface ErrorClassification {
  category: ErrorCategory
  recoveryKind: RecoveryKind
}

export interface ClassifyErrorOptions {
  /** Live connectivity (from `useNetworkStatus`). `undefined` = unknown. */
  online?: boolean
}

/** Stale / failed code-split chunk — webpack, Next.js, and native ESM variants. */
const CHUNK_LOAD_PATTERNS = [
  "chunkloaderror",
  "loading chunk",
  "loading css chunk",
  "error loading dynamically imported module",
  "failed to fetch dynamically imported module",
] as const

/** Transport-level failures that a reconnect can plausibly clear. */
const NETWORK_PATTERNS = [
  "failed to fetch",
  "networkerror",
  "err_network",
  "err_internet_disconnected",
  "network request failed",
  "load failed",
  "fetch failed",
  "timed out",
  "timeout",
] as const

function matchesAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => haystack.includes(pattern))
}

/**
 * Classify a boundary error. The `not-found` variant is handled upstream by the
 * `ErrorPage` variant prop, so it is intentionally absent from `ErrorCategory`.
 */
export function classifyError(
  error?: Error | null,
  opts: ClassifyErrorOptions = {}
): ErrorClassification {
  if (!error) {
    return { category: "unknown", recoveryKind: "reset" }
  }

  const haystack = `${error.name ?? ""} ${error.message ?? ""}`.toLowerCase()

  // A stale chunk masquerades as a network error; check it first so the recovery
  // is "reload" (re-fetch the manifest) rather than "retry-online".
  if (matchesAny(haystack, CHUNK_LOAD_PATTERNS)) {
    return { category: "chunk-load", recoveryKind: "reload" }
  }

  const looksLikeNetwork = matchesAny(haystack, NETWORK_PATTERNS)

  // Explicitly offline → offline category regardless of the message shape; a
  // network-shaped message while offline is still fundamentally "you're offline".
  if (opts.online === false) {
    return { category: "offline", recoveryKind: "retry-online" }
  }

  if (looksLikeNetwork) {
    return { category: "network", recoveryKind: "retry-online" }
  }

  // A real error that isn't transport- or chunk-related: a render/runtime crash.
  return { category: "render", recoveryKind: "reset" }
}

/** Categories whose recovery is gated on connectivity (drives auto-retry). */
export function isConnectivityCategory(category: ErrorCategory): boolean {
  return category === "offline" || category === "network"
}
