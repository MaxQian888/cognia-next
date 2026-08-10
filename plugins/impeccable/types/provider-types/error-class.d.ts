/**
 * Provider error taxonomy (LiteLLM fallback-class analog). One shared
 * vocabulary for the renderer's routing-fallback retry path, the
 * engine-level fallback executor, and per-class retry policies in
 * `ModelMapping.retryPolicy`.
 */
type ProviderErrorClass =
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
declare const TRANSIENT_ERROR_CLASSES: ReadonlySet<ProviderErrorClass>

export { type ProviderErrorClass, TRANSIENT_ERROR_CLASSES }
