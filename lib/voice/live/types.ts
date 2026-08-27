/**
 * Shared contracts for the unified live-voice (realtime speech-to-speech) layer.
 *
 * The provider-facing contract is AI SDK 7's `Experimental_RealtimeModelV4`:
 * OpenAI / Google / xAI ship implementations via `provider.experimental_realtime`,
 * and the China providers (Qwen / Doubao / Baidu) get hand-written adapters
 * because `@ai-sdk/alibaba` and `@ai-sdk/bytedance` ship none.
 *
 * We deliberately do NOT use `experimental_useRealtime` / `AbstractRealtimeSession`
 * from `ai`: their `connect()` hard-codes `fetch(api.token, {method:'POST'})`
 * against an HTTP setup endpoint, and this app is a Next.js static export with no
 * `app/api/` at runtime. Driving `RealtimeModelV4` directly keeps every bit of the
 * SDK's per-provider normalization while letting the session shell mint tokens
 * over Tauri IPC instead of HTTP.
 *
 * Note: `liveVoice` settings are intentionally separate from the flat
 * `realtimeVoice` / `realtimeModel` / `realtimeInstructions` keys in
 * `AppSettings`, which belong to the (retired) OpenAI Realtime *TTS* provider.
 */

/**
 * The persisted half of the contract lives in `@cognia/agent-config-types`
 * because `AppSettings.liveVoice` is typed there and that package builds
 * standalone with zero `@/` imports — it cannot reach into `lib/`. Re-exported
 * here so callers have one import site for the whole subsystem.
 */
export type {
  LiveVoiceDeployment,
  LiveVoiceProviderId,
  LiveVoiceRegion,
  LiveVoiceSettings,
} from "@cognia/agent-config-types"

import type { LiveVoiceProviderId, LiveVoiceRegion } from "@cognia/agent-config-types"

/**
 * Every provider id, in a stable order. Exported as a runtime value so settings
 * validation and the deployment UI can iterate without duplicating the union.
 */
export const LIVE_VOICE_PROVIDER_IDS = [
  "openai",
  "google",
  "xai",
  "qwen",
  "doubao",
  "baidu",
] as const satisfies readonly LiveVoiceProviderId[]

/** Narrow an untrusted string (persisted settings, IPC payload) to a provider id. */
export function isLiveVoiceProviderId(value: unknown): value is LiveVoiceProviderId {
  return typeof value === "string" && (LIVE_VOICE_PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * What a provider's realtime transport actually supports.
 *
 * These drive UI affordances and the fallback ordering, and they are the
 * "labelled inert" axis for intentional dormancy (Working Rule 7): a provider
 * whose tool support is off in v1 declares `supportsTools: false` here, the UI
 * reads it, and a test pins it.
 */
export interface LiveVoiceCapabilities {
  supportsTools: boolean
  supportsServerVad: boolean
  supportsBargeIn: boolean
  supportsInputTranscript: boolean
  supportsOutputTranscript: boolean
  /** Wire sample rate the provider expects for uplink PCM16, in Hz. */
  inputSampleRate: number
  /** Sample rate the provider emits for downlink PCM16, in Hz. */
  outputSampleRate: number
  /** Regions in which this exact provider transport may be selected. */
  regions: readonly LiveVoiceRegion[]
  /** Browser SDK socket or host-keyring native socket. */
  transport: "browser" | "native"
}

/**
 * A validated, ready-to-dial session. Browser providers carry an ephemeral
 * URL/token; native providers carry only non-secret deployment metadata.
 */
interface PreparedRealtimeSessionBase {
  deploymentId: string
  provider: LiveVoiceProviderId
  region: LiveVoiceRegion
  modelOrResource: string
  capabilities: LiveVoiceCapabilities
}

export interface PreparedEphemeralRealtimeSession extends PreparedRealtimeSessionBase {
  connection: "ephemeral"
  token: string
  url: string
  /** Unix seconds. Ephemeral secrets are single-handshake; reconnect re-mints. */
  expiresAt?: number
}

export interface PreparedHostKeyringRealtimeSession extends PreparedRealtimeSessionBase {
  connection: "host-keyring"
  /** Validated non-secret deployment fields only. */
  deployment: import("@cognia/agent-config-types").LiveVoiceDeployment
}

/** Renderer-visible connection data. Native sessions never contain a secret. */
export type PreparedRealtimeSession =
  PreparedEphemeralRealtimeSession | PreparedHostKeyringRealtimeSession

/** Metadata stamped onto every persisted live-voice turn. */
export interface LiveVoiceMessageMetadata {
  provider: LiveVoiceProviderId
  modelOrResource: string
  region: LiveVoiceRegion
  modality: "audio"
  final: true
  /**
   * Voice turns do not fire `trigger.chat.message` workflows by default.
   * `lib/db/messages.ts` reads this off the message metadata.
   */
  triggerWorkflows: false
}
