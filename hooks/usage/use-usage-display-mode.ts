"use client"

/**
 * Usage / consumption statistics display mode (simplified / standard / detailed).
 *
 * Single source of truth is the global appearance preference
 * `AppSettings.usageDisplayMode`, persisted via the settings store's generic
 * `save()` (the established v47 convention — no dedicated setter). Both entry
 * points — the usage-toolbar quick toggle and the appearance settings card —
 * drive the same value, so switching from either place applies everywhere the
 * usage surfaces are shown.
 *
 * Reading is a cheap Zustand selector; the surfaces already subscribe to the
 * settings store, so no extra context/provider is needed. When no preference is
 * stored (or in tests with null settings) it resolves to `standard`, preserving
 * the current full-dashboard rendering.
 *
 * Mirrors `hooks/chat/use-agent-flow-mode.ts` exactly for consistency.
 */

import { useCallback } from "react"

import { useSettingsStore } from "@/stores/settings"
import {
  type UsageDisplayMode,
  DEFAULT_USAGE_DISPLAY,
  isUsageDisplayMode,
} from "@/types/appearance"

/** Pure resolver — exported for unit tests. */
export function resolveUsageDisplayMode(value: unknown): UsageDisplayMode {
  return isUsageDisplayMode(value) ? value : DEFAULT_USAGE_DISPLAY.mode
}

export interface UseUsageDisplayMode {
  mode: UsageDisplayMode
  setMode: (mode: UsageDisplayMode) => void
}

export function useUsageDisplayMode(): UseUsageDisplayMode {
  const stored = useSettingsStore((s) => s.settings?.usageDisplayMode?.mode)
  const save = useSettingsStore((s) => s.save)
  const mode = resolveUsageDisplayMode(stored)

  const setMode = useCallback(
    (next: UsageDisplayMode) => {
      void save({ usageDisplayMode: { mode: next } })
    },
    [save]
  )

  return { mode, setMode }
}
