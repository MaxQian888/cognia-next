"use client"

/**
 * The app preset catalog, as a subscription (ADR-0117).
 *
 * `appPresetCatalog()` is a snapshot, which is right for the send path and wrong
 * for a picker: the settings sheet computed its catalog with `useMemo(…, [])`,
 * so a mode authored in Settings → Agent while the sheet was mounted never
 * appeared. Reading the two stores through selectors is what makes the picker
 * update when the user creates, edits or deletes a mode, or enables a plugin.
 */

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import { composeAppPresetCatalog } from "@/lib/agent/composition/app-preset-catalog"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import type { AgentPresetDefinitionV1 } from "@cognia/agent-config-types/agent-composition"

export function usePresetCatalog(): AgentPresetDefinitionV1[] {
  const customModes = useCustomModeStore(useShallow((s) => Object.values(s.customModes)))

  // Derived from `plugins` rather than calling `getAllModes()` in the selector:
  // that action builds a fresh array every call, so a selector returning it
  // would never be referentially stable and would re-render on every store
  // touch. `useShallow` over the flattened modes gives the same value with a
  // stable identity. The `status === "enabled"` filter matches
  // `getEnabledPlugins()`, which is what `getAllModes()` uses.
  const pluginModes = usePluginStore(
    useShallow(
      (s) =>
        Object.values(s.plugins)
          .filter((p) => p.status === "enabled")
          .flatMap((p) => p.modes ?? []) as AgentModeConfig[]
    )
  )

  return useMemo(
    () => composeAppPresetCatalog({ customModes, pluginModes }),
    [customModes, pluginModes]
  )
}
