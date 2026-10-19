"use client"

/** Session-owned next-prompt suggestions with shared, bounded per-turn work. */
import { useCallback, useEffect, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  promptPredictionContextKey,
  useChatStore,
  useSessionStatus,
  useSessionVisibleMessages,
} from "@/stores/chat/chat-store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { suggestFollowUps } from "@/lib/chat/completion/suggestions"
import type { GhostMessage } from "@/lib/chat/completion/ghost-prompt"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { stripPromptPreambleFromParts } from "@/lib/chat/prompt-preamble"

const RECENT = 6
const CACHE_MAX = 64
const CACHE_TTL_MS = 10 * 60_000
const DIRECT_TIMEOUT_MS = 15_000
const AGENT_TIMEOUT_MS = 30_000
const EMPTY: string[] = []

export type FollowUpSuggestionStatus =
  | "disabled"
  | "ineligible"
  | "loading"
  | "ready"
  | "unavailable"
  | "no-prediction"
  | "dismissed"
  | "error"

export interface UseFollowUpSuggestionsResult {
  suggestions: string[]
  loading: boolean
  status: FollowUpSuggestionStatus
  /** Hide this turn in every pane and on subsequent remounts. */
  dismiss: () => void
  /** Retry a failed/unavailable generation; never automatically re-bill on error. */
  retry: () => void
}

type Snapshot = { key: string; suggestions: string[]; status: FollowUpSuggestionStatus }
type Entry = {
  snapshot: Snapshot
  listeners: Set<(snapshot: Snapshot) => void>
  controller: AbortController
  expires: number
  settled: boolean
  restart?: () => void
}
const cache = new Map<string, Entry>()
// Provider settings can contain credentials. Identity invalidates configuration
// changes without copying credentials into cache keys or diagnostic state.
const configurationIds = new WeakMap<object, number>()
let nextConfigurationId = 0
function configurationId(value: unknown): number {
  if (!value || typeof value !== "object") return 0
  let id = configurationIds.get(value)
  if (id === undefined) {
    id = ++nextConfigurationId
    configurationIds.set(value, id)
  }
  return id
}

function publish(entry: Entry, status: FollowUpSuggestionStatus, suggestions = EMPTY) {
  entry.snapshot = { key: entry.snapshot.key, status, suggestions }
  for (const listener of entry.listeners) listener(entry.snapshot)
}

function pruneCache() {
  for (const [key, entry] of cache) {
    if (entry.expires <= Date.now() && entry.listeners.size === 0) {
      entry.controller.abort()
      cache.delete(key)
    }
  }
  // Active subscribers are bounded by mounted panes; evict only inactive work.
  for (const [key, entry] of cache) {
    if (cache.size < CACHE_MAX) break
    if (entry.listeners.size === 0) {
      entry.controller.abort()
      cache.delete(key)
    }
  }
}

async function generate(
  entry: Entry,
  session: ChatSession,
  settings: AppSettings | null | undefined,
  recentMessages: GhostMessage[]
) {
  const controller = entry.controller
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  const isCurrent = () => cache.get(entry.snapshot.key) === entry && entry.controller === controller
  try {
    const direct = buildUtilityLlmClient({
      session,
      appSettings: settings,
      override: settings?.composerAssistance?.model,
      featureId: "composer-followups",
    })
    const client =
      direct ??
      (settings?.composerAssistance?.suggestions?.agentFallback === true
        ? buildHeadlessTurnLlmClient({ session, label: "Follow-up suggestions" })
        : null)
    if (!client) {
      publish(entry, "unavailable")
      return
    }
    // An Agent must be allowed to start; it does not have the latency profile
    // of a direct utility request. Race the deadline even if a client ignores abort.
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => {
          controller.abort()
          reject(new Error("Prediction request timed out"))
        },
        direct ? DIRECT_TIMEOUT_MS : AGENT_TIMEOUT_MS
      )
    })
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error("Prediction request cancelled"))
      controller.signal.addEventListener("abort", abortListener, { once: true })
    })
    const result = await Promise.race([
      suggestFollowUps(
        { recentMessages },
        {
          client,
          signal: controller.signal,
          propagateErrors: true,
        }
      ),
      deadline,
      cancelled,
    ])
    if (!controller.signal.aborted && isCurrent()) {
      publish(entry, result.length ? "ready" : "no-prediction", result)
    }
  } catch {
    // A superseded/dismissed request must never revive its old prediction.
    if (isCurrent() && entry.snapshot.status === "loading") {
      publish(entry, "error")
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (abortListener) controller.signal.removeEventListener("abort", abortListener)
    if (entry.controller === controller) entry.settled = true
  }
}

