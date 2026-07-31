"use client"

/**
 * React hook wiring the composer's inline ghost-text autocomplete: it owns a
 * `GhostController` and feeds it from the composer's value, resolving each
 * suggestion through the renderer utility LLM client (gated by
 * `hasNoLeakingPii`). The chat-composer cousin of
 * `hooks/terminal/use-terminal-autocomplete.ts`.
 *
 * Thin by design — debounce / cancellation / cache / staleness all live in
 * the unit-tested controller. The hook just builds the per-query context
 * (draft + recent conversation), resolves the client lazily so live settings
 * changes are respected, and exposes `feed` / `accept` / `dismiss` plus the
 * current ghost to render. `accept()` returns the new textarea value — it
 * never submits.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { hasNoLeakingPii } from "@cognia/redact"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { GhostController, type GhostView } from "@/lib/chat/completion/ghost-controller"
import {
  buildGhostPrompt,
  sanitizeGhost,
  type GhostMessage,
} from "@/lib/chat/completion/ghost-prompt"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"

const MIN_DEBOUNCE = 200
const MAX_DEBOUNCE = 2000
const DEFAULT_DEBOUNCE = 500
const RECENT = 6

function recentMessages(): GhostMessage[] {
  const msgs = useChatStore.getState().messages
  return msgs.slice(-RECENT).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    text: extractPlainText(m.parts),
  }))
}

export interface UseComposerGhostTextResult {
  enabled: boolean
  ghost: string
  feed: (value: string, opts?: { suppress?: boolean }) => void
  /** Accept the ghost; returns the new full textarea value, or null. */
  accept: () => string | null
  dismiss: () => void
}

export function useComposerGhostText(
  session: ChatSession | null | undefined
): UseComposerGhostTextResult {
  const ghostSettings = useSettingsStore((s) => s.settings?.composerAssistance?.ghostText)
  const enabled = !!ghostSettings?.enabled
  const debounceMs = Math.min(
    MAX_DEBOUNCE,
    Math.max(MIN_DEBOUNCE, ghostSettings?.debounceMs ?? DEFAULT_DEBOUNCE)
  )

  const [view, setView] = useState<GhostView>({ ghost: "" })
  const controllerRef = useRef<GhostController | null>(null)
  const sessionId = session?.id ?? null

  useEffect(() => {
    const controller = new GhostController({
      debounceMs,
      query: async (input, signal) => {
        const settings = useSettingsStore.getState().settings as AppSettings | undefined
        const client = buildUtilityLlmClient({
          session: session ?? null,
          appSettings: settings,
          override: settings?.composerAssistance?.model,
          featureId: "composer-ghost",
        })
        if (!client) return null
        const { system, prompt } = buildGhostPrompt({
          draft: input,
          recentMessages: recentMessages(),
        })
        if (!hasNoLeakingPii(prompt)) return null
        let raw: string
        try {
          raw = await client.complete(prompt, {
            system,
            temperature: 0.2,
            maxTokens: 48,
            abortSignal: signal,
          })
        } catch {
          return null
        }
        if (signal.aborted) return null
        return sanitizeGhost(raw, input)
      },
      onChange: () => setView(controllerRef.current?.getView() ?? { ghost: "" }),
    })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
      setView({ ghost: "" })
    }
    // `session` identity is keyed by id; debounce rebuilds the controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, debounceMs])

  useEffect(() => {
    if (!enabled) controllerRef.current?.dismiss()
  }, [enabled])

  const feed = useCallback(
    (value: string, opts?: { suppress?: boolean }) => {
      if (!enabled) {
        controllerRef.current?.dismiss()
        return
      }
      controllerRef.current?.feed(value, opts)
    },
    [enabled]
  )

  const accept = useCallback(
    (): string | null => (enabled ? (controllerRef.current?.accept() ?? null) : null),
    [enabled]
  )
  const dismiss = useCallback(() => controllerRef.current?.dismiss(), [])

  return { enabled, ghost: view.ghost, feed, accept, dismiss }
}
