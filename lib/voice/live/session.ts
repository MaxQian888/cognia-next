/**
 * Turns persisted settings into a dialled, ready-to-open live-voice session.
 *
 * This is the layer between "what the user configured" and "what the controller
 * needs": it picks the deployments that are actually usable right now, orders
 * them, and mints a token against the first one that answers.
 *
 * Two rules here are safety properties, not preferences:
 *
 * - **Region never crosses.** Only deployments matching the configured region
 *   are considered. A CN user's audio silently reaching a Global endpoint (or
 *   the reverse) is a compliance failure, not a degraded experience, so it is
 *   filtered at selection time rather than guarded at the call site.
 *
 * - **Fallback happens before audio.** The caller may advance through this
 *   ordered candidate list after either mint or readiness failure. Once the
 *   retained microphone emits its first frame, the controller locks the
 *   provider and recovery remains same-provider.
 */

import type {
  Experimental_RealtimeModelV4,
  Experimental_RealtimeModelV4SessionConfig as RealtimeSessionConfig,
  Experimental_RealtimeModelV4ToolDefinition as RealtimeToolDefinition,
} from "@ai-sdk/provider"

import { isTauri as detectTauri } from "@/lib/platform/detect"

import {
  createLiveAdapter,
  getLiveVoiceCapabilities,
  isLiveVoiceProviderImplemented,
  LIVE_VOICE_DEFAULT_MODELS,
  LIVE_VOICE_DEFAULT_VOICES,
  LIVE_VOICE_PROVIDER_DESCRIPTORS,
} from "./adapter-registry"
import { isLiveVoiceProviderEnabled } from "./feature-flags"
import { mintLiveToken, type MintLiveTokenDeps } from "./token"
import type {
  LiveVoiceCapabilities,
  LiveVoiceDeployment,
  LiveVoiceProviderId,
  LiveVoiceSettings,
  PreparedRealtimeSession,
} from "./types"
import { assertLiveVoicePayloadPiiSafe } from "./reducer"

/** One deployment that passed every eligibility check, with its dial details resolved. */
export interface LiveVoiceCandidate {
  deployment: LiveVoiceDeployment
  capabilities: LiveVoiceCapabilities
  /** Resolved model id, including the descriptor default when omitted. */
  modelOrResource: string
  /** Omitted when the vendor should pick. */
  voice?: string
}

export interface BuildLiveVoiceSessionConfigOptions {
  candidate: LiveVoiceCandidate
  instructions?: string
  tools?: RealtimeToolDefinition[]
  /** Gemini-issued handle used only when resuming the same provider session. */
  resumptionHandle?: string
}

/** Build the one config object shared by token minting and the socket update. */
export function buildLiveVoiceSessionConfig({
  candidate,
  instructions,
  tools,
  resumptionHandle,
}: BuildLiveVoiceSessionConfigOptions): RealtimeSessionConfig {
  const { capabilities } = candidate
  return {
    ...(instructions ? { instructions } : {}),
    ...(candidate.voice ? { voice: candidate.voice } : {}),
    outputModalities: ["audio"],
    inputAudioFormat: { type: "audio/pcm", rate: capabilities.inputSampleRate },
    outputAudioFormat: { type: "audio/pcm", rate: capabilities.outputSampleRate },
    ...(capabilities.supportsInputTranscript ? { inputAudioTranscription: {} } : {}),
    ...(capabilities.supportsOutputTranscript ? { outputAudioTranscription: {} } : {}),
    turnDetection: capabilities.supportsServerVad
      ? { type: candidate.deployment.provider === "openai" ? "semantic-vad" : "server-vad" }
      : null,
    ...(capabilities.supportsTools && tools?.length ? { tools } : {}),
    ...(candidate.deployment.provider === "google"
      ? {
          providerOptions: {
            sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
            contextWindowCompression: {
              triggerTokens: 25_600,
              slidingWindow: { targetTokens: 12_800 },
            },
          },
        }
      : {}),
  }
}

/** Why no session can be started. Drives the message the dialog shows. */
export type LiveVoiceUnavailableReason =
  /** The `liveVoice.enabled` master switch is off. */
  | "disabled"
  /** Nothing configured yet. */
  | "no-deployments"
  /** Deployments exist, but none is usable in this region / shell / rollout. */
  | "none-eligible"

