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
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { SendOptions } from "@/lib/claude/types"
import { toast } from "sonner"

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
 * Classify a sidecar-surfaced error string. Permanent wins ties; unknown
 * also maps to permanent so a logic bug isn't silently retried across
 * every provider in the chain.
 */
export function classifyError(message: string): ErrorClass {
  if (PERMANENT_PATTERNS.some((p) => p.test(message))) return "permanent"
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) return "transient"
  return "permanent"
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
  errorMessage: string
): Promise<boolean> {
  const settings = useSettingsStore.getState().settings
  // Default-on: only `=== false` disables. `?? true` would also match the
  // intent but keeps an unrecognised falsy value in line with the type.
  if (settings?.routingFallbackEnabled === false) return false

  const cached = useChatStore.getState().lastSendBySession[sessionId]
  if (!cached) return false

  const fallbackEntries = cached.options.aliasResolution?.fallbackEntries ?? []
  // `attemptIndex` is the index of the entry currently in `cached.options`.
  // The first retry shifts to `attemptIndex + 1`. When that index is out
  // of bounds the chain is exhausted — surface the original error.
  const nextIndex = cached.attemptIndex + 1
  if (fallbackEntries.length === 0 || nextIndex >= fallbackEntries.length) {
    useChatStore.getState().clearLastSend(sessionId)
    return false
  }

  if (classifyError(errorMessage) === "permanent") return false

  const nextEntry = fallbackEntries[nextIndex]
  const retryOptions: SendOptions = {
    ...cached.options,
    provider: nextEntry.providerId,
    model: nextEntry.modelId,
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
    attemptIndex: nextIndex,
  })

  // Surface a polite toast so the user knows we retried with another
  // provider rather than the chat freezing silently.
  try {
    toast.message(`Provider failed — retrying with ${nextEntry.providerId}…`, {
      duration: 3000,
    })
  } catch {
    // Toast failures are non-fatal.
  }

  try {
    await sendPrompt(sessionId, cached.content, retryOptions)
    return true
  } catch (err) {
    // The next `session_ended` event will route through this function
    // again. Treat the IPC throw as "no retry scheduled" so the caller
    // surfaces the original error if no further retry happens.
    console.warn("routing-fallback retry sendPrompt failed", err)
    return false
  }
}
