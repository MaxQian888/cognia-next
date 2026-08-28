"use client"

/**
 * React hook producing AI follow-up suggestions after an assistant reply.
 *
 * Fires once per turn: when the conversation goes idle with an assistant
 * message last, it asks the renderer utility LLM client (gated by
 * `hasNoLeakingPii`, via `suggestFollowUps`) for a few ready-to-send
 * follow-up messages. The result is cached by turn signature so re-renders
 * (and dismissals) never re-bill the model for the same turn. Returns `[]`
 * while streaming, when disabled, or when the gate / model declines.
 */

import { useEffect, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { buildHeadlessTurnLlmClient } from "@/lib/ai/headless-turn-llm-client"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { suggestFollowUps } from "@/lib/chat/completion/suggestions"
import type { GhostMessage } from "@/lib/chat/completion/ghost-prompt"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"

const RECENT = 6

export interface UseFollowUpSuggestionsResult {
  suggestions: string[]
  loading: boolean
  /** Hide suggestions for the current turn (won't re-fetch until the next turn). */
  dismiss: () => void
}

function recentMessages(): GhostMessage[] {
  const msgs = useChatStore.getState().messages
  return msgs.slice(-RECENT).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    text: extractPlainText(m.parts),
  }))
}

export function useFollowUpSuggestions(
  session: ChatSession | null | undefined
): UseFollowUpSuggestionsResult {
  const enabled = useSettingsStore(
    (s) => s.settings?.composerAssistance?.suggestions?.followUps !== false
  )
  const status = useChatStore((s) => s.status)
  // A stable per-turn signature: only changes when the last message does.
  const turnKey = useChatStore((s) => {
    const last = s.messages[s.messages.length - 1]
    return last && last.role === "assistant" ? `${s.messages.length}:${last.id}` : ""
  })

  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const dismissedKeyRef = useRef<string | null>(null)
  const sessionId = session?.id ?? null

  useEffect(() => {
    if (!enabled || status !== "idle" || turnKey === "") {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setSuggestions([])
      setLoading(false)
      return
    }
    if (dismissedKeyRef.current === turnKey) return

    const ac = new AbortController()
    let active = true
    setLoading(true)
    void (async () => {
      const settings = useSettingsStore.getState().settings as AppSettings | undefined
      const client =
        buildUtilityLlmClient({
          session: session ?? null,
          appSettings: settings,
          override: settings?.composerAssistance?.model,
          featureId: "composer-followups",
        }) ??
        // The direct client needs an API key the renderer can see, which a
        // Claude subscription never exposes — so on the app's primary auth mode
        // this feature was silently inert. One headless turn runs where the
        // credentials live, and works for every external agent too. Opt-in:
        // see `suggestions.agentFallback` for why it is not the default.
        (settings?.composerAssistance?.suggestions?.agentFallback === true
          ? buildHeadlessTurnLlmClient({ session: session ?? null, label: "Follow-up suggestions" })
          : null)
      if (!client) {
        if (active) {
          setSuggestions([])
          setLoading(false)
        }
        return
      }
      const result = await suggestFollowUps(
        { recentMessages: recentMessages() },
        { client, signal: ac.signal }
      )
      if (active && !ac.signal.aborted) {
        setSuggestions(result)
        setLoading(false)
      }
    })()

    return () => {
      active = false
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, status, turnKey, sessionId])

  const dismiss = () => {
    dismissedKeyRef.current = turnKey
    setSuggestions([])
  }

  return { suggestions, loading, dismiss }
}
