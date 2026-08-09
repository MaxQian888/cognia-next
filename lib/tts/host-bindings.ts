/**
 * Installs cognia-next's platform bridges into the `@cognia/tts` host seam
 * (ADR-0068 E3). Imported for its side effect by every app-side TTS binding
 * module (`lib/tts/*`), so the host is configured before any synthesis call:
 *
 *  - `nativeProxyFetch` — routes provider HTTP through the Tauri
 *    `tts_proxy_fetch` Rust command (keeps API keys in the host process,
 *    bypasses CORS). Checked per call via `isTauri()`, exactly like the
 *    pre-extraction `proxyFetch`; returns `null` on web so the package falls
 *    through to browser fetch.
 *  - `isNativeShell` — gates the Tauri-websocket providers (Edge TTS,
 *    OpenAI realtime).
 *  - `allowCloudText` — applies the shared outbound PII gate before text
 *    reaches any cloud adapter; loopback/system paths are filtered by the
 *    orchestrator and never consult this cloud boundary.
 *  - `notify` — surfaces orchestrator failures as sonner toasts.
 */

import { toast } from "sonner"
import { hasNoLeakingPii } from "@cognia/redact"

import type { ProxyFetchInit, ProxyFetchResult } from "@cognia/tts/proxy-fetch"
import { setTtsHost } from "@cognia/tts/host"

import { isCapacitor, isTauri } from "@/lib/tauri"

const utf8Decoder = new TextDecoder("utf-8")

async function tauriProxyFetch(url: string, init: ProxyFetchInit): Promise<ProxyFetchResult> {
  const { invoke } = await import("@tauri-apps/api/core")
  const requestId = init.requestId ?? crypto.randomUUID()

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

  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError")
  const cancel = () => {
    void invoke("tts_proxy_cancel", { requestId }).catch(() => undefined)
  }
  init.signal?.addEventListener("abort", cancel, { once: true })

  let response: { status: number; mime: string; body_b64: string }
  try {
    response = await invoke<typeof response>("tts_proxy_fetch", {
      request: {
        url,
        method: init.method ?? "POST",
        headers: init.headers ?? {},
        json,
        body_b64: bodyB64,
        provider: init.provider,
        request_id: requestId,
        timeout_ms: init.timeoutMs,
      },
    })
  } catch (error) {
    if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError")
    throw error
  } finally {
    init.signal?.removeEventListener("abort", cancel)
  }

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

setTtsHost({
  nativeProxyFetch: (url, init) => (isTauri() ? tauriProxyFetch(url, init) : null),
  isNativeShell: isTauri,
  isMobileShell: isCapacitor,
  allowCloudText: (text) => hasNoLeakingPii(text),
  notify: {
    message: (text) => {
      toast.message(text)
    },
    error: (text) => {
      toast.error(text)
    },
  },
})

/** Test seam — re-exported so binding tests can assert against the impl. */
export { tauriProxyFetch }
