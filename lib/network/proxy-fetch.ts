/**
 * Fetch-compatible buffered HTTP bridge for the Cognia desktop proxy policy.
 *
 * The renderer never decides direct-vs-proxy and never handles proxy
 * credentials. In Tauri every request crosses the native command, where the
 * initialized runtime policy applies bypass, authentication, and fail-closed
 * routing. Browser builds continue to use the browser's ordinary fetch.
 */

import { invoke } from "@tauri-apps/api/core"
import { loggers } from "@cognia/logging"

import { isTauri } from "@/lib/tauri"
import { redactProxyUrl, shouldBypass } from "@/lib/network/proxy-config"
import { getActiveProxyUrl, getNetworkProxy, useProxyStore } from "@/stores/system"

const log = loggers.network

interface ProxiedRequestInput {
  requestId: string
  url: string
  method: string
  headers?: Record<string, string>
  bodyBase64?: string
  timeoutMs?: number
  redirect: RequestRedirect
  blockPrivate?: boolean
}

interface ProxiedRequestOutput {
  status: number
  bodyBase64: string
  headers: Record<string, string>
}

export interface ProxyFetchOptions extends RequestInit {
  /** Native request timeout in milliseconds. */
  timeout?: number
  /** Reject private/loopback/link-local targets in the native boundary. */
  blockPrivateHosts?: boolean
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `proxy-${Date.now()}-${Math.random()}`
}

function abortError(): Error {
  if (typeof DOMException !== "undefined")
    return new DOMException("The operation was aborted", "AbortError")
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return buffer
}

function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "proxy-authorization") {
      throw new Error("Proxy-Authorization is reserved for the native proxy connector")
    }
    result[key] = value
  })
  return result
}

async function bodyBase64(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  const bytes = new Uint8Array(await request.clone().arrayBuffer())
  return bytes.length > 0 ? bytesToBase64(bytes) : undefined
}

async function tauriProxiedFetch(
  input: RequestInfo | URL,
  init: ProxyFetchOptions = {}
): Promise<Response> {
  const { timeout, blockPrivateHosts, ...requestInit } = init
  const request = new Request(input, requestInit)
  if (request.signal.aborted) throw abortError()
  const encodedBody = await bodyBase64(request)
  if (request.signal.aborted) throw abortError()

  const id = requestId()
  const payload: ProxiedRequestInput = {
    requestId: id,
    url: request.url,
    method: request.method,
    headers: headerRecord(request.headers),
    bodyBase64: encodedBody,
    timeoutMs: timeout,
    redirect: request.redirect,
    ...(blockPrivateHosts ? { blockPrivate: true } : {}),
  }

  let rejectAborted: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject
  })
  const onAbort = () => {
    void invoke("proxy_http_cancel", { requestId: id }).catch(() => undefined)
    rejectAborted?.(abortError())
  }
  request.signal.addEventListener("abort", onAbort, { once: true })

  try {
    const native = invoke<ProxiedRequestOutput>("proxy_http_request", { input: payload })
    const result = await Promise.race([native, aborted])
    const responseHeaders = new Headers(result.headers)
    return new Response(base64ToArrayBuffer(result.bodyBase64), {
      status: result.status,
      headers: responseHeaders,
    })
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Proxy request failed: ${message}`, { cause: error })
  } finally {
    request.signal.removeEventListener("abort", onAbort)
  }
}

async function browserFetch(
  input: RequestInfo | URL,
  init: ProxyFetchOptions = {}
): Promise<Response> {
  const { timeout, blockPrivateHosts: _blockPrivateHosts, ...requestInit } = init
  if (!timeout) return fetch(input, requestInit)

  const request = new Request(input, requestInit)
  if (request.signal.aborted) throw abortError()
  const controller = new AbortController()
  const propagateAbort = () => controller.abort()
  request.signal.addEventListener("abort", propagateAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(request, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", propagateAbort)
  }
}

/** Create the canonical proxy-aware fetch implementation. */
export function createProxyFetch() {
  return async (input: RequestInfo | URL, init?: ProxyFetchOptions): Promise<Response> => {
    if (!isTauri()) return browserFetch(input, init)
    if (process.env.NODE_ENV === "development") {
      const endpoint = getActiveProxyUrl()
      if (endpoint) log.debug(`Proxy: routing request through ${redactProxyUrl(endpoint)}`)
    }
    return tauriProxiedFetch(input, init)
  }
}

export function getCurrentProxyUrl(): string | null {
  const endpoint = getActiveProxyUrl(useProxyStore.getState())
  return endpoint ? redactProxyUrl(endpoint) : null
}

export function isProxyEnabled(): boolean {
  const state = useProxyStore.getState()
  return state.config.enabled && state.config.mode !== "off"
}

export function getProxyConfig(): {
  enabled: boolean
  url: string | null
  host: string | null
  port: number | null
  protocol: string | null
} {
  const url = getCurrentProxyUrl()
  if (!url) return { enabled: false, url: null, host: null, port: null, protocol: null }
  try {
    const parsed = new URL(url)
    return {
      enabled: true,
      url: redactProxyUrl(url),
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
      protocol: parsed.protocol.replace(":", ""),
    }
  } catch {
    return { enabled: false, url: null, host: null, port: null, protocol: null }
  }
}

/** Diagnostic-only route preview. Native Rust remains the routing authority. */
export function shouldBypassProxy(url: string): boolean {
  return shouldBypass(url, getNetworkProxy().bypass)
}

export function formatProxiedUrl(url: string): string {
  const proxyUrl = getCurrentProxyUrl()
  return proxyUrl ? `${url} (via ${redactProxyUrl(proxyUrl)})` : url
}

function isRetryableProxyError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return [
    "network",
    "timeout",
    "econnreset",
    "enotfound",
    "econnrefused",
    "socket hang up",
    "500",
    "502",
    "503",
    "504",
    "429",
    "rate limit",
  ].some((part) => message.includes(part))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryableProxyFetchOptions extends ProxyFetchOptions {
  maxRetries?: number
  initialDelay?: number
  onRetry?: (error: Error, attempt: number) => void
}

export function createRetryableProxyFetch() {
  const baseFetch = createProxyFetch()
  return async (
    input: RequestInfo | URL,
    init: RetryableProxyFetchOptions = {}
  ): Promise<Response> => {
    const { maxRetries = 3, initialDelay = 1000, onRetry, ...fetchInit } = init
    let lastError: Error | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await baseFetch(input, fetchInit)
        if (response.status < 500 || attempt === maxRetries) return response
        lastError = new Error(`HTTP ${response.status}`)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (lastError.name === "AbortError" || !isRetryableProxyError(lastError)) throw error
        if (attempt === maxRetries) throw lastError
      }
      onRetry?.(lastError, attempt)
      const delay = initialDelay * 2 ** attempt + Math.random() * 500
      await sleep(delay)
    }
    throw lastError ?? new Error("Proxy request failed")
  }
}

export const proxyFetch = createProxyFetch()
export const retryableProxyFetch = createRetryableProxyFetch()
export default proxyFetch