export class LiveVoiceUnavailableError extends Error {
  constructor(readonly reason: LiveVoiceUnavailableReason) {
    super(`live voice is unavailable: ${reason}`)
    this.name = "LiveVoiceUnavailableError"
  }
}

/** Raised when every candidate was tried and each one refused to mint. */
export class LiveVoiceMintFailedError extends Error {
  constructor(readonly failures: ReadonlyArray<{ provider: LiveVoiceProviderId; error: Error }>) {
    super(
      `no live voice provider could start a session: ${failures
        .map(({ provider, error }) => `${provider}: ${error.message}`)
        .join("; ")}`
    )
    this.name = "LiveVoiceMintFailedError"
  }
}

export interface SelectLiveVoiceCandidatesDeps {
  /** Rollout kill switch. */
  isProviderEnabled?: (provider: LiveVoiceProviderId) => boolean
  /** Whether an adapter exists at all. */
  isProviderImplemented?: (provider: LiveVoiceProviderId) => boolean
  /** Relay-only providers are desktop-only; a browser cannot set their auth headers. */
  isDesktop?: () => boolean
}

/**
 * The deployments worth trying, best first.
 *
 * Empty means no session can start; use {@link explainLiveVoiceUnavailability}
 * to tell the user which of the several possible reasons applies.
 */
export function selectLiveVoiceCandidates(
  settings: LiveVoiceSettings | undefined,
  deps: SelectLiveVoiceCandidatesDeps = {}
): LiveVoiceCandidate[] {
  const {
    isProviderEnabled = isLiveVoiceProviderEnabled,
    isProviderImplemented = isLiveVoiceProviderImplemented,
    // The real detector, not an optimistic `() => true`: relay-only providers
    // are genuinely unreachable from a browser, and assuming desktop would
    // offer a session the web shell cannot open.
    isDesktop = detectTauri,
  } = deps

  if (!settings?.enabled) return []

  const eligible: LiveVoiceCandidate[] = []
  for (const deployment of settings.deployments ?? []) {
    if (!deployment.enabled) continue
    // Region is the hard boundary — checked before anything else so a
    // cross-region deployment can never reach the rest of the pipeline.
    if (deployment.region !== settings.region) continue
    if (!isProviderImplemented(deployment.provider)) continue
    if (!isProviderEnabled(deployment.provider)) continue

    const capabilities = getLiveVoiceCapabilities(deployment.provider)
    if (!capabilities.regions.includes(deployment.region)) continue
    if (capabilities.transport === "native" && !isDesktop()) continue
    const descriptor = LIVE_VOICE_PROVIDER_DESCRIPTORS[deployment.provider]
    if (
      descriptor.requiredFields.some(
        (field) => typeof deployment[field] !== "string" || !deployment[field]?.trim()
      )
    ) {
      continue
    }

    const modelOrResource =
      deployment.model ?? LIVE_VOICE_DEFAULT_MODELS[deployment.provider] ?? undefined
    // A provider whose ids are account-scoped has no safe default; dialling a
    // guessed one produces an opaque vendor error rather than a clear setup one.
    if (!modelOrResource) continue

    const voice = deployment.voice ?? LIVE_VOICE_DEFAULT_VOICES[deployment.provider] ?? undefined
    eligible.push({ deployment, capabilities, modelOrResource, ...(voice ? { voice } : {}) })
  }

  const ordered = orderByPreference(eligible, settings.preferredDeploymentId)
  // `maxCandidates` counts the preferred one, so it can never mean "zero tries".
  const limit = settings.fallbackEnabled ? Math.max(1, Math.trunc(settings.maxCandidates || 1)) : 1
  return ordered.slice(0, limit)
}

function orderByPreference(
  candidates: LiveVoiceCandidate[],
  preferredDeploymentId: string | undefined
): LiveVoiceCandidate[] {
  if (!preferredDeploymentId) return candidates
  const preferred = candidates.filter((c) => c.deployment.id === preferredDeploymentId)
  if (preferred.length === 0) return candidates
  return [...preferred, ...candidates.filter((c) => c.deployment.id !== preferredDeploymentId)]
}

/** Which of the possible "nothing to dial" situations the user is in. */
export function explainLiveVoiceUnavailability(
  settings: LiveVoiceSettings | undefined
): LiveVoiceUnavailableReason {
  if (!settings?.enabled) return "disabled"
  if ((settings.deployments ?? []).length === 0) return "no-deployments"
  return "none-eligible"
}

