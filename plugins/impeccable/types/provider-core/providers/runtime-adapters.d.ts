interface ProviderCoreProxyFetchOptions extends RequestInit {
  skipProxy?: boolean
  timeout?: number
}
type ProviderCoreProxyFetch = (
  input: RequestInfo | URL,
  init?: ProviderCoreProxyFetchOptions
) => Promise<Response>
interface ProviderCoreLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void
}
interface ProviderCoreRuntimeAdapters {
  isTauri?: () => boolean
  proxyFetch?: ProviderCoreProxyFetch
  loggers?: {
    ai?: Partial<ProviderCoreLogger>
  }
}
declare function setProviderCoreRuntimeAdapters(next: ProviderCoreRuntimeAdapters): void
declare function resetProviderCoreRuntimeAdaptersForTesting(): void
declare function isTauri(): boolean
declare function proxyFetch(
  input: RequestInfo | URL,
  init?: ProviderCoreProxyFetchOptions
): Promise<Response>
declare function getProviderCoreLogger(scope?: "ai"): ProviderCoreLogger

export {
  type ProviderCoreLogger,
  type ProviderCoreProxyFetch,
  type ProviderCoreProxyFetchOptions,
  type ProviderCoreRuntimeAdapters,
  getProviderCoreLogger,
  isTauri,
  proxyFetch,
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
}
