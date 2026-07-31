"use client"

// Renderer-side routing fallback retry — when a turn fails with a transient
// error and the original send carried `aliasResolution.fallbackEntries`,
// re-issue the turn against the next entry in the chain instead of bubbling
// the error up. The cache (`useChatStore.lastSendBySession`) holds the
// SendOptions verbatim so we don't re-run the full `resolveSendOptions`
// pipeline; we trust the upstream resolution and only swap provider/model.
//
// This is the implementation of the P4 follow-up TODO that previously
// lived in `hooks/chat/use-claude-chat.ts`.

import { sendPrompt } from "@/lib/claude/ipc"
import { createDiagnostic } from "@cognia/diagnostics"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { useChatStore, type LastSendCacheEntry } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { SendOptions } from "@cognia/agent-config-types"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"
import { recordEvent } from "@cognia/agent-trace/emitter"
import { RoutingAttemptController } from "@cognia/provider-routing/routing-attempt-controller"
import { resolveProviderAttemptOptions } from "./provider-attempt-options"
import {
  classifyProviderErrorInfo,
  isTransientErrorClass,
  type ProviderErrorMeta,
} from "@cognia/provider-routing/error-classifier"

/**
 * Substring/regex set we treat as worth retrying. Real-world error strings
 * are noisy ("HTTPError 429: …" vs "rate_limit_error" vs "rate limit
 * exceeded") so the matcher is permissive.
 *
 * Keep these patterns deliberately narrow — biasing toward `permanent`
 * (no retry) prevents the renderer from silently masking real bugs by
 * grinding through the entire fallback chain.
 */
const TRANSIENT_PATTERNS: ReadonlyArray<RegExp> = [
  /timeout/i,
  /\b(rate[_ -]?limit|429)\b/i,
  /\bnetwork\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
  /\b5\d\d\b/,
  /provider[_ ]error/i,
  /overloaded|service[_ ]unavailable|unavailable/i,
]

const PERMANENT_PATTERNS: ReadonlyArray<RegExp> = [
  /unauthori[sz]ed|invalid[_ ]?api[_ ]?key|\b40[13]\b/i,
  /invalid[_ ]request|\b400\b/i,
  /missing[_ ]credential/i,
]

export type ErrorClass = "transient" | "permanent"

/**
 * Classify a sidecar-surfaced error string into the historical binary.
 * Permanent wins ties; unknown also maps to permanent so a logic bug
 * isn't silently retried across every provider in the chain.
 *
 * Kept for back-compat callers; the retry path below uses the richer
 * `classifyProviderError` taxonomy directly (special classes route
 * through their dedicated chains).
 */
export function classifyError(message: string): ErrorClass {
  if (PERMANENT_PATTERNS.some((p) => p.test(message))) return "permanent"
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) return "transient"
  return "permanent"
}

/** Re-issue the cached turn against `nextEntry`, updating the cache first. */
async function issueRetry(
  sessionId: string,
  cached: LastSendCacheEntry,
  nextEntry: ModelMappingEntry,
  cacheUpdate: Pick<LastSendCacheEntry, "attemptIndex" | "specialAttempts">
): Promise<boolean> {
  const settings = useSettingsStore.getState().settings
  let attemptOptions: Awaited<ReturnType<typeof resolveProviderAttemptOptions>> = {}
  try {
    if (settings) {
      attemptOptions = await resolveProviderAttemptOptions(nextEntry.providerId, settings)
    }
  } catch (error) {
    console.warn("routing-fallback credential resolution failed", error)
    return false
  }
  const retryOptions: SendOptions = {
    ...cached.options,
    provider: nextEntry.providerId,
    model: nextEntry.modelId,
    providerCredentials: attemptOptions.providerCredentials,
    protocolAdapterSpec: attemptOptions.protocolAdapterSpec,
    modelParams: attemptOptions.modelParams,
    fallbackModel: undefined,
    aliasResolution: cached.options.aliasResolution
      ? {
          ...cached.options.aliasResolution,
          resolvedTo: {
            providerId: nextEntry.providerId,
            modelId: nextEntry.modelId,
          },
        }
      : undefined,
  }

  // Bump the cache *before* the IPC so a second consecutive failure
  // increments cleanly and a concurrent read sees the post-bump state.
  useChatStore.getState().setLastSend(sessionId, {
    content: cached.content,
    options: retryOptions,
    attemptIndex: cacheUpdate.attemptIndex,
    ...(cacheUpdate.specialAttempts ? { specialAttempts: cacheUpdate.specialAttempts } : {}),
  })

  try {
    await sendPrompt(sessionId, cached.content, retryOptions)
    // Least-busy signal: the retry is now in flight against the next
    // provider (the failed attempt was settled by `session_ended`).
    const { useInFlightStore } = await import("@/stores/settings/in-flight-store")
    useInFlightStore.getState().begin(sessionId, nextEntry.providerId)
    // Disclose the substitution. This turn is now running on a provider the
    // user did not choose, which changes cost and output quality — not
    // something to leave unsaid.
    //
    // Replaces a hard-coded English `toast.message(...)` that fired *before*
    // the retry was issued: it promised a provider swap that could still fail,
    // and being built in `lib/` it could never be shown in another language.
    dispatchDiagnostic(
      createDiagnostic("degradedFallback", {
        source: "provider",
        meta: {
          sessionId,
          providerId: nextEntry.providerId,
          modelId: nextEntry.modelId,
          attempts: cacheUpdate.attemptIndex,
        },
      })
    )
    if (retryOptions.spanId) {
      const attributes = {
        attemptIndex: cacheUpdate.attemptIndex,
        providerId: nextEntry.providerId,
        modelId: nextEntry.modelId,
      }
      recordEvent(retryOptions.spanId, {
        name: "routing.fallback",
        at: Date.now(),
        attributes,
      })
      recordEvent(retryOptions.spanId, {
        name: "routing.attempt",
        at: Date.now(),
        attributes,
      })
    }
    return true
  } catch (err) {
    // The next `session_ended` event will route through this function
    // again. Treat the IPC throw as "no retry scheduled" so the caller
    // surfaces the original error if no further retry happens.
    console.warn("routing-fallback retry sendPrompt failed", err)
    return false
  }
}

