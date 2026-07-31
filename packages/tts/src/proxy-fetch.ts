/**
 * Host-aware fetch helper used by every cloud TTS provider.
 *
 * Why: cognia-next ships with `output: "export"`, so there is no Next.js
 * server. Some providers (notably OpenAI without `dangerouslyAllowBrowser`)
 * also reject browser-Origin requests outright. Inside a native shell the
 * host installs a proxy (Tauri's `tts_proxy_fetch` Rust command via
 * `lib/tts/host-bindings.ts`), which keeps the API key in the host process
 * and bypasses CORS. Without an installed hook — or when the hook returns
 * `null` (e.g. web shell) — we fall back to plain browser `fetch` and assume
 * the provider/voice combo is browser-friendly; UI surfaces a warning for
 * the combinations that aren't.
 */

import { getTtsHost } from "./host"

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
  const native = getTtsHost().nativeProxyFetch?.(url, init)
  if (native) {
    return native
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
