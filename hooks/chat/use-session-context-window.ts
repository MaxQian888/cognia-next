"use client"

/**
 * One conversation's context window — occupancy, composition and compaction
 * policy — resolved exactly as the composer's context ring resolves it.
 *
 * The ring reads the active session's store messages and is mounted in the
 * composer; the conversation's Usage & context panel lives in the dock and gets
 * its messages from the dock's inputs. Both resolve through the same pure
 * helpers (`resolveContextWindowUsage`, `resolveContextBreakdown`,
 * `resolveAutoCompaction`), so the panel and the ring cannot show two numbers.
 */

import { useMemo } from "react"
import type { UIMessage } from "ai"

import { useSdkContextUsage } from "@/hooks/chat/use-sdk-context-usage"
import { resolveModelContextLength } from "@/lib/ai/model-options"
import {
  resolveAutoCompaction,
  resolveContextBreakdown,
  type AutoCompactionPolicy,
  type ContextBreakdown,
} from "@/lib/claude/context-breakdown"
import {
  getLatestRunProviderId,
  getLatestUsage,
  resolveContextWindowUsage,
  type ContextWindowUsage,
} from "@/lib/claude/usage"
import { useSettingsStore } from "@/stores/settings"

export interface SessionContextWindow {
  win: ContextWindowUsage
  breakdown: ContextBreakdown
  compaction: AutoCompactionPolicy
  /** True when the runtime's turns are compacted by an external agent, not the sidecar. */
  agentOwned: boolean
  /** Assistant turns in the transcript; 0 means nothing to compact yet. */
  assistantTurns: number
  /** Ask the runtime for a fresh live snapshot. */
  refresh: () => void
}

export function useSessionContextWindow(input: {
  sessionId: string | null
  messages: readonly UIMessage[]
  modelId?: string
  providerId?: string
}): SessionContextWindow {
  const { sessionId, messages, modelId, providerId } = input
  const { snapshot, refresh } = useSdkContextUsage(sessionId, providerId)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const catalogWindow = useMemo(
    () => resolveModelContextLength(modelId, providerId, providerSettings, customProviders),
    [modelId, providerId, providerSettings, customProviders]
  )

  return useMemo(() => {
    const list = messages as UIMessage[]
    const win = resolveContextWindowUsage(snapshot, getLatestUsage(list), modelId, catalogWindow)
    const agentOwned = getLatestRunProviderId(list) === "external"
    return {
      win,
      breakdown: resolveContextBreakdown(snapshot, list, win.used, win.max),
      compaction: resolveAutoCompaction(snapshot, { occupancyReported: win.reported, agentOwned }),
      agentOwned,
      assistantTurns: list.reduce((n, m) => n + (m.role === "assistant" ? 1 : 0), 0),
      refresh,
    }
  }, [messages, snapshot, modelId, catalogWindow, refresh])
}
