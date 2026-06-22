/**
 * Plugin Theme API Implementation
 *
 * Provides theme customization capabilities to plugins. Custom themes are
 * tracked per owning plugin (mirroring the chat-api `ownedByPlugin` pattern)
 * so `clearCustomThemesForPluginContext` can garbage-collect orphan rows when
 * a plugin is disabled — otherwise plugin-injected `CustomTheme` rows linger
 * in Dexie indefinitely (ADR-0007 follow-up).
 */

import { useSettingsStore } from "@/stores/settings/settings-store"
import { resolveActiveThemeColors } from "@/lib/themes"
import { createPluginSystemLogger } from "../core/logger"
import type {
  PluginThemeAPI,
  ThemeMode,
  ColorThemePreset,
  ThemeColors,
  CustomTheme,
  ThemeState,
} from "@/types/plugin/plugin-extended"

/**
 * Per-plugin ownership of `CustomTheme` row ids created through the API. The
 * tracking lives only in memory for the current session — cross-restart
 * cleanup is deferred to ADR follow-up (would require a `ownerPluginId`
 * column on the Dexie `customThemes` table).
 */
const ownedByPlugin = new Map<string, Set<string>>()

/**
 * Get resolved theme mode (handles 'system' -> 'light' | 'dark')
 */
function getResolvedMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    }
    return "light"
  }
  return mode
}

function getThemeState(): ThemeState {
  const store = useSettingsStore.getState()
  const mode = store.theme
  const resolvedMode = getResolvedMode(mode)
  const colorPreset = store.colorTheme
  const customThemeId = store.activeCustomThemeId
  const resolved = resolveActiveThemeColors({
    colorTheme: colorPreset,
    resolvedTheme: resolvedMode,
    activeCustomThemeId: customThemeId,
    customThemes: store.customThemes,
  })

  return {
    mode,
    resolvedMode,
    colorPreset,
    customThemeId,
    colors: resolved.colors as ThemeColors,
    themeSource: resolved.themeSource,
  }
}

function createThemeChangeKey(): string {
  const state = useSettingsStore.getState()
  const activeCustomTheme = state.activeCustomThemeId
    ? state.customThemes.find((theme) => theme.id === state.activeCustomThemeId)
    : null

  return JSON.stringify({
    mode: state.theme,
    colorTheme: state.colorTheme,
    customThemeId: state.activeCustomThemeId,
    activeCustomTheme,
  })
}

/**
 * Create the Theme API for a plugin
 */