export function useFollowUpSuggestions(
  session: ChatSession | null | undefined,
  options: { enabled?: boolean } = {}
): UseFollowUpSuggestionsResult {
  const settings = useSettingsStore((s) => s.settings)
  const enabled = settings?.composerAssistance?.suggestions?.followUps !== false
  const sessionId = session?.id ?? null
  const status = useSessionStatus(sessionId)
  const messages = useSessionVisibleMessages(sessionId)
  const nativePrediction = useChatStore((state) =>
    sessionId ? state.sessions[sessionId]?.promptPrediction : undefined
  )
  // Native predictions already share the billable chat turn. Never issue an
  // additional synthetic request while that turn is waiting or abstaining.
  const nativeMode =
    settings?.composerAssistance?.suggestions?.agentFallback === true && !!nativePrediction
  const nativeBranchKey = useChatStore((state) =>
    JSON.stringify(sessionId ? (state.sessions[sessionId]?.activeBranchByGroup ?? {}) : {})
  )
  const nativeText = nativePrediction?.text
  const nativeRequestedAt = nativePrediction?.requestedAt
  const lastUserId = [...messages].reverse().find((message) => message.role === "user")?.id ?? null
  const nativeMatches =
    nativePrediction?.userMessageId === lastUserId &&
    (!nativePrediction.branchKey || nativePrediction.branchKey === nativeBranchKey) &&
    (!nativeText || nativePrediction.contextKey === promptPredictionContextKey(messages))
  const last = messages[messages.length - 1]
  const eligible =
    !!sessionId && options.enabled !== false && status === "idle" && last?.role === "assistant"
  const recentMessages: GhostMessage[] = messages.slice(-RECENT).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    text: extractPlainText(stripPromptPreambleFromParts(message.parts)),
  }))
  const key = JSON.stringify([
    sessionId,
    nativeMode ? [nativePrediction?.turnId, nativeRequestedAt] : null,
    session?.transcriptRevision,
    // Include the visible path and its content, not just the terminal id.
    messages.map((message) => message.id),
    recentMessages,
    session?.model,
    session?.providerOverride,
    session?.accountId,
    session?.characterId,
    settings?.composerAssistance?.model,
    settings?.composerAssistance?.suggestions,
    settings?.defaultProvider,
    settings?.defaultModel,
    configurationId(settings?.providerSettings),
    configurationId(settings?.customProviders),
    configurationId(settings?.modelMappings),
  ])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  useEffect(() => {
    if (!enabled || !eligible || !session) return
    pruneCache()
    let entry = cache.get(key)
    // Errors/unavailability have UI state, but are never successful empty
    // predictions cached across visits. A later visit can resolve new auth.
    if (
      entry &&
      entry.listeners.size === 0 &&
      (entry.snapshot.status === "error" || entry.snapshot.status === "unavailable")
    ) {
      cache.delete(key)
      entry = undefined
    }
    let created = false
    if (!entry) {
      const owned: Entry = {
        snapshot: { key, status: "loading", suggestions: EMPTY },
        listeners: new Set(),
        controller: new AbortController(),
        expires: Date.now() + CACHE_TTL_MS,
        settled: false,
        restart: nativeMode
          ? undefined
          : () => {
              owned.controller = new AbortController()
              owned.settled = false
              publish(owned, "loading")
              void generate(owned, session, settings, recentMessages)
            },
      }
      entry = owned
      cache.set(key, entry)
      created = true
    }
    entry.listeners.add(setSnapshot)
    // An external shared cache subscription, keyed before rendering its value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot(entry.snapshot)
    let nativeTimeout: ReturnType<typeof setTimeout> | undefined
    if (nativeMode) {
      if (entry.snapshot.status !== "dismissed") {
        if (!nativeMatches) {
          entry.settled = true
          publish(entry, "no-prediction")
        } else if (nativeText) {
          entry.settled = true
          publish(entry, "ready", [nativeText])
        } else {
          const remaining = Math.max(0, (nativeRequestedAt ?? 0) + AGENT_TIMEOUT_MS - Date.now())
          entry.settled = remaining === 0
          publish(entry, remaining > 0 ? "loading" : "no-prediction")
          if (remaining > 0) {
            const waiting = entry
            nativeTimeout = setTimeout(() => {
              if (waiting.snapshot.status === "loading") {
                waiting.settled = true
                publish(waiting, "no-prediction")
              }
            }, remaining)
          }
        }
      }
    } else if (created) void generate(entry, session, settings, recentMessages)
    const subscribed = entry
    return () => {
      if (nativeTimeout !== undefined) clearTimeout(nativeTimeout)
      subscribed.listeners.delete(setSnapshot)
      // React strict effects and an immediate pane remount reuse the same work.
      // Once the last consumer is truly gone, stop the chargeable request.
      queueMicrotask(() => {
        if (
          subscribed.listeners.size === 0 &&
          !subscribed.settled &&
          cache.get(key) === subscribed
        ) {
          cache.delete(key)
          subscribed.controller.abort()
        }
      })
    }
    // `key` contains the relevant session/context/configuration values. Avoid
    // restarting a request for unrelated object-identity changes or rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, eligible, key, nativeMode, nativeMatches, nativeText, nativeRequestedAt])

  const dismiss = useCallback(() => {
    const entry = cache.get(key)
    if (!entry) return
    entry.controller.abort()
    entry.settled = true
    publish(entry, "dismissed")
  }, [key])
  const retry = useCallback(() => {
    const entry = cache.get(key)
    if (entry && (entry.snapshot.status === "error" || entry.snapshot.status === "unavailable")) {
      entry.restart?.()
    }
  }, [key])

  // Ownership is checked during render, so a prior session/branch's result is
  // never exposed while the effect unsubscribes from its request.
  const current =
    snapshot?.key === key &&
    (!nativeMode ||
      snapshot.status === "dismissed" ||
      !nativeText ||
      snapshot.suggestions[0] === nativeText)
      ? snapshot
      : null
  const predictionStatus = !enabled
    ? "disabled"
    : !eligible
      ? "ineligible"
      : nativeMode && !nativeMatches
        ? "no-prediction"
        : (current?.status ?? "loading")
  return {
    suggestions: predictionStatus === "ready" ? (current?.suggestions ?? EMPTY) : EMPTY,
    loading: predictionStatus === "loading",
    status: predictionStatus,
    dismiss,
    retry,
  }
}
