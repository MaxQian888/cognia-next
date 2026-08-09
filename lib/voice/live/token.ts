/**
 * Session-token minting for live voice.
 *
 * One code path for every shell. The AI SDK adapter always does the minting —
 * it owns each provider's endpoint, request body, response shape and resulting
 * socket URL — and the only thing that changes between shells is where the API
 * key comes from:
 *
 * - **Desktop (Tauri)** — the adapter is handed a `fetch` that relays through
 *   the Rust host, which injects the key from the keyring and pins the request
 *   to that provider's domain. The key never enters the renderer. This also
 *   sidesteps the desktop CSP, whose `connect-src` allows `ws:`/`wss:` but no
 *   provider HTTPS origin, so a direct renderer mint would be blocked outright.
 *
 * - **Web / Capacitor (BYOK)** — no host to relay through and no CSP in the
 *   way; the adapter uses the platform `fetch` with the key the user supplied.
 *
 * Instructions are screened through the fail-closed PII gate before either
 * path: they travel in the session config and end up on a third party's server.
 */

import type {
  Experimental_RealtimeModelV4,
  Experimental_RealtimeModelV4SessionConfig as RealtimeSessionConfig,
} from "@ai-sdk/provider"

import { isTauri as detectTauri } from "@/lib/platform/detect"

import { createLiveAdapter } from "./adapter-registry"
import { createLiveVoiceFetch, HOST_INJECTED_API_KEY } from "./proxy-fetch"
import { assertLiveVoicePayloadPiiSafe, screenLiveVoiceText } from "./reducer"
import type { LiveVoiceProviderId } from "./types"

export interface MintLiveTokenRequest {
  provider: LiveVoiceProviderId
  /** Model id, or the account-bound resource id for providers keyed that way. */
  modelId: string
  /** Exact config that will be repeated in the socket session-update. */
  sessionConfig: RealtimeSessionConfig
  /** BYOK credentials. Ignored on desktop, where the key stays in the keyring. */
  apiKey?: string
  baseURL?: string
  /** Requested secret lifetime; providers may clamp it. */
  expiresAfterSeconds?: number
}

export interface MintedLiveToken {
  token: string
  /** Always provider-supplied — the renderer never hard-codes a socket URL. */
  url: string
  /** Unix seconds, when the provider reports one. */
  expiresAt?: number
  /**
   * The adapter that minted this token, returned so the transport reuses it.
   *
   * Building a second one from the same inputs would usually work and would
   * occasionally not: the adapter carries the model id into
   * `getWebSocketConfig` and `serializeClientEvent`, so a mismatch between the
   * minting adapter and the parsing adapter is a silently wrong session.
   */
  adapter: Experimental_RealtimeModelV4
  /** Exact post-PII-gate config accepted by the token endpoint. */
  sessionConfig: RealtimeSessionConfig
}

/** Seams for tests; production callers pass nothing. */
export interface MintLiveTokenDeps {
  isTauri?: () => boolean
  createAdapter?: typeof createLiveAdapter
  createFetch?: typeof createLiveVoiceFetch
}

/**
 * Mint a ready-to-dial session token.
 *
 * @throws when the PII gate rejects the instructions, when no key is
 * configured, or when the provider rejects the mint.
 */
export async function mintLiveToken(
  request: MintLiveTokenRequest,
  deps: MintLiveTokenDeps = {}
): Promise<MintedLiveToken> {
  const {
    isTauri = detectTauri,
    createAdapter = createLiveAdapter,
    createFetch = createLiveVoiceFetch,
  } = deps

  const instructions = screenInstructions(request.sessionConfig.instructions)
  const sessionConfig: RealtimeSessionConfig = {
    ...request.sessionConfig,
    instructions,
  }
  assertLiveVoicePayloadPiiSafe(sessionConfig)
  const hostInjectsKey = isTauri()

  const adapter = await createAdapter({
    provider: request.provider,
    modelId: request.modelId,
    // On desktop the SDK only needs a non-empty credential to build a
    // well-formed request; the host replaces it with the real one.
    apiKey: hostInjectsKey ? HOST_INJECTED_API_KEY : request.apiKey,
    baseURL: request.baseURL,
    ...(hostInjectsKey ? { fetch: createFetch(request.provider) } : {}),
  })

  const secret = await adapter.doCreateClientSecret({
    expiresAfterSeconds: request.expiresAfterSeconds,
    sessionConfig,
  })

  if (!secret?.token || !secret.url) {
    throw new Error(`"${request.provider}" returned an incomplete realtime client secret`)
  }
  return {
    token: secret.token,
    url: secret.url,
    expiresAt: secret.expiresAt,
    adapter,
    sessionConfig,
  }
}

/**
 * Run instructions through the fail-closed PII gate.
 *
 * Empty input stays empty (the provider applies its own default). Non-empty
 * input that cannot be made safe throws — silently dropping the persona would
 * start a voice session that behaves nothing like the user configured.
 */
function screenInstructions(instructions: string | undefined): string {
  const raw = instructions?.trim()
  if (!raw) return ""

  const screened = screenLiveVoiceText(raw)
  if (!screened) {
    throw new Error("live voice instructions were rejected by the PII redaction gate")
  }
  return screened
}