/** Everything the controller needs to open a conversation. */
export interface ResolvedLiveVoiceSession {
  session: PreparedRealtimeSession
  adapter: Experimental_RealtimeModelV4
  /** Exact post-PII-gate config used to constrain token minting. */
  sessionConfig: RealtimeSessionConfig
  /** Absent when the vendor should choose. */
  voice?: string
}

export interface ResolveLiveVoiceSessionRequest {
  settings: LiveVoiceSettings | undefined
  /** Persona / system instructions. Screened by the PII gate during minting. */
  instructions?: string
  tools?: RealtimeToolDefinition[]
  /** Gemini native resumption handle. Never used across providers. */
  resumptionHandle?: string
  /** BYOK keys by provider, for the web shell. Ignored on desktop. */
  apiKeys?: Partial<Record<LiveVoiceProviderId, string>>
  /** Requested secret lifetime; providers may clamp it. */
  expiresAfterSeconds?: number
}

export interface ResolveLiveVoiceSessionDeps extends SelectLiveVoiceCandidatesDeps {
  mintToken?: typeof mintLiveToken
  mintDeps?: MintLiveTokenDeps
  createAdapter?: typeof createLiveAdapter
  /** Reports a candidate that failed before the next one is tried. */
  onCandidateFailed?: (provider: LiveVoiceProviderId, error: Error) => void
}

/**
 * Mint a session against the best available deployment.
 *
 * @throws {LiveVoiceUnavailableError} when nothing is eligible.
 * @throws {LiveVoiceMintFailedError} when every candidate refused.
 */
export async function resolveLiveVoiceSession(
  request: ResolveLiveVoiceSessionRequest,
  deps: ResolveLiveVoiceSessionDeps = {}
): Promise<ResolvedLiveVoiceSession> {
  const {
    mintToken = mintLiveToken,
    mintDeps,
    createAdapter = createLiveAdapter,
    onCandidateFailed,
    ...selectDeps
  } = deps

  const candidates = selectLiveVoiceCandidates(request.settings, selectDeps)
  if (candidates.length === 0) {
    throw new LiveVoiceUnavailableError(explainLiveVoiceUnavailability(request.settings))
  }

  const failures: { provider: LiveVoiceProviderId; error: Error }[] = []
  for (const candidate of candidates) {
    const { deployment, capabilities, modelOrResource, voice } = candidate
    try {
      const sessionConfig = buildLiveVoiceSessionConfig({
        candidate,
        instructions: request.instructions,
        tools: request.tools,
        resumptionHandle: request.resumptionHandle,
      })
      assertLiveVoicePayloadPiiSafe(sessionConfig)
      if (capabilities.transport === "native") {
        const adapter = await createAdapter({
          provider: deployment.provider,
          modelId: modelOrResource,
        })
        return {
          session: {
            connection: "host-keyring",
            deploymentId: deployment.id,
            provider: deployment.provider,
            region: deployment.region,
            modelOrResource,
            deployment: { ...deployment, model: modelOrResource, ...(voice ? { voice } : {}) },
            capabilities,
          },
          adapter,
          sessionConfig,
          ...(voice ? { voice } : {}),
        }
      }
      const minted = await mintToken(
        {
          provider: deployment.provider,
          modelId: modelOrResource,
          sessionConfig,
          apiKey: request.apiKeys?.[deployment.provider],
          expiresAfterSeconds: request.expiresAfterSeconds,
        },
        mintDeps
      )

      return {
        session: {
          connection: "ephemeral",
          deploymentId: deployment.id,
          provider: deployment.provider,
          region: deployment.region,
          modelOrResource,
          token: minted.token,
          url: minted.url,
          ...(minted.expiresAt === undefined ? {} : { expiresAt: minted.expiresAt }),
          capabilities,
        },
        adapter: minted.adapter,
        sessionConfig: minted.sessionConfig ?? sessionConfig,
        ...(voice ? { voice } : {}),
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      // A rejected persona is a configuration problem shared by every
      // candidate; retrying the next one just repeats the same refusal with a
      // less obvious error message.
      if (error.message.includes("PII redaction gate")) throw error
      failures.push({ provider: deployment.provider, error })
      onCandidateFailed?.(deployment.provider, error)
    }
  }

  throw new LiveVoiceMintFailedError(failures)
}
