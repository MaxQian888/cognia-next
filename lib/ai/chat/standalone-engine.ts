// Standalone (BYOK) chat engine — runs a chat turn entirely in the webview via
// the Vercel AI SDK `streamText`, with NO sidecar and NO paired desktop. It
// emits the exact same `ClaudeEvent` envelopes the Tauri transport delivers, so
// the whole chat store / renderer / usage pipeline is reused unchanged
// (`use-claude-chat.ts` feeds these straight into `handleEvent`).
//
// Reuse map:
//  - provider+model: `resolveStandaloneProvider` + `createFeatureProviderModel`
//  - streaming transport: `getStreamingFetch` + `browserDirectHeaders`
//  - AI SDK fullStream → SDKMessage: `createSdkEventMapper` (port of the sidecar
//    event-adapter)
//  - system prompt: `composeSystem` (shared with the agent executor)
//
// Lifecycle: one fresh mapper per turn (the duplicate-output guard); the engine
// emits assistant snapshots as they stream, a trailing `result` envelope with
// usage, then a single `session_ended` so the existing settle/seal logic runs.

import { convertToModelMessages, streamText, type UIMessage } from "ai"

import { composeSystem } from "@/lib/ai/agent/agent-executor"
import { createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { browserDirectHeaders, getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import type { ClaudeEvent, SendOptions } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { resolveStandaloneProvider } from "./resolve-standalone-provider"
import { createSdkEventMapper } from "./sdk-event-mapper"

export interface StandaloneTurnParams {
  sessionId: string
  /** Full UI history INCLUDING the just-appended optimistic user message. */
  messages: UIMessage[]
  sendOptions: SendOptions
  /** Routes a synthesized ClaudeEvent into the same per-session queue the transport uses. */
  emit: (evt: ClaudeEvent) => void
  signal: AbortSignal
  /** Test seam — inject a fake `streamText`. */
  streamTextImpl?: typeof streamText
}

/**
 * Run one standalone chat turn. Resolves the BYOK provider from local settings,
 * streams a completion, projects each AI SDK event into an SDKMessage envelope,
 * and emits a closing `session_ended`. Never throws — provider/stream failures
 * surface as `session_ended.error` so the existing error path renders them.
 */
export async function runStandaloneTurn(params: StandaloneTurnParams): Promise<void> {
  const { sessionId, messages, sendOptions, emit, signal } = params
  const stream = params.streamTextImpl ?? streamText

  try {
    const resolution = resolveStandaloneProvider(useSettingsStore.getState().settings)
    if (resolution.kind !== "resolved") {
      throw new Error(resolution.reason || "No model provider is configured.")
    }
    const modelId = sendOptions.model || resolution.model
    const model = createFeatureProviderModel(
      { ...resolution, model: modelId },
      { fetch: getStreamingFetch(), headers: browserDirectHeaders(resolution.protocol) }
    )

    const system = composeSystem(sendOptions.systemPrompt, sendOptions.appendSystemPrompt)
    const modelMessages = await convertToModelMessages(messages)

    const mapper = createSdkEventMapper({
      sessionId,
      sdkSessionId: globalThis.crypto.randomUUID(),
      model: modelId,
      provider: resolution.providerId,
    })
    mapper.reset()

    const result = stream({
      model,
      ...(system ? { system } : {}),
      messages: modelMessages,
      abortSignal: signal,
    })

    for await (const part of result.fullStream) {
      if (signal.aborted) break
      for (const env of mapper.handle(part)) {
        emit({ type: "event", sessionId, event: env })
      }
    }
    // Seal the streamed text/reasoning deltas into the canonical full `assistant`
    // snapshot (the deltas above are `stream_event` previews the renderer grows,
    // then replaces by id). Single-leg engine → one seal before the result.
    for (const env of mapper.sealAssistant()) {
      emit({ type: "event", sessionId, event: env })
    }

    const usage = await Promise.resolve(result.usage).catch(() => undefined)
    for (const env of mapper.finish(usage ? { usage } : undefined)) {
      emit({ type: "event", sessionId, event: env })
    }
    emit({ type: "session_ended", sessionId })
  } catch (err) {
    // An abort is a user Stop, not a failure — seal the partial cleanly.
    if (signal.aborted) {
      emit({ type: "session_ended", sessionId })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    emit({ type: "session_ended", sessionId, error: message })
  }
}
