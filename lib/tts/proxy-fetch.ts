/**
 * Tauri-aware fetch helper used by every cloud TTS provider.
 *
 * Why: cognia-next ships with `output: "export"`, so there is no Next.js
 * server. Some providers (notably OpenAI without `dangerouslyAllowBrowser`)
 * also reject browser-Origin requests outright. When running inside Tauri
 * we route the request through the `tts_proxy_fetch` Rust command, which
 * keeps the API key in the host process and bypasses CORS. Outside Tauri
 * (web shell), we fall back to plain browser `fetch` and assume the
 * provider/voice combo is browser-friendly — UI surfaces a warning for the
 * combinations that aren't.
 */

import { isTauri } from "@/lib/tauri"

export interface ProxyFetchInit {
  method?: "GET" | "POST" | "PUT" | "DELETE"
  headers?: Record<string, string>
  /** JSON body. Mutually exclusive with `body`. */
  json?: unknown
  /** Raw bytes (e.g., binary upload). Mutually exclusive with `json`. */
  body?: ArrayBuffer | Uint8Array | Blob
}

export interface ProxyFetchResult {
  status: number
  ok: boolean
  mime: string
  /** Audio / binary payload. Always present, may be empty Buffer on error. */
  bytes: ArrayBuffer
  /** Lazily-computed text view of the bytes — handy for error parsing. */
  text(): Promise<string>
  /** Tries to parse the bytes as JSON; throws if not JSON. */
  json<T = unknown>(): Promise<T>
}

const utf8Decoder = new TextDecoder("utf-8")

export async function proxyFetch(
  url: string,
  init: ProxyFetchInit = {}
): Promise<ProxyFetchResult> {
  if (isTauri()) {
    return tauriProxyFetch(url, init)
  }
  return browserFetch(url, init)
}

async function browserFetch(url: string, init: ProxyFetchInit): Promise<ProxyFetchResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  let body: BodyInit | undefined
  if (init.json !== undefined) {
    body = JSON.stringify(init.json)
    headers["content-type"] = headers["content-type"] ?? "application/json"
  } else if (init.body) {
    body =
      init.body instanceof Blob
        ? init.body
        : init.body instanceof Uint8Array
          ? new Blob([init.body as BlobPart])
          : new Blob([init.body as ArrayBuffer])
  }

  const res = await fetch(url, {
    method: init.method ?? "POST",
    headers,
    body,
  })
  const bytes = await res.arrayBuffer()
  return {
    status: res.status,
    ok: res.ok,
    mime: res.headers.get("content-type") ?? "application/octet-stream",
    bytes,
    text: async () => utf8Decoder.decode(bytes),
    json: async () => JSON.parse(utf8Decoder.decode(bytes)),
  }
}

async function tauriProxyFetch(url: string, init: ProxyFetchInit): Promise<ProxyFetchResult> {
  const { invoke } = await import("@tauri-apps/api/core")

  let bodyB64: string | undefined
  let json: unknown | undefined
  if (init.json !== undefined) {
    json = init.json
  } else if (init.body) {
    const buf =
      init.body instanceof Blob
        ? new Uint8Array(await init.body.arrayBuffer())
        : init.body instanceof Uint8Array
          ? init.body
          : new Uint8Array(init.body)
    bodyB64 = bytesToBase64(buf)
  }

  const response = await invoke<{
    status: number
    mime: string
    body_b64: string
  }>("tts_proxy_fetch", {
    request: {
      url,
      method: init.method ?? "POST",
      headers: init.headers ?? {},
      json,
      body_b64: bodyB64,
    },
  })

  const bytes = base64ToBytes(response.body_b64)
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    mime: response.mime,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    text: async () => utf8Decoder.decode(bytes),
    json: async () => JSON.parse(utf8Decoder.decode(bytes)),
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
