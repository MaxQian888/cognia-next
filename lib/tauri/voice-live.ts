/**
 * Typed IPC wrapper for the live-voice host proxy.
 *
 * `lib/tauri` is the sole authoritative seam for Rust calls — business code
 * imports named wrappers from here, never `invoke` directly.
 *
 * Why a proxy rather than a `mint_token`-shaped command: the three official
 * providers each mint realtime session tokens differently (OpenAI and xAI POST
 * to `/realtime/client_secrets` with a bearer token; Google POSTs an auth-token
 * request with the key in `?key=` and a `bidiGenerateContentSetup` payload).
 * Reimplementing those in Rust would fork logic the AI SDK already owns and
 * keeps current. Instead the SDK builds the request in the renderer and this
 * command supplies the credential: `provider` tells the host which keyring
 * entry to inject, and it discards whatever placeholder the renderer used. The
 * long-lived API key never crosses this boundary in either direction.
 *
 * This also sidesteps the desktop CSP, whose `connect-src` allows `ws:`/`wss:`
 * but no provider HTTPS origin — a renderer-side mint would simply be blocked.
 */

import { transport } from "@/lib/tauri"
import type { LiveVoiceProviderId } from "@/lib/voice/live/types"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

export interface VoiceProxyRequest {
  /**
   * Keyring entry to inject. The host also pins the request to this provider's
   * own domain, so a mis-tagged call fails instead of handing one vendor's key
   * to another.
   */
  provider: LiveVoiceProviderId
  url: string
  method: string
  /** Any credential header here is stripped before the request goes out. */
  headers: Record<string, string>
  /** Base64-encoded request body. Snake_case to match the Rust `ProxyRequest`. */
  body_b64?: string
}

export interface VoiceProxyResponse {
  status: number
  mime: string
  /** Base64-encoded response body. */
  body_b64: string
}

export const voiceLiveClient = {
  /** Relay one HTTPS request through the host with the provider key injected. */
  proxyFetch: async (request: VoiceProxyRequest) => {
    assertVoiceProxyBodySafe(request.body_b64)
    return transport.call<VoiceProxyResponse>("tts_proxy_fetch", { request })
  },
}

function assertVoiceProxyBodySafe(bodyBase64: string | undefined): void {
  if (!bodyBase64) return
  const binary = atob(bodyBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const text = new TextDecoder().decode(bytes)
  let providerPayload: unknown = text
  try {
    providerPayload = JSON.parse(text)
  } catch {
    // The proxy currently carries JSON, but gate text as a safe fallback so a
    // future provider cannot turn non-JSON bodies into an ungated escape hatch.
  }
  if (!hasNoLeakingPiiDeep(providerPayload)) {
    throw new Error("live voice proxy request was blocked by the PII redaction gate")
  }
}
