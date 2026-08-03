/**
 * A `fetch` the AI SDK can use on desktop without ever seeing an API key.
 *
 * The realtime providers mint session tokens over plain HTTPS, and their
 * `doCreateClientSecret` implementations take an injectable `fetch`. On desktop
 * we hand them this one: it forwards the request the SDK built to the Rust host
 * proxy, which pins the target to the provider's own domain, drops the
 * placeholder credential the SDK put in, and substitutes the real key from the
 * keyring.
 *
 * The result is one code path for web and desktop — the SDK owns every
 * provider-specific detail (endpoint, body shape, response parsing, socket URL)
 * and the host owns only the secret.
 *
 * Bodies are base64-encoded rather than passed as JSON so the exact bytes the
 * SDK produced reach the vendor. That matters more than it looks: the encoder
 * is UTF-8 first, because instructions routinely contain non-ASCII text and
 * `btoa` throws on it.
 */

import { voiceLiveClient, type VoiceProxyResponse } from "@/lib/tauri/voice-live"

import type { LiveVoiceProviderId } from "./types"

/**
 * What the SDK sees instead of a real key on desktop.
 *
 * Non-empty on purpose: `@ai-sdk/google` throws "API key is required" before it
 * ever calls `fetch` if the header is missing, so there would be nothing for
 * the host to fix up. The host strips this value from headers and replaces it
 * in the query string, so it never reaches a vendor.
 */
export const HOST_INJECTED_API_KEY = "cognia-host-injected"

/** Statuses the Fetch spec forbids a body on. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

const utf8Encoder = new TextEncoder()

export interface LiveVoiceFetchDeps {
  proxyFetch?: typeof voiceLiveClient.proxyFetch
}

/**
 * Build a `fetch` that relays through the host with `provider`'s key injected.
 *
 * Only for the desktop shell — on web the user's own key is already in the
 * renderer and plain `fetch` is correct.
 */
export function createLiveVoiceFetch(
  provider: LiveVoiceProviderId,
  deps: LiveVoiceFetchDeps = {}
): typeof fetch {
  const { proxyFetch = voiceLiveClient.proxyFetch } = deps

  const hostProxiedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = await normalizeRequest(input, init)
    const response = await proxyFetch({
      provider,
      url: request.url,
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body_b64: request.body }),
    })
    return toResponse(response)
  }

  return hostProxiedFetch as typeof fetch
}

interface NormalizedRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Base64, or undefined for a bodiless request. */
  body: string | undefined
}

async function normalizeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<NormalizedRequest> {
  // The SDK always passes a URL string, but `fetch` callers may pass a Request
  // and put nothing in `init`; reading only `init` would silently drop the body.
  const source = typeof Request !== "undefined" && input instanceof Request ? input : null
  const url = source ? source.url : typeof input === "string" ? input : String(input)

  const body = await readBody(init?.body ?? (source ? await source.clone().text() : undefined))

  return {
    url,
    method: (init?.method ?? source?.method ?? "POST").toUpperCase(),
    headers: flattenHeaders(init?.headers ?? source?.headers),
    body,
  }
}

function flattenHeaders(source: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!source) return headers

  if (typeof Headers !== "undefined" && source instanceof Headers) {
    source.forEach((value, name) => {
      headers[name] = value
    })
    return headers
  }
  if (Array.isArray(source)) {
    for (const [name, value] of source) headers[name] = value
    return headers
  }
  // The `typeof Headers` guard above keeps `Headers` in the union as far as TS
  // is concerned, so the record case needs an explicit assertion.
  return { ...(source as Record<string, string>) }
}

async function readBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body === null || body === undefined) return undefined
  if (typeof body === "string") return body.length === 0 ? undefined : utf8ToBase64(body)
  if (body instanceof Uint8Array) return bytesToBase64(body)
  if (body instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(body))
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return bytesToBase64(new Uint8Array(await body.arrayBuffer()))
  }
  // Streams and form bodies would need multipart support in the host proxy; no
  // realtime provider uses them, and guessing would corrupt the request.
  throw new TypeError("live voice host proxy cannot forward this request body type")
}

function toResponse(response: VoiceProxyResponse): Response {
  const { status } = response
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    // `new Response` throws a RangeError on these, which would surface as an
    // unrelated-looking failure deep inside the SDK.
    throw new Error(`live voice host proxy returned an unusable status: ${status}`)
  }

  const body = base64ToArrayBuffer(response.body_b64 ?? "")
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    headers: { "content-type": response.mime || "application/octet-stream" },
  })
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(utf8Encoder.encode(text))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  // Chunked so a large body cannot blow the argument limit on `String.fromCharCode`.
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

/**
 * Decodes straight into an `ArrayBuffer` rather than a `Uint8Array`: `BodyInit`
 * does not accept a typed array here, and `Uint8Array#buffer` is typed
 * `ArrayBufferLike`, which keeps `SharedArrayBuffer` in the union.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = base64 ? atob(base64) : ""
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return buffer
}
