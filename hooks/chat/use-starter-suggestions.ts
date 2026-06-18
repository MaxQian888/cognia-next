"use client"

/**
 * React hook producing AI starter prompts for the empty chat state. Fetches
 * once per (session, persona) when the conversation is empty, via the renderer
 * utility LLM client (gated by `hasNoLeakingPii`, through `suggestStarters`).
 * Returns `[]` while disabled, when the conversation already has messages, or
 * when the model / gate declines — so the empty state silently falls back to
 * the static character + dev-tool starters.
 */

import { useEffect, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { suggestStarters } from "@/lib/chat/completion/suggestions"
import type { AppSettings, ChatSession } from "@/lib/claude/types"

export interface StarterPersona {
  name?: string
  description?: string
}

export function useStarterSuggestions(
  session: ChatSession | null | undefined,
  persona?: StarterPersona
): string[] {
  const enabled = useSettingsStore(
    (s) => s.settings?.composerAssistance?.suggestions?.starters !== false
  )
  const isEmpty = useChatStore((s) => s.messages.length === 0)
  const [starters, setStarters] = useState<string[]>([])
  // Fetch at most once per session+persona so re-renders don't re-bill.
  const fetchedKeyRef = useRef<string | null>(null)
  const key = `${session?.id ?? "none"}:${persona?.name ?? ""}`

  useEffect(() => {
    if (!enabled || !isEmpty) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setStarters([])
      return
    }
    if (fetchedKeyRef.current === key) return
    fetchedKeyRef.current = key

    const ac = new AbortController()
    let active = true
    void (async () => {
      const settings = useSettingsStore.getState().settings as AppSettings | undefined
      const client = buildUtilityLlmClient({
        session: session ?? null,
        appSettings: settings,
        override: settings?.composerAssistance?.model,
        featureId: "composer-starters",
      })
      if (!client) return
      const result = await suggestStarters(
        { characterName: persona?.name, characterDescription: persona?.description },
        { client, signal: ac.signal }
      )
      if (active && !ac.signal.aborted) setStarters(result)
    })()

    return () => {
      active = false
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isEmpty, key])

  return enabled && isEmpty ? starters : []
}
