"use client"

/**
 * Agent invocation-flow display mode (simplified / standard / detailed).
 *
 * Single source of truth is the global appearance preference
 * `AppSettings.agentFlowMode`, persisted via the settings store's generic
 * `save()` (the established v47 convention — no dedicated setter). Both entry
 * points — the chat-header quick toggle and the appearance settings card —
 * drive the same value, so switching from either place applies everywhere.
 *
 * Reading is a cheap Zustand selector; the chat renderer already subscribes to
 * the settings store, so no extra context/provider is needed. When no
 * preference is stored (or in tests with null settings) it resolves to
 * `standard`, preserving the current card-based rendering.
 */

import { useCallback } from "react"

import { useSettingsStore } from "@/stores/settings"
import { type AgentFlowMode, DEFAULT_AGENT_FLOW, isAgentFlowMode } from "@/types/appearance"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"

/** Pure resolver — exported for unit tests. */
export function resolveAgentFlowMode(value: unknown): AgentFlowMode {
  return isAgentFlowMode(value) ? value : DEFAULT_AGENT_FLOW.mode
}

export interface UseAgentFlowMode {
  mode: AgentFlowMode
  setMode: (mode: AgentFlowMode) => void
}

export function useAgentFlowMode(): UseAgentFlowMode {
  const preferences = useSettingsStore((s) => s.settings?.messageDisplay)
  const stored = useSettingsStore((s) => s.settings?.agentFlowMode?.mode)
  const save = useSettingsStore((s) => s.save)
  const mode = resolveMessageDisplayOptions(preferences, undefined, stored).agentFlowMode

  const setMode = useCallback(
    (next: AgentFlowMode) => {
      void save({
        messageDisplay: {
          preset: preferences?.preset ?? "balanced",
          overrides: { ...(preferences?.overrides ?? {}), agentFlowMode: next },
        },
      })
    },
    [preferences, save]
  )

  return { mode, setMode }
}
