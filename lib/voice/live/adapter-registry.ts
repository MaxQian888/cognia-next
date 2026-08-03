/**
 * Provider registry for live voice.
 *
 * Two responsibilities, deliberately kept together so a provider can never be
 * selectable without declaring what it can do:
 *
 * 1. {@link LIVE_VOICE_CAPABILITIES} — the static capability table. This is the
 *    "documented at the type + labelled inert in the UI + pinned by a test"
 *    surface for intentional dormancy (Working Rule 7). Doubao and Baidu ship
 *    with `supportsTools: false` in the first release; the table is what the
 *    settings UI reads and what the tests pin.
 *
 * 2. {@link createLiveAdapter} — resolves an `Experimental_RealtimeModelV4` for
 *    a provider. OpenAI / Google / xAI come straight from the AI SDK via
 *    `provider.experimental_realtime`; Qwen / Doubao / Baidu need hand-written
 *    adapters (neither `@ai-sdk/alibaba` nor `@ai-sdk/bytedance` exposes any
 *    realtime surface) and land in Phase 2.
 *
 * Adapters are loaded through dynamic `import()` so a session that only ever
 * dials OpenAI never pulls the Google and xAI provider packages into the
 * bundle — this ships to a mobile WebView.
 */

import type { Experimental_RealtimeModelV4 } from "@ai-sdk/provider"

import type { LiveVoiceCapabilities, LiveVoiceProviderId } from "./types"

/**
 * Per-provider transport capabilities.
 *
 * Sample rates for OpenAI, Google and xAI are from their published realtime
 * docs. The China providers' rates are provisional: the Doubao framing model
 * (binary vs JSON) and whether Baidu exposes a single end-to-end speech socket
 * at all are both open questions the Phase 2 protocol POC has to settle. They
 * are marked `requiresRelay` because vendor auth rides on the WebSocket
 * handshake headers, which a browser cannot set.
 */
export const LIVE_VOICE_CAPABILITIES: Readonly<Record<LiveVoiceProviderId, LiveVoiceCapabilities>> =
  {
    openai: {
      supportsTools: true,
      supportsServerVad: true,
      supportsBargeIn: true,
      supportsInputTranscript: true,
      supportsOutputTranscript: true,
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
      requiresRelay: false,
    },
    google: {
      supportsTools: true,
      supportsServerVad: true,
      supportsBargeIn: true,
      supportsInputTranscript: true,
      supportsOutputTranscript: true,
      // Gemini Live takes 16 kHz uplink and answers at 24 kHz.
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      requiresRelay: false,
    },
    xai: {
      supportsTools: true,
      supportsServerVad: true,
      supportsBargeIn: true,
      supportsInputTranscript: true,
      supportsOutputTranscript: true,
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
      requiresRelay: false,
    },
    qwen: {
      supportsTools: true,
      supportsServerVad: true,
      supportsBargeIn: true,
      supportsInputTranscript: true,
      supportsOutputTranscript: true,
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      requiresRelay: true,
    },
    doubao: {
      // Dormant on purpose for the first release — the tool-call surface has not
      // been validated against the vendor protocol yet.
      supportsTools: false,
      supportsServerVad: true,
      supportsBargeIn: true,
      supportsInputTranscript: true,
      supportsOutputTranscript: true,
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      requiresRelay: true,
    },
    baidu: {
      // Dormant on purpose for the first release — see Doubao.
      supportsTools: false,
      supportsServerVad: true,
      supportsBargeIn: true,
      supportsInputTranscript: true,
      supportsOutputTranscript: true,
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      requiresRelay: true,
    },
  }

/** Capabilities for one provider. */
export function getLiveVoiceCapabilities(provider: LiveVoiceProviderId): LiveVoiceCapabilities {
  return LIVE_VOICE_CAPABILITIES[provider]
}

/**
 * Model to dial when a deployment names none.
 *
 * Sourced from `docs/research/2026-08-02-realtime-voice-models.md` and the AI
 * SDK's own model-id unions — not guessed. The China entries are `null` because
 * their ids are account-scoped: those deployments must carry an explicit
 * `model` or `resourceId`, and are skipped rather than dialled with a wrong id.
 */
