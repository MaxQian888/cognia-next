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
import { getPluginTheme } from "@/lib/theme/theme-registry"
import { createPluginSystemLogger } from "../core/logger"
import { createApiGuardedAPI } from "./api-permission-gate"
import type {
  PluginThemeAPI,
  ThemeMode,
  ColorThemePreset,
  ThemeColors,
  CustomTheme,
  ThemeState,
} from "@/types/plugin/plugin"

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
  const activePluginThemeId = store.activePluginThemeId

  // A directly-activated plugin theme wins — reflect its palette so plugins
  // reading `getColors()` see what's actually painted.
  if (activePluginThemeId) {
    const pluginTheme = getPluginTheme(activePluginThemeId)
    if (pluginTheme?.colors) {
      return {
        mode,
        resolvedMode,
        colorPreset,
        customThemeId: null,
        activePluginThemeId,
        colors: pluginTheme.colors,
        themeSource: "plugin",
      }
    }
  }

  const resolved = resolveActiveThemeColors({
    colorTheme: colorPreset,
    resolvedTheme: resolvedMode,
    activeCustomThemeId: customThemeId,
    customThemes: store.customThemes,
    accentColor: store.accentColor,
  })

  return {
    mode,
    resolvedMode,
    colorPreset,
    customThemeId,
    activePluginThemeId: activePluginThemeId ?? null,
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
    activePluginThemeId: state.activePluginThemeId,
    activeCustomTheme,
  })
}

/**
 * Create the Theme API for a plugin
 */
export function createThemeAPI(pluginId: string): PluginThemeAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginThemeAPI = {
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
      // A plugin may now supply the dual-variant `tokens.{light,dark}` shape
      // (preferred) OR the legacy single `colors` set. We persist whichever
      // was given and always fill a legacy `colors` set so pre-`tokens`
      // readers keep working. The row is stamped with `ownerPluginId` so it
      // can be garbage-collected across restarts when the plugin is disabled.
      const baseVariant: "light" | "dark" = theme.baseVariant ?? (theme.isDark ? "dark" : "light")
      const incoming = theme.tokens?.[baseVariant] ?? theme.colors ?? {}
      const colors = {
        ...incoming,
        primary: incoming.primary || "#3b82f6",
        secondary: incoming.secondary || "#64748b",
        accent: incoming.accent || "#3b82f6",
        background: incoming.background || "#ffffff",
        foreground: incoming.foreground || "#0f172a",
        muted: incoming.muted || "#f1f5f9",
      }
      const seed: Omit<CustomTheme, "id"> = {
        name: theme.name,
        isDark: theme.isDark ?? baseVariant === "dark",
        baseVariant,
        colors,
        ownerPluginId: pluginId,
        ...(theme.tokens ? { tokens: theme.tokens } : {}),
        ...(theme.derivedVariant ? { derivedVariant: theme.derivedVariant } : {}),
        ...(theme.cssVars ? { cssVars: theme.cssVars } : {}),
      }
      const id = store.createCustomTheme(seed)
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
      // Dual-variant fields pass straight through (the store spreads any
      // fields), so plugins can now supply proper light+dark palettes.
      if (updates.baseVariant !== undefined) storeUpdates.baseVariant = updates.baseVariant
      if (updates.derivedVariant !== undefined) storeUpdates.derivedVariant = updates.derivedVariant
      if (updates.tokens !== undefined) storeUpdates.tokens = updates.tokens
      if (updates.cssVars !== undefined) storeUpdates.cssVars = updates.cssVars
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

    activateRegisteredTheme: (themeId: string | null) => {
      const store = useSettingsStore.getState()
      store.setActivePluginTheme(themeId)
      logger.info(`Activated registered plugin theme: ${themeId ?? "<none>"}`)
    },

    onThemeChange: (handler: (theme: ThemeState) => void) => {
      let lastState = createThemeChangeKey()

      const unsubscribe = useSettingsStore.subscribe((state) => {
        const currentState = JSON.stringify({
          mode: state.theme,
          colorTheme: state.colorTheme,
          customThemeId: state.activeCustomThemeId,
          activePluginThemeId: state.activePluginThemeId,
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

  // theme:read is a default grant (initializePluginPermissions), so read
  // methods keep working for undeclared plugins; mutations need theme:write.
  return createApiGuardedAPI(pluginId, api, {
    getTheme: "theme:read",
    getMode: "theme:read",
    getResolvedMode: "theme:read",
    setMode: "theme:write",
    getColorPreset: "theme:read",
    setColorPreset: "theme:write",
    getAvailablePresets: "theme:read",
    getColors: "theme:read",
    registerCustomTheme: "theme:write",
    updateCustomTheme: "theme:write",
    deleteCustomTheme: "theme:write",
    getCustomThemes: "theme:read",
    activateCustomTheme: "theme:write",
    activateRegisteredTheme: "theme:write",
    onThemeChange: "theme:read",
    applyScopedColors: "theme:write",
  })
}

/**
 * Plugin-disable hook — delete every `CustomTheme` row this plugin created
 * through `ctx.theme.registerCustomTheme`. The store's `deleteCustomTheme`
 * already nulls `activeCustomThemeId` when the deleted row was active, so
 * the UI falls back to the default preset automatically. Idempotent: a
 * second call for the same plugin is a no-op.
 */
export function clearCustomThemesForPluginContext(pluginId: string): void {
  const store = useSettingsStore.getState()

  // Persistent GC: rows stamped with `ownerPluginId` survive restarts, so the
  // in-memory `ownedByPlugin` map alone would leak them after a reload. Delete
  // every persisted row this plugin owns, unioned with the in-memory set.
  const persisted = store.customThemes.filter((t) => t.ownerPluginId === pluginId).map((t) => t.id)
  const ids = new Set<string>([...(ownedByPlugin.get(pluginId) ?? []), ...persisted])
  for (const id of ids) {
    store.deleteCustomTheme(id)
  }
  ownedByPlugin.delete(pluginId)

  // If this plugin's directly-activated theme is live, clear it so the UI
  // falls back to the preset instead of holding a dangling registry id.
  const active = store.activePluginThemeId
  if (active && active.startsWith(`${pluginId}.`)) {
    store.setActivePluginTheme(null)
  }
}

/** Test-only. */
export function __resetThemeApiOwnershipForTesting(): void {
  ownedByPlugin.clear()
}
