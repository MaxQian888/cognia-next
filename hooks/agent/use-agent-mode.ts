/**
 * useAgentMode - Unified hook for accessing agent modes (built-in + custom + plugin)
 * Provides a single interface for mode selection, configuration, and management
 */

import { useMemo, useCallback } from "react"
import { BUILT_IN_AGENT_MODES, type AgentModeConfig } from "@/types/agent/agent-mode"
import { useCustomModeStore, type CustomModeConfig } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

// =============================================================================
// Types
// =============================================================================

export type UnifiedAgentMode = AgentModeConfig | CustomModeConfig

export interface UseAgentModeOptions {
  includeBuiltIn?: boolean
  includeCustom?: boolean
  includePlugin?: boolean
}

export interface UseAgentModeResult {
  // All available modes
  allModes: UnifiedAgentMode[]
  builtInModes: AgentModeConfig[]
  customModes: CustomModeConfig[]
  pluginModes: AgentModeConfig[]

  // Mode retrieval
  getModeById: (id: string) => UnifiedAgentMode | undefined
  getModesByType: (type: "built-in" | "custom" | "plugin") => UnifiedAgentMode[]

  // Custom mode actions
  createCustomMode: (mode: Partial<CustomModeConfig>) => CustomModeConfig
  updateCustomMode: (id: string, updates: Partial<CustomModeConfig>) => void
  deleteCustomMode: (id: string) => void
  duplicateCustomMode: (id: string) => CustomModeConfig | null

  // Usage tracking
  recordUsage: (id: string) => void

  // Utilities
  isCustomMode: (id: string) => boolean
  isBuiltInMode: (id: string) => boolean
  isPluginMode: (id: string) => boolean

  // Mode configuration helpers
  getModeSystemPrompt: (id: string) => string
  getModeTools: (id: string) => string[]
  getModeOutputFormat: (id: string) => "text" | "code" | "html" | "react" | "markdown"
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAgentMode(options: UseAgentModeOptions = {}): UseAgentModeResult {
  const { includeBuiltIn = true, includeCustom = true, includePlugin = true } = options

  // Custom modes from store
  const customModesMap = useCustomModeStore((state) => state.customModes)
  const createMode = useCustomModeStore((state) => state.createMode)
  const updateMode = useCustomModeStore((state) => state.updateMode)
  const deleteMode = useCustomModeStore((state) => state.deleteMode)
  const duplicateMode = useCustomModeStore((state) => state.duplicateMode)
  const recordModeUsage = useCustomModeStore((state) => state.recordModeUsage)

  // Plugin modes from store
  const getAllPluginModes = usePluginStore((state) => state.getAllModes)

  // Convert custom modes map to array
  const customModes = useMemo(() => Object.values(customModesMap), [customModesMap])

  // Get plugin modes
  const pluginModes = useMemo(() => {
    if (!includePlugin) return []
    return getAllPluginModes()
  }, [includePlugin, getAllPluginModes])

  // Built-in modes
  const builtInModes = useMemo(() => (includeBuiltIn ? BUILT_IN_AGENT_MODES : []), [includeBuiltIn])

  // All modes combined
  const allModes = useMemo(() => {
    const modes: UnifiedAgentMode[] = []

    if (includeBuiltIn) {
      modes.push(...BUILT_IN_AGENT_MODES)
    }

    if (includeCustom) {
      modes.push(...customModes)
    }

    if (includePlugin) {
      modes.push(...pluginModes)
    }

    return modes
  }, [includeBuiltIn, includeCustom, includePlugin, customModes, pluginModes])

  // Get mode by ID
  const getModeById = useCallback(
    (id: string): UnifiedAgentMode | undefined => {
      // Check built-in first
      const builtIn = BUILT_IN_AGENT_MODES.find((m) => m.id === id)
      if (builtIn) return builtIn

      // Check custom modes
      const custom = customModesMap[id]
      if (custom) return custom

      // Check plugin modes
      const plugin = pluginModes.find((m) => m.id === id)
      if (plugin) return plugin

      return undefined
    },
    [customModesMap, pluginModes]
  )

  // Get modes by type
  const getModesByType = useCallback(
    (type: "built-in" | "custom" | "plugin"): UnifiedAgentMode[] => {
      switch (type) {
        case "built-in":
          return BUILT_IN_AGENT_MODES
        case "custom":
          return customModes
        case "plugin":
          return pluginModes
        default:
          return []
      }
    },
    [customModes, pluginModes]
  )

  // Check mode types
  const isBuiltInMode = useCallback((id: string): boolean => {
    return BUILT_IN_AGENT_MODES.some((m) => m.id === id)
  }, [])

  const isCustomMode = useCallback(
    (id: string): boolean => {
      return id in customModesMap
    },
    [customModesMap]
  )

  const isPluginMode = useCallback(
    (id: string): boolean => {
      return pluginModes.some((m) => m.id === id)
    },
    [pluginModes]
  )

  // Record usage (only for custom modes)
  const recordUsage = useCallback(
    (id: string) => {
      if (id in customModesMap) {
        recordModeUsage(id)
      }
    },
    [customModesMap, recordModeUsage]
  )

  // Get mode system prompt
  const getModeSystemPrompt = useCallback(
    (id: string): string => {
      const mode = getModeById(id)
      return mode?.systemPrompt || ""
    },
    [getModeById]
  )

  // Get mode tools
  const getModeTools = useCallback(
    (id: string): string[] => {
      const mode = getModeById(id)
      return mode?.tools || []
    },
    [getModeById]
  )

  // Get mode output format
  const getModeOutputFormat = useCallback(
    (id: string): "text" | "code" | "html" | "react" | "markdown" => {
      const mode = getModeById(id)
      return mode?.outputFormat || "text"
    },
    [getModeById]
  )

  return {
    allModes,
    builtInModes,
    customModes,
    pluginModes,
    getModeById,
    getModesByType,
    createCustomMode: createMode,
    updateCustomMode: updateMode,
    deleteCustomMode: deleteMode,
    duplicateCustomMode: duplicateMode,
    recordUsage,
    isCustomMode,
    isBuiltInMode,
    isPluginMode,
    getModeSystemPrompt,
    getModeTools,
    getModeOutputFormat,
  }
}

export default useAgentMode