/**
 * Returns true when a retry was actually scheduled (caller must suppress
 * the error toast and keep the chat in `streaming`); false otherwise.
 *
 * The function is deliberately tolerant: any failure to read the cache or
 * call the IPC is treated as "no retry" and the caller surfaces the
 * original error.
 */
export async function attemptRoutingFallback(
  sessionId: string,
  errorMessage: string,
  meta: ProviderErrorMeta = {}
): Promise<boolean> {
  const settings = useSettingsStore.getState().settings
  // Default-on: only `=== false` disables. `?? true` would also match the
  // intent but keeps an unrecognised falsy value in line with the type.
  if (settings?.routingFallbackEnabled === false) return false

  const cached = useChatStore.getState().lastSendBySession[sessionId]
  if (!cached) return false
  // Never replay after the first visible assistant frame or tool dispatch.
  if (cached.routingCommitted) return false

  // Use the structured meta (real HTTP status) when the sidecar captured it so
  // an unclassifiable message ("upstream connect error" with a 429) still
  // routes correctly. No backoff is applied here: the fallback targets a
  // DIFFERENT provider, so the failed provider's Retry-After is irrelevant —
  // that delay is honoured by the breaker cooldown in `recordProviderOutcome`.
  const errorClass = classifyProviderErrorInfo(errorMessage, meta).errorClass

  // ── Special classes: dedicated chains (LiteLLM context_window /
  // content_policy fallbacks). A same-sized model fails a context overflow
  // the same way, so these NEVER grind the main chain — either the mapping
  // declared a dedicated chain or the error surfaces.
  const specialKey =
    errorClass === "context-window-exceeded"
      ? ("contextWindowExceeded" as const)
      : errorClass === "content-policy"
        ? ("contentPolicy" as const)
        : undefined
  if (specialKey) {
    const chain = cached.options.aliasResolution?.specialFallbacks?.[specialKey] ?? []
    const cursor = cached.specialAttempts?.[specialKey] ?? 0
    if (chain.length === 0 || cursor >= chain.length) {
      useChatStore.getState().clearLastSend(sessionId)
      return false
    }
    return issueRetry(sessionId, cached, chain[cursor], {
      attemptIndex: cached.attemptIndex,
      specialAttempts: { ...cached.specialAttempts, [specialKey]: cursor + 1 },
    })
  }

  const fallbackEntries = cached.options.aliasResolution?.fallbackEntries ?? []
  let nextIndex = cached.attemptIndex + 1
  let nextEntry: ModelMappingEntry | undefined
  if (cached.options.routingPlan) {
    const controller = new RoutingAttemptController(
      cached.options.routingPlan,
      settings?.routingConfig?.maxFallbackAttempts ?? 3,
      () => Date.now(),
      {
        phase: cached.routingCommitted ? "committed" : "inFlight",
        candidateIndex: cached.attemptIndex,
      }
    )
    nextEntry = controller.failAndAdvance() ?? undefined
    nextIndex = controller.state.candidateIndex
  } else {
    nextEntry = fallbackEntries[nextIndex]
  }
  if (!nextEntry) {
    useChatStore.getState().clearLastSend(sessionId)
    return false
  }

  if (!isTransientErrorClass(errorClass)) return false

  // Per-error-class retry budget from the mapping (absent = the historical
  // retry-through-the-whole-chain behavior; 0 disables the class).
  const budget = cached.options.aliasResolution?.retryPolicy?.[errorClass]?.maxRetries
  if (budget !== undefined && nextIndex > budget) return false

  return issueRetry(sessionId, cached, nextEntry, {
    attemptIndex: nextIndex,
    specialAttempts: cached.specialAttempts,
  })
}
