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

import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai"

import { composeSystem } from "@/lib/ai/agent/agent-executor"
import { createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { browserDirectHeaders, getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import type { ClaudeEvent, SendOptions } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"
import { RoutingAttemptController } from "@cognia/provider-routing"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { resolveStandaloneProvider } from "./resolve-standalone-provider"
import { createSdkEventMapper } from "./sdk-event-mapper"
import { buildStandaloneTools, STANDALONE_MAX_STEPS } from "./standalone-tools"

export interface StandaloneTurnParams {
  sessionId: string
  /** Full UI history INCLUDING the just-appended optimistic user message. */
  messages: UIMessage[]
  sendOptions: SendOptions
  /**
   * Routes a synthesized ClaudeEvent into the same per-session queue the transport uses.
   * The returned promise is persistence backpressure: a terminal turn must not
   * outrun the renderer's serialized apply-and-persist pipeline.
   */
  emit: (evt: ClaudeEvent) => void | Promise<void>
  signal: AbortSignal
  /** Test seam — inject a fake `streamText`. */
  streamTextImpl?: typeof streamText
}

function commitsRoutingAttempt(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  const value = part as { type?: string; text?: string; delta?: string }
  if (value.type === "text-delta" || value.type === "reasoning-delta") {
    return Boolean(value.text?.length || value.delta?.length)
  }
  return (
    value.type === "tool-call" ||
    value.type === "tool-input-available" ||
    value.type === "dynamic-tool-call"
  )
}

function throwStreamPartError(part: unknown): void {
  if (!part || typeof part !== "object") return
  const value = part as { type?: string; error?: unknown }
  if (value.type !== "error") return
  if (value.error instanceof Error) throw value.error
  throw new Error(value.error === undefined ? "Provider stream failed." : String(value.error))
}

/**
 * Run one standalone chat turn. A routed plan is executed locally with the same
 * pre-commit fallback invariant as the sidecar path; direct/manual sends remain
 * a single hard-selected attempt. Provider/stream failures surface as a final
 * `session_ended.error` only after safe candidates are exhausted.
 */
export async function runStandaloneTurn(params: StandaloneTurnParams): Promise<void> {
  const { sessionId, messages, sendOptions, emit, signal } = params
  const stream = params.streamTextImpl ?? streamText

  try {
    const settings = useSettingsStore.getState().settings
    const plan = sendOptions.routingPlan
    const controller = plan
      ? new RoutingAttemptController(
          plan,
          settings?.routingConfig?.maxFallbackAttempts ?? DEFAULT_ROUTING_CONFIG.maxFallbackAttempts
        )
      : undefined
    let candidate = controller?.begin()
    let lastError: unknown
    let fallbackAttempt = false

    do {
      const providerId = candidate?.providerId ?? sendOptions.provider
      const resolution = resolveStandaloneProvider(settings, providerId)
      if (resolution.kind !== "resolved") {
        lastError = new Error(resolution.reason || "No model provider is configured.")
        candidate = controller?.failAndAdvance() ?? null
        fallbackAttempt = Boolean(candidate)
        continue
      }
      const modelId = candidate?.modelId ?? sendOptions.model ?? resolution.model
      const model = createFeatureProviderModel(
        { ...resolution, model: modelId },
        { fetch: getStreamingFetch(), headers: browserDirectHeaders(resolution.protocol) }
      )

      const system = composeSystem(sendOptions.systemPrompt, sendOptions.appendSystemPrompt)
      const modelMessages = await convertToModelMessages(messages)
      if (fallbackAttempt && !hasNoLeakingPiiDeep({ system, messages: modelMessages })) {
        throw new Error(
          "Provider fallback was blocked because the full conversation contains private data."
        )
      }
      const mapper = createSdkEventMapper({
        sessionId,
        sdkSessionId: globalThis.crypto.randomUUID(),
        model: modelId,
        provider: resolution.providerId,
      })
      mapper.reset()

      const resolvedTools = buildStandaloneTools(sendOptions, sessionId)
      if (resolvedTools?.rejected.length) {
        loggers.chat.warn("standalone: dropped tools with provider-invalid names", {
          names: resolvedTools.rejected.join(", "),
        })
      }

      try {
        const result = stream({
          model,
          ...(system ? { system } : {}),
          messages: modelMessages,
          abortSignal: signal,
          ...(resolvedTools
            ? { tools: resolvedTools.tools, stopWhen: stepCountIs(STANDALONE_MAX_STEPS) }
            : {}),
        })

        for await (const part of result.fullStream) {
          if (signal.aborted) break
          throwStreamPartError(part)
          if (commitsRoutingAttempt(part)) controller?.commit()
          for (const env of mapper.handle(part)) {
            await emit({ type: "event", sessionId, event: env })
          }
        }
        for (const env of mapper.sealAssistant()) {
          await emit({ type: "event", sessionId, event: env })
        }

        const usage = await Promise.resolve(result.usage).catch(() => undefined)
        for (const env of mapper.finish(usage ? { usage } : undefined)) {
          await emit({ type: "event", sessionId, event: env })
        }
        controller?.complete()
        await emit({ type: "session_ended", sessionId })
        return
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
        candidate = controller?.failAndAdvance() ?? null
        fallbackAttempt = Boolean(candidate)
      }
    } while (candidate)

    throw (
      lastError ??
      new Error(
        plan ? "No routed standalone provider is configured." : "No model provider is configured."
      )
    )
  } catch (err) {
    // An abort is a user Stop, not a failure — seal the partial cleanly.
    if (signal.aborted) {
      await emit({ type: "session_ended", sessionId })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    await emit({ type: "session_ended", sessionId, error: message })
  }
}
