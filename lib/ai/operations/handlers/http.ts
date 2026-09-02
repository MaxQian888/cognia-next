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
    } else {
      headers.authorization = `Bearer ${provider.apiKey}`
    }
  }
  return headers
}

export function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
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
  const baseURL = request.baseURL ?? provider.baseURL
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
