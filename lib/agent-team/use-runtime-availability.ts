"use client"

/**
 * Hook reporting whether each `TeammateRuntime` is currently usable from the
 * team workspace chat:
 *
 *   - `"claude"` is `"ready"` when the user has saved an Anthropic API key in
 *     Settings → Providers (`AppSettings.apiKey`); otherwise `"missing-key"`.
 *
 *   - Every external runtime (`"codex"`, `"claude-code"`, `"gemini-cli"`,
 *     `"cursor-cli"`) is `"ready"` when there's an enabled
 *     `ExternalAgentConfig` with `metadata.preset === runtime` *and* the
 *     external-agent-store reports its connection as `"connected"`.
 *     `"no-agent"` if no preset matches; `"disconnected"` if matched but not
 *     yet connected.
 *
 * Used by the mention chips and the chat-tab status banner so users see at a
 * glance which `@<name>`s will succeed before they hit send.
 */

import { useMemo } from "react"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useSettingsStore } from "@/stores/settings"
import { BUILTIN_EXECUTABLE_PRESET_IDS } from "@/lib/ai/agent/external/presets"
import type { TeammateRuntime } from "@/types/agent/agent-team"

export type RuntimeAvailabilityStatus = "ready" | "missing-key" | "no-agent" | "disconnected"

export type RuntimeAvailabilityMap = Record<TeammateRuntime, RuntimeAvailabilityStatus>

// Every external runtime is a preset id; derive the list from the catalog so it
// stays in lockstep with `TeammateRuntime` and the members dropdown.
const EXTERNAL_RUNTIMES: TeammateRuntime[] = [...BUILTIN_EXECUTABLE_PRESET_IDS]
const ALL_RUNTIMES: TeammateRuntime[] = ["claude", ...EXTERNAL_RUNTIMES]

export function useRuntimeAvailability(): RuntimeAvailabilityMap {
  const apiKey = useSettingsStore((s) => s.settings?.apiKey ?? "")
  const agents = useExternalAgentStore((s) => s.agents)
  const connectionStatus = useExternalAgentStore((s) => s.connectionStatus)

  return useMemo<RuntimeAvailabilityMap>(() => {
    const map = {} as RuntimeAvailabilityMap

    map.claude = apiKey && apiKey.length > 0 ? "ready" : "missing-key"

    for (const runtime of EXTERNAL_RUNTIMES) {
      const match = Object.values(agents).find((a) => {
        if (!a.enabled) return false
        const preset = (a.metadata as Record<string, unknown> | undefined)?.preset
        return typeof preset === "string" && preset === runtime
      })
      if (!match) {
        map[runtime] = "no-agent"
        continue
      }
      const status = connectionStatus[match.id]
      map[runtime] = status === "connected" ? "ready" : "disconnected"
    }

    // Defensive: ensure the map covers every runtime (loop is the source of truth).
    for (const r of ALL_RUNTIMES) {
      if (!(r in map)) map[r] = "no-agent"
    }
    return map
  }, [apiKey, agents, connectionStatus])
}

/**
 * Pure helper for a hook-free computation against snapshotted state.
 * Used in tests and in non-React modules that already pulled `getState()`.
 */
export function computeRuntimeAvailability(input: {
  apiKey: string | undefined
  agents: Array<{
    id: string
    enabled: boolean
    metadata?: Record<string, unknown>
  }>
  connectionStatus: Record<string, string>
}): RuntimeAvailabilityMap {
  const apiKey = input.apiKey ?? ""
  const map = {} as RuntimeAvailabilityMap
  map.claude = apiKey.length > 0 ? "ready" : "missing-key"
  for (const runtime of EXTERNAL_RUNTIMES) {
    const match = input.agents.find((a) => {
      if (!a.enabled) return false
      const preset = a.metadata?.preset
      return typeof preset === "string" && preset === runtime
    })
    if (!match) {
      map[runtime] = "no-agent"
      continue
    }
    map[runtime] = input.connectionStatus[match.id] === "connected" ? "ready" : "disconnected"
  }
  return map
}
