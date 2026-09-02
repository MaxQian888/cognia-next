/**
 * The one HTTP helper the provider-neutral handlers share: an authenticated
 * JSON request through the app's proxy-aware fetch, with the provider's
 * static headers applied and a typed failure on a non-2xx answer.
 */

import { ProviderOperationFailureError } from "../failure"
import { failureForStatus } from "@/lib/provider-diagnostics/probe"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

export interface ProviderHttpRequest {
  method?: "GET" | "POST" | "DELETE"
  path: string
  body?: unknown
  /** Override the provider base URL (some surfaces live on another host). */
  baseURL?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** Auth header for the provider's protocol. Anthropic uses x-api-key. */
export function authHeaders(
  provider: Pick<ResolvedProvider, "protocol" | "apiKey" | "headers">
): Record<string, string> {
  const headers: Record<string, string> = { ...(provider.headers ?? {}) }
  if (provider.apiKey) {
    if (provider.protocol === "anthropic") {
      headers["x-api-key"] = provider.apiKey
      headers["anthropic-version"] ??= "2023-06-01"
    } else if (provider.protocol === "google") {
      headers["x-goog-api-key"] = provider.apiKey
    } else if (provider.protocol === "azure") {
      headers["api-key"] = provider.apiKey
    } else {
      headers.authorization = `Bearer ${provider.apiKey}`
    }
  }
  return headers
}

export function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

/** The base every REST path hangs off. The Anthropic wire lives under `/v1`. */
export function restBaseOf(
  provider: Pick<ResolvedProvider, "protocol" | "baseURL">,
  override?: string
): string | undefined {
  const base = override ?? provider.baseURL
  if (!base) return undefined
  if (provider.protocol === "anthropic" && !/\/v1\/?$/.test(base)) return joinUrl(base, "v1")
  return base
}

export interface ProviderHttpResponse<T = unknown> {
  status: number
  headers: Headers
  json: T
  text: string
}

export async function providerRequest<T = unknown>(
  provider: Pick<ResolvedProvider, "protocol" | "apiKey" | "headers" | "baseURL">,
  request: ProviderHttpRequest
): Promise<ProviderHttpResponse<T>> {
  const baseURL = restBaseOf(provider, request.baseURL)
  if (!baseURL) {
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: "provider has no base URL to call",
    })
  }
  const doFetch = request.fetchImpl ?? proxyFetch
  const headers: Record<string, string> = {
    ...authHeaders(provider),
    ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(request.headers ?? {}),
  }
  const response = await doFetch(joinUrl(baseURL, request.path), {
    method: request.method ?? (request.body !== undefined ? "POST" : "GET"),
    headers,
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  })
  const text = await response.text()
  if (!response.ok) {
    const failure = failureForStatus(response.status)
    throw new ProviderOperationFailureError({
      ...failure,
      message: `${failure.message}: ${text.slice(0, 300)}`,
    })
  }
  let json: T
  try {
    json = (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new ProviderOperationFailureError({
      code: "invalid-response",
      retryable: false,
      message: "provider returned a non-JSON body",
    })
  }
  return { status: response.status, headers: response.headers, json, text }
}

export interface ProviderUploadRequest {
  path: string
  /** Multipart fields. A `Blob` value is sent as a file part. */
  form: FormData
  baseURL?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** A multipart upload with the same auth, base and failure mapping as `providerRequest`. */
export async function providerUpload<T = unknown>(
  provider: Pick<ResolvedProvider, "protocol" | "apiKey" | "headers" | "baseURL">,
  request: ProviderUploadRequest
): Promise<ProviderHttpResponse<T>> {
  const baseURL = restBaseOf(provider, request.baseURL)
  if (!baseURL) {
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: "provider has no base URL to upload to",
    })
  }
  const doFetch = request.fetchImpl ?? proxyFetch
  // No content-type here: fetch sets the multipart boundary itself.
  const response = await doFetch(joinUrl(baseURL, request.path), {
    method: "POST",
    headers: { ...authHeaders(provider), ...(request.headers ?? {}) },
    body: request.form,
    ...(request.signal ? { signal: request.signal } : {}),
  })
  const text = await response.text()
  if (!response.ok) {
    const failure = failureForStatus(response.status)
    throw new ProviderOperationFailureError({
      ...failure,
      message: `${failure.message}: ${text.slice(0, 300)}`,
    })
  }
  let json: T
  try {
    json = (text ? JSON.parse(text) : {}) as T
  } catch {
    throw new ProviderOperationFailureError({
      code: "invalid-response",
      retryable: false,
      message: "provider returned a non-JSON body",
    })
  }
  return { status: response.status, headers: response.headers, json, text }
}

/** A raw GET whose body is bytes, not JSON (file content, batch output). */
export async function providerDownload(
  provider: Pick<ResolvedProvider, "protocol" | "apiKey" | "headers" | "baseURL">,
  request: Omit<ProviderHttpRequest, "body" | "method">
): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  const baseURL = restBaseOf(provider, request.baseURL)
  if (!baseURL) {
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: "provider has no base URL to download from",
    })
  }
  const doFetch = request.fetchImpl ?? proxyFetch
  const response = await doFetch(joinUrl(baseURL, request.path), {
    method: "GET",
    headers: { ...authHeaders(provider), ...(request.headers ?? {}) },
    ...(request.signal ? { signal: request.signal } : {}),
  })
  if (!response.ok) {
    const failure = failureForStatus(response.status)
    const text = await response.text()
    throw new ProviderOperationFailureError({
      ...failure,
      message: `${failure.message}: ${text.slice(0, 300)}`,
    })
  }
  const mimeType = response.headers.get("content-type") ?? undefined
  return { bytes: new Uint8Array(await response.arrayBuffer()), ...(mimeType ? { mimeType } : {}) }
}