export const LIVE_VOICE_DEFAULT_MODELS: Readonly<Record<LiveVoiceProviderId, string | null>> = {
  openai: "gpt-realtime-2.1",
  // "latest" tracks the stable native-audio release rather than pinning a
  // preview date that silently disappears.
  google: "gemini-2.5-flash-native-audio-latest",
  xai: "grok-voice-latest",
  qwen: null,
  doubao: null,
  baidu: null,
}

/**
 * Voice to request when a deployment names none.
 *
 * Only OpenAI has one: `marin` is what the retiring WebRTC dialog already used,
 * so keeping it means switching transports does not also change how the
 * assistant sounds. Everywhere else an unset voice is simply omitted from the
 * session config and the vendor applies its own default — inventing voice names
 * would fail the session outright.
 */
export const LIVE_VOICE_DEFAULT_VOICES: Readonly<Record<LiveVoiceProviderId, string | null>> = {
  openai: "marin",
  google: null,
  xai: null,
  qwen: null,
  doubao: null,
  baidu: null,
}

/** Providers whose adapter exists today. Qwen/Doubao/Baidu arrive in Phase 2. */
export const IMPLEMENTED_LIVE_VOICE_PROVIDERS = ["openai", "google", "xai"] as const

export type ImplementedLiveVoiceProvider = (typeof IMPLEMENTED_LIVE_VOICE_PROVIDERS)[number]

/** Whether {@link createLiveAdapter} can currently build an adapter for `provider`. */
export function isLiveVoiceProviderImplemented(
  provider: LiveVoiceProviderId
): provider is ImplementedLiveVoiceProvider {
  return (IMPLEMENTED_LIVE_VOICE_PROVIDERS as readonly string[]).includes(provider)
}

export interface LiveAdapterRequest {
  provider: LiveVoiceProviderId
  /** Model id, or the account-bound resource id for providers keyed that way. */
  modelId: string
  /**
   * Only needed when the renderer mints the token itself (web BYOK). On desktop
   * the key stays in Rust and this is omitted — the browser-side half of the
   * adapter (event parsing, session config, socket URL) never reads it.
   */
  apiKey?: string
  baseURL?: string
  /**
   * Overrides the SDK's HTTP client for token minting. Desktop passes a fetch
   * that relays through the Rust host so the real key stays in the keyring;
   * web leaves it unset and the SDK uses the platform `fetch` with the user's
   * own key.
   */
  fetch?: typeof fetch
}

/** Loads one provider's realtime model. Injectable so tests stay offline. */
export type LiveAdapterLoader = (
  request: LiveAdapterRequest
) => Promise<Experimental_RealtimeModelV4>

const DEFAULT_LOADERS: Readonly<Record<ImplementedLiveVoiceProvider, LiveAdapterLoader>> = {
  openai: async ({ modelId, apiKey, baseURL, fetch }) => {
    const { createOpenAI } = await import("@ai-sdk/openai")
    return createOpenAI({ apiKey, baseURL, fetch }).experimental_realtime(modelId)
  },
  google: async ({ modelId, apiKey, baseURL, fetch }) => {
    const { createGoogle } = await import("@ai-sdk/google")
    return createGoogle({ apiKey, baseURL, fetch }).experimental_realtime(modelId)
  },
  xai: async ({ modelId, apiKey, baseURL, fetch }) => {
    const { createXai } = await import("@ai-sdk/xai")
    return createXai({ apiKey, baseURL, fetch }).experimental_realtime(modelId)
  },
}

/** Thrown when a provider is known but its adapter has not shipped yet. */
export class LiveVoiceProviderUnavailableError extends Error {
  constructor(readonly provider: LiveVoiceProviderId) {
    super(
      `live voice provider "${provider}" has no adapter yet — ` +
        `Qwen, Doubao and Baidu arrive with the Phase 2 relay`
    )
    this.name = "LiveVoiceProviderUnavailableError"
  }
}

/**
 * Resolve the realtime model for `request.provider`.
 *
 * @throws {LiveVoiceProviderUnavailableError} for a provider without an adapter.
 */
export async function createLiveAdapter(
  request: LiveAdapterRequest,
  loaders: Partial<Record<LiveVoiceProviderId, LiveAdapterLoader>> = DEFAULT_LOADERS
): Promise<Experimental_RealtimeModelV4> {
  const loader = loaders[request.provider]
  if (!loader) throw new LiveVoiceProviderUnavailableError(request.provider)
  return loader(request)
}
