export interface ProviderCoreProxyFetchOptions extends RequestInit {
  skipProxy?: boolean
  timeout?: number
}

export type ProviderCoreProxyFetch = (
  input: RequestInfo | URL,
  init?: ProviderCoreProxyFetchOptions
) => Promise<Response>

export interface ProviderCoreLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void
}

export interface ProviderCoreRuntimeAdapters {
  isTauri?: () => boolean
  proxyFetch?: ProviderCoreProxyFetch
  loggers?: {
    ai?: Partial<ProviderCoreLogger>
  }
}

function defaultIsTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function defaultProxyFetch(
  input: RequestInfo | URL,
  init?: ProviderCoreProxyFetchOptions
): Promise<Response> {
  const { timeout, skipProxy: _skipProxy, ...fetchInit } = init || {}
  if (timeout) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    try {
      return await fetch(input, { ...fetchInit, signal: controller.signal })
    } finally {
      clearTimeout(timeoutId)
    }
  }
  return fetch(input, fetchInit)
}

const noopLogger: ProviderCoreLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let adapters: Required<Pick<ProviderCoreRuntimeAdapters, "isTauri" | "proxyFetch">> &
  Pick<ProviderCoreRuntimeAdapters, "loggers"> = {
  isTauri: defaultIsTauri,
  proxyFetch: defaultProxyFetch,
  loggers: {},
}

export function setProviderCoreRuntimeAdapters(next: ProviderCoreRuntimeAdapters): void {
  adapters = {
    isTauri: next.isTauri ?? adapters.isTauri,
    proxyFetch: next.proxyFetch ?? adapters.proxyFetch,
    loggers: {
      ...adapters.loggers,
      ...next.loggers,
    },
  }
}

export function resetProviderCoreRuntimeAdaptersForTesting(): void {
  adapters = {
    isTauri: defaultIsTauri,
    proxyFetch: defaultProxyFetch,
    loggers: {},
  }
}

export function isTauri(): boolean {
  return adapters.isTauri()
}

export function proxyFetch(
  input: RequestInfo | URL,
  init?: ProviderCoreProxyFetchOptions
): Promise<Response> {
  return adapters.proxyFetch(input, init)
}

export function getProviderCoreLogger(scope: "ai" = "ai"): ProviderCoreLogger {
  return {
    debug(message, data) {
      ;(adapters.loggers?.[scope]?.debug ?? noopLogger.debug)(message, data)
    },
    info(message, data) {
      ;(adapters.loggers?.[scope]?.info ?? noopLogger.info)(message, data)
    },
    warn(message, data) {
      ;(adapters.loggers?.[scope]?.warn ?? noopLogger.warn)(message, data)
    },
    error(message, error, data) {
      ;(adapters.loggers?.[scope]?.error ?? noopLogger.error)(message, error, data)
    },
  }
}
