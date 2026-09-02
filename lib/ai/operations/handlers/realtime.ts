/**
 * `realtime.connect` (ADR-0163, Batch 16), in the contract shape: a
 * session handle, the transport, the socket URL and an ephemeral credential
 * for the media leg. The media stream itself is never proxied here, the
 * caller opens the socket. Two real wires:
 *   - OpenAI Realtime: an ephemeral client secret minted through
 *     `/realtime/client_secrets`, used on the WebSocket endpoint,
 *   - Gemini Live: an ephemeral auth token minted through the v1alpha
 *     `auth_tokens` resource, used on the BidiGenerateContent socket.
 * The ephemeral credential is returned once and never persisted.
 */

import type { z } from "zod"
import type { realtimeConnectInput, realtimeConnectOutput } from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import type { ProviderOperationHandlerRegistration } from "../registry"
import { handleFor } from "../resource-handle"
import { geminiRootOf } from "./files"
import { providerRequest, restBaseOf } from "./http"
import { isoMs } from "./jobs-shared"
import { requireModelId } from "./sdk-client"

export type RealtimeConnectInput = z.infer<typeof realtimeConnectInput>
export type RealtimeConnectOutput = z.infer<typeof realtimeConnectOutput>

/** `https://host/v1` to `wss://host/v1`. */
export function socketBaseOf(httpBase: string): string {
  return httpBase.replace(/^http(s?):\/\//i, (_match, secure: string) =>
    secure ? "wss://" : "ws://"
  )
}

// ---- OpenAI Realtime ---------------------------------------------------------------

interface OpenAiClientSecret {
  value?: string
  expires_at?: number
  session?: { id?: string; model?: string }
}

export const openAiRealtimeHandler: ProviderOperationHandlerRegistration<
  RealtimeConnectInput,
  RealtimeConnectOutput
> = {
  operationId: "realtime.connect",
  providerMatch: { kind: "protocol", protocol: "openai" },
  support: "native",
  async handler({ provider, request, signal }) {
    const model = requireModelId(provider, request.input.model)
    const base = restBaseOf(provider)
    if (!base) {
      throw new ProviderOperationFailureError({
        code: "capability-unsupported",
        retryable: false,
        message: `${provider.providerId} has no base URL for a realtime session`,
      })
    }
    const { json } = await providerRequest<OpenAiClientSecret>(provider, {
      path: "realtime/client_secrets",
      body: {
        session: {
          type: "realtime",
          model,
          ...(request.input.instructions ? { instructions: request.input.instructions } : {}),
          ...(request.input.voice ? { audio: { output: { voice: request.input.voice } } } : {}),
        },
      },
      signal,
    })
    if (!json.value) {
      throw new ProviderOperationFailureError({
        code: "invalid-response",
        retryable: true,
        message: "the realtime endpoint minted no client secret",
      })
    }
    const now = Date.now()
    const id = json.session?.id ?? `rt-${now.toString(36)}`
    return {
      handle: handleFor({
        kind: "realtime-session",
        id,
        owner: provider,
        deploymentRef: request.deploymentRef,
        createdAt: now,
      }),
      transport: "websocket",
      url: `${socketBaseOf(base).replace(/\/+$/, "")}/realtime?model=${encodeURIComponent(model)}`,
      ephemeralToken: json.value,
      ...(json.expires_at ? { expiresAt: Math.round(json.expires_at * 1000) } : {}),
    }
  },
}

// ---- Gemini Live -------------------------------------------------------------------

interface GeminiAuthToken {
  name?: string
  expireTime?: string
}

const GEMINI_LIVE_SOCKET =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

export const geminiRealtimeHandler: ProviderOperationHandlerRegistration<
  RealtimeConnectInput,
  RealtimeConnectOutput
> = {
  operationId: "realtime.connect",
  providerMatch: { kind: "protocol", protocol: "google" },
  support: "native",
  async handler({ provider, request, signal }) {
    const model = requireModelId(provider, request.input.model)
    const now = Date.now()
    const expireTime = new Date(now + 30 * 60 * 1000).toISOString()
    const { json } = await providerRequest<GeminiAuthToken>(provider, {
      baseURL: `${geminiRootOf(provider)}/v1alpha`,
      path: "auth_tokens",
      body: {
        uses: 1,
        expireTime,
        liveConnectConstraints: {
          model: model.startsWith("models/") ? model : `models/${model}`,
          config: {
            ...(request.input.instructions
              ? { systemInstruction: { parts: [{ text: request.input.instructions }] } }
              : {}),
            ...(request.input.voice
              ? {
                  speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: request.input.voice } },
                  },
                }
              : {}),
          },
        },
      },
      signal,
    })
    if (!json.name) {
      throw new ProviderOperationFailureError({
        code: "invalid-response",
        retryable: true,
        message: "the auth_tokens endpoint minted no token",
      })
    }
    const expiresAt = isoMs(json.expireTime)
    return {
      handle: handleFor({
        kind: "realtime-session",
        id: json.name,
        owner: provider,
        deploymentRef: request.deploymentRef,
        createdAt: now,
      }),
      transport: "websocket",
      url: `${GEMINI_LIVE_SOCKET}?access_token=${encodeURIComponent(json.name)}`,
      ephemeralToken: json.name,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
  },
}

export const REALTIME_HANDLERS: ProviderOperationHandlerRegistration[] = [
  openAiRealtimeHandler,
  { ...openAiRealtimeHandler, providerMatch: { kind: "protocol", protocol: "azure" } },
  geminiRealtimeHandler,
] as ProviderOperationHandlerRegistration[]

export type { ResolvedProvider }
