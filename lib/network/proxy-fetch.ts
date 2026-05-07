/**
 * Proxy-aware Fetch Utility
 *
 * Provides a fetch wrapper that routes requests through configured proxy.
 * Works in both browser and Tauri environments.
 *
 * In browser environments, proxy is handled by the browser/system.
 * In Tauri desktop, we use the Rust backend for actual proxied requests.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/native/utils"
import { useProxyStore, getActiveProxyUrl } from "@/stores/system"
import { loggers } from "@/lib/logger"

const log = loggers.network

/** Input for proxied HTTP request via Tauri */
interface ProxiedRequestInput {
  url: string
  method?: string
  body?: string
  headers?: Record<string, string>
  proxy_url?: string
  timeout_secs?: number
}

/** Output from proxied HTTP request via Tauri */
interface ProxiedRequestOutput {
  status: number
  body: string
  headers: Record<string, string>
}

/**
 * Make an HTTP request through the Tauri backend with proxy support
 */
async function tauriProxiedFetch(
  input: RequestInfo | URL,
  init?: ProxyFetchOptions,
  proxyUrl?: string | null
): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString()
  const method = init?.method || "GET"
  const timeoutSecs = init?.timeout ? Math.ceil(init.timeout / 1000) : undefined

  // Convert headers to Record<string, string>. Layer the
  // `Proxy-Authorization` header in last so the active proxy auth (if any)
  // doesn't get clobbered by an empty caller-supplied bag.
  const headers: Record<string, string> = {}
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([key, value]) => {
        headers[key] = value
      })
    } else {
      Object.assign(headers, init.headers)
    }
  }
  if (proxyUrl) {
    Object.assign(headers, getProxyAuthHeaders())
  }

  // Get body as string
  let body: string | undefined
  if (init?.body) {
    if (typeof init.body === "string") {
      body = init.body
    } else if (init.body instanceof ArrayBuffer) {
      body = new TextDecoder().decode(init.body)
    } else if (init.body instanceof Blob) {
      body = await init.body.text()
    } else {
      body = JSON.stringify(init.body)
    }
  }

  try {
    const result = await invoke<ProxiedRequestOutput>("proxy_http_request", {
      input: {
        url,
        method,
        body,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        proxy_url: proxyUrl || undefined,
        timeout_secs: timeoutSecs,
      } as ProxiedRequestInput,
    })

    // Convert headers back to Headers object
    const responseHeaders = new Headers()
    for (const [key, value] of Object.entries(result.headers)) {
      responseHeaders.set(key, value)
    }

    // Create a Response object
    return new Response(result.body, {
      status: result.status,
      headers: responseHeaders,
    })
  } catch (error) {
    // If Tauri command fails, throw a proper error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Proxy request failed: ${message}`)
  }
}

export interface ProxyFetchOptions extends RequestInit {
  /** Skip proxy for this request */
  skipProxy?: boolean
  /** Custom timeout in milliseconds */
  timeout?: number
}

/**
 * Get the current proxy URL from the store
 */
export function getCurrentProxyUrl(): string | null {
  const state = useProxyStore.getState()
  return getActiveProxyUrl(state)
}

/**
 * Check if proxy is currently enabled
 */
export function isProxyEnabled(): boolean {
  const state = useProxyStore.getState()
  return state.config.enabled && state.config.mode !== "off"
}

/**
 * Get proxy configuration for HTTP clients
 * Returns configuration suitable for various HTTP client libraries
 */
export function getProxyConfig(): {
  enabled: boolean
  url: string | null
  host: string | null
  port: number | null
  protocol: string | null
} {
  const state = useProxyStore.getState()
  const proxyUrl = getActiveProxyUrl(state)

  if (!proxyUrl) {
    return {
      enabled: false,
      url: null,
      host: null,
      port: null,
      protocol: null,
    }
  }

  try {
    const parsed = new URL(proxyUrl)
    return {
      enabled: true,
      url: proxyUrl,
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80),
      protocol: parsed.protocol.replace(":", ""),
    }
  } catch {
    return {
      enabled: false,
      url: null,
      host: null,
      port: null,
      protocol: null,
    }
  }
}

/** Hosts that should bypass proxy (match Rust http.rs bypass list) */
const BYPASS_HOSTS = ["localhost", "127.0.0.1", "::1", "0.0.0.0"]

/**
 * Check if a URL should bypass proxy
 */
export function shouldBypassProxy(url: string): boolean {
  const lower = url.toLowerCase()
  return BYPASS_HOSTS.some(
    (host) =>
      lower.includes(`://${host}:`) || lower.includes(`://${host}/`) || lower.endsWith(`://${host}`)
  )
}

