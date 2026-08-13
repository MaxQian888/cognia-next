"use client"

import { useMemo } from "react"
import type { MessageDisplayPreferences } from "@/types/appearance"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import { useSettingsStore } from "@/stores/settings"

export function useMessageDisplay(sessionOverride?: MessageDisplayPreferences) {
  const global = useSettingsStore((state) => state.settings?.messageDisplay)
  const legacyAgentFlow = useSettingsStore((state) => state.settings?.agentFlowMode?.mode)
  return useMemo(
    () => resolveMessageDisplayOptions(global, sessionOverride, legacyAgentFlow),
    [global, sessionOverride, legacyAgentFlow]
  )
}
