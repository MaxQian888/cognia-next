/**
 * Provider error taxonomy (LiteLLM fallback-class analog). One shared
 * vocabulary for the renderer's routing-fallback retry path, the
 * engine-level fallback executor, and per-class retry policies in
 * `ModelMapping.retryPolicy`.
 */

export type ProviderErrorClass =
  | "rate-limit"
  | "timeout"
  | "network"
  | "server-error"
  | "context-window-exceeded"
  | "content-policy"
  | "auth"
  | "invalid-request"
  | "unknown"

/**
 * Classes worth retrying against ANOTHER provider in the same chain.
 * Special classes (context-window / content-policy) are NOT here — they
 * route through their dedicated `specialFallbacks` chains instead (a
 * same-sized model fails the same way).
 */
export const TRANSIENT_ERROR_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  "rate-limit",
  "timeout",
  "network",
  "server-error",
])