/**
 * Create a fetch function with proxy support
 *
 * In browser: Uses system/browser proxy settings
 * In Tauri: Routes through Rust backend for actual proxy support
 */
export function createProxyFetch(customProxyUrl?: string) {
  return async (input: RequestInfo | URL, init?: ProxyFetchOptions): Promise<Response> => {
    const { skipProxy, timeout, ...fetchInit } = init || {}

    const urlStr = typeof input === "string" ? input : input.toString()

    // Bypass proxy for localhost/local addresses
    const bypass = skipProxy || shouldBypassProxy(urlStr)

    // Get proxy URL
    const proxyUrl = bypass ? null : customProxyUrl || getCurrentProxyUrl()

    // In browser environment, we can't directly use proxy
    // The browser will use system proxy settings
    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
      // For browser, just use regular fetch
      // System/browser proxy settings will be used automatically
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

    // In Tauri environment, use the Rust backend for actual proxy support
    if (isTauri()) {
      // Log proxy usage in development
      if (process.env.NODE_ENV === "development" && proxyUrl) {
        log.debug(`Proxy: Routing request through Tauri: ${proxyUrl}`)
      }

      // Use Tauri backend for proxied requests
      return tauriProxiedFetch(input, { ...fetchInit, timeout }, proxyUrl)
    }

    // Fallback to regular fetch (shouldn't normally reach here)
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
}

/**
 * Get environment variables for proxy configuration
 * Useful for setting up HTTP clients that read from environment
 */
export function getProxyEnvironmentVars(): Record<string, string> {
  const proxyUrl = getCurrentProxyUrl()

  if (!proxyUrl) {
    return {}
  }

  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
  }
}

/**
 * Apply proxy to a URL (for debugging/logging)
 */
export function formatProxiedUrl(url: string): string {
  const proxyUrl = getCurrentProxyUrl()
  if (proxyUrl) {
    return `${url} (via ${proxyUrl})`
  }
  return url
}

/**
 * Create headers with proxy authentication if needed
 */
export function getProxyAuthHeaders(): Record<string, string> {
  const state = useProxyStore.getState()

  if (state.config.mode === "manual" && state.config.manual) {
    const { username, password } = state.config.manual
    if (username && password) {
      const credentials = btoa(`${username}:${password}`)
      return {
        "Proxy-Authorization": `Basic ${credentials}`,
      }
    }
  }

  return {}
}

/**
 * Check if an error is retryable for proxy requests
 */
function isRetryableProxyError(error: Error): boolean {
  const message = error.message.toLowerCase()

  // Network errors
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up")
  ) {
    return true
  }

  // Server errors (5xx)
  if (
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  ) {
    return true
  }

  // Rate limiting
  if (message.includes("429") || message.includes("rate limit")) {
    return true
  }

  return false
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryableProxyFetchOptions extends ProxyFetchOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number
  /** Initial delay between retries in ms (default: 1000) */
  initialDelay?: number
  /** Callback on retry */
  onRetry?: (error: Error, attempt: number) => void
}

/**
 * Create a fetch function with proxy support and automatic retry
 *
 * Features:
 * - Automatic retry on network errors, timeouts, 5xx errors
 * - Exponential backoff with jitter
 * - Configurable retry count and delays
 */
export function createRetryableProxyFetch(customProxyUrl?: string) {
  const baseFetch = createProxyFetch(customProxyUrl)

  return async (input: RequestInfo | URL, init?: RetryableProxyFetchOptions): Promise<Response> => {
    const { maxRetries = 3, initialDelay = 1000, onRetry, ...fetchInit } = init || {}

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await baseFetch(input, fetchInit)

        // Check for server errors that should be retried
        if (response.status >= 500 && attempt < maxRetries) {
          const error = new Error(`HTTP ${response.status}`)
          lastError = error
          onRetry?.(error, attempt)

          // Exponential backoff with jitter
          const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 500
          await sleep(delay)
          continue
        }

        return response
      } catch (error) {
        lastError = error as Error
        onRetry?.(lastError, attempt)

        // Check if we should retry
        if (!isRetryableProxyError(lastError) || attempt === maxRetries) {
          throw error
        }

        // Exponential backoff with jitter
        const delay = initialDelay * Math.pow(2, attempt) + Math.random() * 500
        await sleep(delay)
      }
    }

    throw lastError
  }
}

/**
 * Default proxy-aware fetch instance
 */
export const proxyFetch = createProxyFetch()

/**
 * Default retryable proxy-aware fetch instance
 */
export const retryableProxyFetch = createRetryableProxyFetch()

export default proxyFetch
