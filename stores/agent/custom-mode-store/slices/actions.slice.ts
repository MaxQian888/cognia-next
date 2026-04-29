import type { StoreApi } from "zustand"
import { nanoid } from "nanoid"
import { type CustomModeConfig } from "../definitions"
import { analyzeModeDescription } from "../helpers"
import { initialState } from "../initial-state"
import type { CustomModeState } from "../types"

type CustomModeStoreSet = StoreApi<CustomModeState>["setState"]
type CustomModeStoreGet = StoreApi<CustomModeState>["getState"]

type CustomModeActions = Omit<CustomModeState, keyof typeof initialState>

export const createCustomModeActionsSlice = (
  set: CustomModeStoreSet,
  get: CustomModeStoreGet
): CustomModeActions => ({
  // =====================================================================
  // CRUD Actions
  // =====================================================================

  createMode: (mode) => {
    const id = mode.id || `custom-${nanoid()}`
    const now = new Date()

    const newMode: CustomModeConfig = {
      id,
      type: "custom",
      isBuiltIn: false,
      name: mode.name || "New Custom Mode",
      description: mode.description || "",
      icon: mode.icon || "Bot",
      systemPrompt: mode.systemPrompt || "",
      tools: mode.tools || [],
      outputFormat: mode.outputFormat || "text",
      previewEnabled: mode.previewEnabled ?? false,
      customConfig: mode.customConfig || {},
      a2uiEnabled: mode.a2uiEnabled ?? false,
      a2uiTemplate: mode.a2uiTemplate,
      modelOverride: mode.modelOverride,
      temperatureOverride: mode.temperatureOverride,
      maxTokensOverride: mode.maxTokensOverride,
      mcpTools: mode.mcpTools || [],
      category: mode.category || "other",
      tags: mode.tags || [],
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    set((state) => ({
      customModes: { ...state.customModes, [id]: newMode },
    }))

    return newMode
  },

  updateMode: (id, updates) => {
    set((state) => {
      const mode = state.customModes[id]
      if (!mode) return state

      return {
        customModes: {
          ...state.customModes,
          [id]: {
            ...mode,
            ...updates,
            updatedAt: new Date(),
          },
        },
      }
    })
  },

  deleteMode: (id) => {
    set((state) => {
      const { [id]: _removed, ...rest } = state.customModes
      return {
        customModes: rest,
        activeModeId: state.activeModeId === id ? null : state.activeModeId,
      }
    })
  },

  duplicateMode: (id) => {
    const mode = get().customModes[id]
    if (!mode) return null

    const duplicated = get().createMode({
      ...mode,
      id: undefined, // Generate new ID
      name: `${mode.name} (Copy)`,
      usageCount: 0,
      lastUsedAt: undefined,
    })

    return duplicated
  },

  // =====================================================================
  // Selection Actions
  // =====================================================================

  setActiveMode: (id) => {
    set({ activeModeId: id })
  },

  // =====================================================================
  // Query Actions
  // =====================================================================

  getMode: (id) => {
    return get().customModes[id]
  },

  getModesByCategory: (category) => {
    return Object.values(get().customModes).filter((mode) => mode.category === category)
  },

  getModesByTags: (tags) => {
    return Object.values(get().customModes).filter((mode) =>
      tags.some((tag) => mode.tags?.includes(tag))
    )
  },

  searchModes: (query) => {
    const lowerQuery = query.toLowerCase()
    return Object.values(get().customModes).filter(
      (mode) =>
        mode.name.toLowerCase().includes(lowerQuery) ||
        mode.description.toLowerCase().includes(lowerQuery) ||
        mode.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))
    )
  },

  getRecentModes: (limit = 5) => {
    return Object.values(get().customModes)
      .filter((mode) => mode.lastUsedAt)
      .sort((a, b) => {
        const aTime = a.lastUsedAt?.getTime() || 0
        const bTime = b.lastUsedAt?.getTime() || 0
        return bTime - aTime
      })
      .slice(0, limit)
  },

  getMostUsedModes: (limit = 5) => {
    return Object.values(get().customModes)
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
      .slice(0, limit)
  },

  // =====================================================================
  // Usage Tracking
  // =====================================================================

  recordModeUsage: (id) => {
    set((state) => {
      const mode = state.customModes[id]
      if (!mode) return state

      return {
        customModes: {
          ...state.customModes,
          [id]: {
            ...mode,
            usageCount: (mode.usageCount || 0) + 1,
            lastUsedAt: new Date(),
          },
        },
      }
    })
  },

  // =====================================================================
  // A2UI Templates
  // =====================================================================

  setModeA2UITemplate: (id, template) => {
    set((state) => {
      const mode = state.customModes[id]
      if (!mode) return state

      return {
        customModes: {
          ...state.customModes,
          [id]: {
            ...mode,
            a2uiTemplate: template,
            a2uiEnabled: !!template,
            updatedAt: new Date(),
          },
        },
      }
    })
  },

  // =====================================================================
  // Import/Export
  // =====================================================================

  exportMode: (id) => {
    const mode = get().customModes[id]
    if (!mode) return null

    const exportData = {
      version: "1.0",
      type: "custom-mode",
      mode: {
        ...mode,
        // Reset usage stats for export
        usageCount: 0,
        lastUsedAt: undefined,
      },
    }

    return JSON.stringify(exportData, null, 2)
  },

  importMode: (json) => {
    try {
      const data = JSON.parse(json)
      if (data.type !== "custom-mode" || !data.mode) {
        throw new Error("Invalid mode export format")
      }

      const imported = get().createMode({
        ...data.mode,
        id: undefined, // Generate new ID
        isShared: true,
        sharedBy: data.mode.name,
      })

      return imported
    } catch {
      return null
    }
  },

  exportAllModes: () => {
    const modes = Object.values(get().customModes).map((mode) => ({
      ...mode,
      usageCount: 0,
      lastUsedAt: undefined,
    }))

    const exportData = {
      version: "1.0",
      type: "custom-modes-collection",
      modes,
      exportedAt: new Date().toISOString(),
    }

    return JSON.stringify(exportData, null, 2)
  },

  importModes: (json) => {
    try {
      const data = JSON.parse(json)
      if (data.type !== "custom-modes-collection" || !Array.isArray(data.modes)) {
        throw new Error("Invalid modes collection format")
      }

      let imported = 0
      for (const mode of data.modes) {
        get().createMode({
          ...mode,
          id: undefined,
          isShared: true,
        })
        imported++
      }

      return imported
    } catch {
      return 0
    }
  },

  // =====================================================================
  // Mode Generation from Natural Language
  // =====================================================================

  generateModeFromDescription: async (request) => {
    set({ isGenerating: true, generationError: null })

    try {
      // Analyze description for patterns
      const result = analyzeModeDescription(request)

      set({ isGenerating: false })
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Generation failed"
      set({ isGenerating: false, generationError: errorMessage })
      throw error
    }
  },

  setGenerationError: (error) => {
    set({ generationError: error })
  },

  // =====================================================================
  // Reset
  // =====================================================================

  reset: () => {
    set(initialState)
  },
})