export function createThemeAPI(pluginId: string): PluginThemeAPI {
  const logger = createPluginSystemLogger(pluginId)
  return {
    getTheme: (): ThemeState => getThemeState(),

    getMode: () => {
      return useSettingsStore.getState().theme
    },

    getResolvedMode: () => {
      const mode = useSettingsStore.getState().theme
      return getResolvedMode(mode)
    },

    setMode: (mode: ThemeMode) => {
      useSettingsStore.getState().setTheme(mode)
      logger.info(`Set theme mode: ${mode}`)
    },

    getColorPreset: () => {
      return useSettingsStore.getState().colorTheme
    },

    setColorPreset: (preset: ColorThemePreset) => {
      useSettingsStore.getState().setColorTheme(preset)
      logger.info(`Set color preset: ${preset}`)
    },

    getAvailablePresets: (): ColorThemePreset[] => {
      return ["default", "ocean", "forest", "sunset", "lavender", "rose", "slate", "amber"]
    },

    getColors: (): ThemeColors => {
      return getThemeState().colors
    },

    registerCustomTheme: (theme: Omit<CustomTheme, "id">): string => {
      const store = useSettingsStore.getState()
      // Ensure required color fields are present.
      // Phase 2: `colors` is optional on CustomTheme — coerce to {} when
      // a plugin omits it. The new `tokens` shape is preferred at read
      // time but we keep the legacy single-set write path here until
      // Task 9 migrates plugin authors to the dual-variant shape.
      const incoming = theme.colors ?? {}
      const themeWithDefaults = {
        name: theme.name,
        isDark: theme.isDark ?? false,
        colors: {
          ...incoming,
          primary: incoming.primary || "#3b82f6",
          secondary: incoming.secondary || "#64748b",
          accent: incoming.accent || "#3b82f6",
          background: incoming.background || "#ffffff",
          foreground: incoming.foreground || "#0f172a",
          muted: incoming.muted || "#f1f5f9",
        },
      }
      const id = store.createCustomTheme(themeWithDefaults)
      const owned = ownedByPlugin.get(pluginId) ?? new Set<string>()
      owned.add(id)
      ownedByPlugin.set(pluginId, owned)
      logger.info(`Registered custom theme: ${theme.name} (${id})`)
      return id
    },

    updateCustomTheme: (id: string, updates: Partial<CustomTheme>) => {
      const store = useSettingsStore.getState()
      // Convert to store format
      const storeUpdates: Record<string, unknown> = {}
      if (updates.name) storeUpdates.name = updates.name
      if (updates.isDark !== undefined) storeUpdates.isDark = updates.isDark
      if (updates.colors) {
        const existing = store.customThemes.find((theme) => theme.id === id)
        const existingColors = existing?.colors ?? {}
        storeUpdates.colors = {
          ...existingColors,
          ...updates.colors,
          primary: updates.colors.primary || existingColors.primary || "#3b82f6",
          secondary: updates.colors.secondary || existingColors.secondary || "#64748b",
          accent: updates.colors.accent || existingColors.accent || "#3b82f6",
          background: updates.colors.background || existingColors.background || "#ffffff",
          foreground: updates.colors.foreground || existingColors.foreground || "#0f172a",
          muted: updates.colors.muted || existingColors.muted || "#f1f5f9",
        }
      }
      store.updateCustomTheme(id, storeUpdates)
      logger.info(`Updated custom theme: ${id}`)
    },

    deleteCustomTheme: (id: string) => {
      const store = useSettingsStore.getState()
      store.deleteCustomTheme(id)
      const owned = ownedByPlugin.get(pluginId)
      if (owned) {
        owned.delete(id)
        if (owned.size === 0) ownedByPlugin.delete(pluginId)
      }
      logger.info(`Deleted custom theme: ${id}`)
    },

    getCustomThemes: (): CustomTheme[] => {
      return useSettingsStore.getState().customThemes
    },

    activateCustomTheme: (id: string) => {
      const store = useSettingsStore.getState()
      store.setActiveCustomTheme(id)
      logger.info(`Activated custom theme: ${id}`)
    },

    onThemeChange: (handler: (theme: ThemeState) => void) => {
      let lastState = createThemeChangeKey()

      const unsubscribe = useSettingsStore.subscribe((state) => {
        const currentState = JSON.stringify({
          mode: state.theme,
          colorTheme: state.colorTheme,
          customThemeId: state.activeCustomThemeId,
          activeCustomTheme: state.activeCustomThemeId
            ? state.customThemes.find((theme) => theme.id === state.activeCustomThemeId)
            : null,
        })

        if (currentState !== lastState) {
          lastState = currentState
          handler(getThemeState())
        }
      })

      return unsubscribe
    },

    applyScopedColors: (element: HTMLElement, colors: Partial<ThemeColors>) => {
      const originalStyles: Record<string, string> = {}

      Object.entries(colors).forEach(([key, value]) => {
        if (value) {
          const cssVarName = `--${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`
          originalStyles[cssVarName] = element.style.getPropertyValue(cssVarName)
          element.style.setProperty(cssVarName, value)
        }
      })

      // Return cleanup function
      return () => {
        Object.entries(originalStyles).forEach(([cssVarName, value]) => {
          if (value) {
            element.style.setProperty(cssVarName, value)
          } else {
            element.style.removeProperty(cssVarName)
          }
        })
      }
    },
  }
}

/**
 * Plugin-disable hook — delete every `CustomTheme` row this plugin created
 * through `ctx.theme.registerCustomTheme`. The store's `deleteCustomTheme`
 * already nulls `activeCustomThemeId` when the deleted row was active, so
 * the UI falls back to the default preset automatically. Idempotent: a
 * second call for the same plugin is a no-op.
 */
export function clearCustomThemesForPluginContext(pluginId: string): void {
  const owned = ownedByPlugin.get(pluginId)
  if (!owned) return
  const store = useSettingsStore.getState()
  for (const id of owned) {
    store.deleteCustomTheme(id)
  }
  ownedByPlugin.delete(pluginId)
}

/** Test-only. */
export function __resetThemeApiOwnershipForTesting(): void {
  ownedByPlugin.clear()
}
