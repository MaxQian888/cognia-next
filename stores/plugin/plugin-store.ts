/**
 * Plugin Store - Zustand store for managing plugin state
 */

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
import { invoke } from "@tauri-apps/api/core"
import type {
  ExtensionCompatibilityDiagnostic,
  ExtensionDescriptor,
  PluginInstallRootKind,
  Plugin,
  PluginManifest,
  PluginStatus,
  PluginSource,
  PluginStoreState,
  PluginPermission,
  PluginPermissionDecision,
  PluginPermissionPolicy,
  PluginTool,
  PluginA2UIComponent,
  PluginCommand,
  PluginHooks,
  PluginSystemEvent,
  PluginVerificationSnapshot,
  PluginReview,
} from "@/types/plugin"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import { validatePluginManifest } from "@/lib/plugin"
import { buildExtensionDescriptor } from "@/lib/plugin/core/descriptor"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { loggers } from "@/lib/logger"
import { resolvePluginIcon } from "@/lib/plugin/icon"

const log = loggers.plugin

// =============================================================================
// Store State Interface
// =============================================================================

interface PluginState extends PluginStoreState {
  // Actions - Plugin Lifecycle
  discoverPlugin: (
    manifest: PluginManifest,
    source: PluginSource,
    path: string,
    options?: PluginDiscoveryOptions
  ) => void
  installPlugin: (pluginId: string) => Promise<void>
  loadPlugin: (pluginId: string, options?: PluginLifecycleActionOptions) => Promise<void>
  enablePlugin: (pluginId: string, options?: PluginLifecycleActionOptions) => Promise<void>
  disablePlugin: (pluginId: string, options?: PluginLifecycleActionOptions) => Promise<void>
  unloadPlugin: (pluginId: string, options?: PluginLifecycleActionOptions) => Promise<void>
  uninstallPlugin: (pluginId: string, options?: PluginUninstallOptions) => Promise<void>

  // Actions - Plugin State
  setPluginStatus: (pluginId: string, status: PluginStatus) => void
  setPluginError: (pluginId: string, error: string | null) => void
  setPluginVerificationSnapshot: (pluginId: string, snapshot: PluginVerificationSnapshot) => void
  setPluginConfig: (pluginId: string, config: Record<string, unknown>) => void
  updatePluginConfig: (pluginId: string, updates: Record<string, unknown>) => void
  updateLastUsedAt: (pluginId: string) => void
  updatePluginSettings: (updates: Partial<PluginStoreState["pluginSettings"]>) => void
  setPluginDirectory: (pluginDirectory: string) => void
  setGlobalPermissionPolicy: (policy: PluginPermissionPolicy) => void
  setGroupPermissionPolicy: (
    group: keyof PluginStoreState["groupPermissionPolicies"],
    policy: PluginPermissionPolicy
  ) => void
  setRememberedPermissionDecision: (
    pluginId: string,
    permission: PluginPermission,
    decision: PluginPermissionDecision
  ) => void
  clearRememberedPermissionDecision: (pluginId: string, permission: PluginPermission) => void
  addReview: (pluginId: string, review: PluginReview) => void
  getReviews: (pluginId: string) => PluginReview[]

  // Actions - Plugin Registration
  registerPluginHooks: (pluginId: string, hooks: PluginHooks) => void
  registerPluginTool: (pluginId: string, tool: PluginTool) => void
  unregisterPluginTool: (pluginId: string, toolName: string) => void
  registerPluginComponent: (pluginId: string, component: PluginA2UIComponent) => void
  unregisterPluginComponent: (pluginId: string, componentType: string) => void
  registerPluginMode: (pluginId: string, mode: AgentModeConfig) => void
  unregisterPluginMode: (pluginId: string, modeId: string) => void
  registerPluginCommand: (pluginId: string, command: PluginCommand) => void
  unregisterPluginCommand: (pluginId: string, commandId: string) => void

  // Actions - System
  initialize: (pluginDirectory: string) => Promise<void>
  scanPlugins: () => Promise<void>
  getPlugin: (pluginId: string) => Plugin | undefined
  getEnabledPlugins: () => Plugin[]
  getPluginsByCapability: (capability: string) => Plugin[]
  getAllTools: () => PluginTool[]
  getAllComponents: () => PluginA2UIComponent[]
  getAllModes: () => AgentModeConfig[]
  getAllCommands: () => PluginCommand[]

  // Events
  eventListeners: Map<string, Set<(event: PluginSystemEvent) => void>>
  addEventListener: (type: string, listener: (event: PluginSystemEvent) => void) => () => void
  emitEvent: (event: PluginSystemEvent) => void

  // Reset
  reset: () => void
}

interface PluginLifecycleActionOptions {
  viaManager?: boolean
}

interface PluginUninstallOptions extends PluginLifecycleActionOptions {
  skipFileRemoval?: boolean
}

interface PluginDiscoveryOptions {
  descriptor?: ExtensionDescriptor
  installRootKind?: PluginInstallRootKind
  compatibilityDiagnostics?: ExtensionCompatibilityDiagnostic[]
}

// =============================================================================
// Initial State
// =============================================================================

const initialState: PluginStoreState & {
  eventListeners: Map<string, Set<(event: PluginSystemEvent) => void>>
} = {
  plugins: {},
  loadOrder: [],
  loading: new Set(),
  errors: {},
  initialized: false,
  pluginDirectory: "",
  pluginSettings: {
    autoScanEnabled: false,
    conflictDetectionEnabled: true,
    notificationsEnabled: true,
    developerModeEnabled: false,
  },
  rememberedPermissions: {},
  globalPermissionPolicy: "ask",
  groupPermissionPolicies: {},
  reviews: {},
  eventListeners: new Map(),
}

function mergeObservedSources(existing: Plugin | undefined, source: PluginSource): PluginSource[] {
  const seen = new Set<PluginSource>()
  const merged: PluginSource[] = []

  for (const entry of existing?.descriptor?.identity.observedSources || []) {
    if (seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }

  if (existing && !seen.has(existing.source)) {
    seen.add(existing.source)
    merged.push(existing.source)
  }

  if (!seen.has(source)) {
    seen.add(source)
    merged.push(source)
  }

  return merged
}

function withSourceTransitionDiagnostics(
  existing: Plugin | undefined,
  source: PluginSource,
  diagnostics: ExtensionCompatibilityDiagnostic[] = []
): ExtensionCompatibilityDiagnostic[] {
  const nextDiagnostics = [...diagnostics]
  if (!existing || existing.source === source) {
    return nextDiagnostics
  }

  nextDiagnostics.push({
    code: "descriptor.source.transition",
    severity: "warning",
    message: `Plugin source switched from ${existing.source} to ${source}.`,
    hint: "Lifecycle continuity is preserved under canonical plugin identity.",
  })
  return nextDiagnostics
}

async function resolveVerifiedPluginManager(action: string) {
  try {
    const { getPluginManager } = await import("@/lib/plugin/core/manager")
    return getPluginManager()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Verified plugin lifecycle action requires an initialized PluginManager for ${action}: ${message}`
    )
  }
}

// =============================================================================
// Store Implementation
// =============================================================================

export const usePluginStore = create<PluginState>()(
  persist(
    (set, get) => ({
      ...initialState,

      // =====================================================================
      // Plugin Lifecycle Actions
      // =====================================================================

      discoverPlugin: (manifest, source, path, options) => {
        const existing = get().plugins[manifest.id]
        const observedSources = mergeObservedSources(existing, source)
        const mergedDiagnostics = withSourceTransitionDiagnostics(
          existing,
          source,
          options?.compatibilityDiagnostics
        )
        const descriptor =
          options?.descriptor ||
          buildExtensionDescriptor({
            manifest,
            source,
            path,
            pluginDirectory: get().pluginDirectory || undefined,
            installRootKind: options?.installRootKind,
            observedSources,
            compatibilityDiagnostics: mergedDiagnostics,
          })
        const plugin: Plugin = {
          ...existing,
          manifest,
          status: existing?.status || "discovered",
          source,
          path,
          descriptor,
          resolvedIcon: resolvePluginIcon({ icon: manifest.icon, pluginRoot: path }),
          config: existing?.config || manifest.defaultConfig || {},
        }

        set((state) => ({
          plugins: { ...state.plugins, [manifest.id]: plugin },
        }))

        get().emitEvent({ type: "plugin:discovered", pluginId: manifest.id, manifest })
      },

      installPlugin: async (pluginId) => {
        const plugin = get().plugins[pluginId]
        if (!plugin) {
          throw new Error(`Plugin not found: ${pluginId}`)
        }

        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...plugin, status: "installed", installedAt: new Date() },
          },
        }))

        get().emitEvent({ type: "plugin:installed", pluginId })
      },

      loadPlugin: async (pluginId, options) => {
        if (options?.viaManager !== false) {
          const manager = await resolveVerifiedPluginManager("load")
          await manager.loadPlugin(pluginId)
          return
        }

        const plugin = get().plugins[pluginId]
        if (!plugin) {
          throw new Error(`Plugin not found: ${pluginId}`)
        }

        if (plugin.status !== "installed" && plugin.status !== "disabled") {
          throw new Error(`Plugin ${pluginId} cannot be loaded from status: ${plugin.status}`)
        }

        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...plugin, status: "loading" },
          },
          loading: new Set([...state.loading, pluginId]),
        }))

        try {
          // Load plugin module - this will be handled by the plugin manager
          // For now, just update status
          set((state) => {
            const newLoading = new Set(state.loading)
            newLoading.delete(pluginId)
            return {
              plugins: {
                ...state.plugins,
                [pluginId]: { ...state.plugins[pluginId], status: "loaded" },
              },
              loading: newLoading,
              loadOrder: [...state.loadOrder.filter((id) => id !== pluginId), pluginId],
            }
          })

          get().emitEvent({ type: "plugin:loaded", pluginId })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          set((state) => {
            const newLoading = new Set(state.loading)
            newLoading.delete(pluginId)
            return {
              plugins: {
                ...state.plugins,
                [pluginId]: { ...state.plugins[pluginId], status: "error", error: errorMessage },
              },
              loading: newLoading,
              errors: { ...state.errors, [pluginId]: errorMessage },
            }
          })

          get().emitEvent({ type: "plugin:error", pluginId, error: errorMessage })
          throw error
        }
      },

      enablePlugin: async (pluginId, options) => {
        if (options?.viaManager !== false) {
          const manager = await resolveVerifiedPluginManager("enable")
          await manager.enablePlugin(pluginId, "store")
          return
        }

        const plugin = get().plugins[pluginId]
        if (!plugin) {
          throw new Error(`Plugin not found: ${pluginId}`)
        }

        if (plugin.status !== "loaded" && plugin.status !== "disabled") {
          throw new Error(`Plugin ${pluginId} cannot be enabled from status: ${plugin.status}`)
        }

        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...plugin, status: "enabling" },
          },
        }))

        try {
          const rememberedPermissions = get().rememberedPermissions[pluginId] || {}
          const permissionGuard = getPermissionGuard()
          for (const [permission, decision] of Object.entries(rememberedPermissions)) {
            if (decision === "allow") {
              permissionGuard.grant(pluginId, permission as PluginPermission, { grantedBy: "user" })
              await invoke("plugin_permission_grant", {
                request: { pluginId, permission },
              }).catch(() => undefined)
            }
          }

          set((state) => ({
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...state.plugins[pluginId],
                status: "enabled",
                enabledAt: new Date(),
                lastUsedAt: Date.now(),
              },
            },
          }))

          get().emitEvent({ type: "plugin:enabled", pluginId })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          set((state) => ({
            plugins: {
              ...state.plugins,
              [pluginId]: { ...state.plugins[pluginId], status: "error", error: errorMessage },
            },
            errors: { ...state.errors, [pluginId]: errorMessage },
          }))

          get().emitEvent({ type: "plugin:error", pluginId, error: errorMessage })
          throw error
        }
      },

      disablePlugin: async (pluginId, options) => {
        if (options?.viaManager !== false) {
          const manager = await resolveVerifiedPluginManager("disable")
          await manager.disablePlugin(pluginId, "store")
          return
        }

        const plugin = get().plugins[pluginId]
        if (!plugin) {
          throw new Error(`Plugin not found: ${pluginId}`)
        }

        if (plugin.status !== "enabled") {
          throw new Error(`Plugin ${pluginId} cannot be disabled from status: ${plugin.status}`)
        }

        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...plugin, status: "disabling" },
          },
        }))

        try {
          set((state) => ({
            plugins: {
              ...state.plugins,
              [pluginId]: { ...state.plugins[pluginId], status: "disabled" },
            },
          }))

          get().emitEvent({ type: "plugin:disabled", pluginId })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          set((state) => ({
            plugins: {
              ...state.plugins,
              [pluginId]: { ...state.plugins[pluginId], status: "error", error: errorMessage },
            },
            errors: { ...state.errors, [pluginId]: errorMessage },
          }))

          get().emitEvent({ type: "plugin:error", pluginId, error: errorMessage })
          throw error
        }
      },

      unloadPlugin: async (pluginId, options) => {
        if (options?.viaManager !== false) {
          const manager = await resolveVerifiedPluginManager("unload")
          await manager.unloadPlugin(pluginId)
          return
        }

        const plugin = get().plugins[pluginId]
        if (!plugin) {
          throw new Error(`Plugin not found: ${pluginId}`)
        }

        // Must disable first if enabled
        if (plugin.status === "enabled") {
          await get().disablePlugin(pluginId, { viaManager: false })
        }

        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...state.plugins[pluginId], status: "unloading" },
          },
        }))

        try {
          set((state) => ({
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...state.plugins[pluginId],
                status: "installed",
                hooks: undefined,
                tools: undefined,
                components: undefined,
                modes: undefined,
                commands: undefined,
              },
            },
            loadOrder: state.loadOrder.filter((id) => id !== pluginId),
          }))

          get().emitEvent({ type: "plugin:unloaded", pluginId })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          set((state) => ({
            plugins: {
              ...state.plugins,
              [pluginId]: { ...state.plugins[pluginId], status: "error", error: errorMessage },
            },
            errors: { ...state.errors, [pluginId]: errorMessage },
          }))

          get().emitEvent({ type: "plugin:error", pluginId, error: errorMessage })
          throw error
        }
      },

      uninstallPlugin: async (pluginId, options) => {
        if (options?.viaManager !== false) {
          const manager = await resolveVerifiedPluginManager("uninstall")
          await manager.uninstallPlugin(pluginId)
          return
        }

        const plugin = get().plugins[pluginId]
        if (!plugin) {
          throw new Error(`Plugin not found: ${pluginId}`)
        }

        // Unload first if loaded
        if (["loaded", "enabled", "disabled"].includes(plugin.status)) {
          await get().unloadPlugin(pluginId, { viaManager: false })
        }

        if (!options?.skipFileRemoval) {
          try {
            await invoke("plugin_uninstall", {
              pluginId,
              pluginPath: plugin.path,
            })
          } catch (error) {
            throw new Error(
              `Failed to uninstall plugin files: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }

        set((state) => {
          const { [pluginId]: _, ...remainingPlugins } = state.plugins
          const { [pluginId]: __, ...remainingErrors } = state.errors
          return {
            plugins: remainingPlugins,
            errors: remainingErrors,
            loadOrder: state.loadOrder.filter((id) => id !== pluginId),
          }
        })

        get().emitEvent({ type: "plugin:uninstalled", pluginId })
      },

      // =====================================================================
      // Plugin State Actions
      // =====================================================================

      setPluginStatus: (pluginId, status) => {
        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...state.plugins[pluginId], status },
          },
        }))
      },

      setPluginError: (pluginId, error) => {
        set((state) => {
          if (error === null) {
            const { [pluginId]: _, ...remainingErrors } = state.errors
            return {
              plugins: {
                ...state.plugins,
                [pluginId]: { ...state.plugins[pluginId], error: undefined },
              },
              errors: remainingErrors,
            }
          }
          return {
            plugins: {
              ...state.plugins,
              [pluginId]: { ...state.plugins[pluginId], status: "error", error },
            },
            errors: { ...state.errors, [pluginId]: error },
          }
        })
      },

      setPluginVerificationSnapshot: (pluginId, snapshot) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin) return state

          const isSuccessfulSnapshot =
            snapshot.lastFailureAt === undefined ||
            snapshot.lastSuccessfulAt === snapshot.lastVerifiedAt

          const nextPlugin: Plugin = {
            ...plugin,
            verificationSnapshot: snapshot,
            lastKnownGoodVerification: isSuccessfulSnapshot
              ? snapshot
              : plugin.lastKnownGoodVerification,
          }

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: nextPlugin,
            },
          }
        })
      },

      setPluginConfig: (pluginId, config) => {
        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...state.plugins[pluginId], config },
          },
        }))

        const plugin = get().plugins[pluginId]
        if (plugin?.hooks?.onConfigChange) {
          plugin.hooks.onConfigChange(config)
        }

        get().emitEvent({ type: "plugin:config-changed", pluginId, config })
      },

      updatePluginConfig: (pluginId, updates) => {
        const plugin = get().plugins[pluginId]
        if (!plugin) return

        const newConfig = { ...plugin.config, ...updates }
        get().setPluginConfig(pluginId, newConfig)
      },

      updateLastUsedAt: (pluginId) => {
        const plugin = get().plugins[pluginId]
        if (!plugin) return

        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...state.plugins[pluginId], lastUsedAt: Date.now() },
          },
        }))
      },

      updatePluginSettings: (updates) => {
        set((state) => ({
          pluginSettings: { ...state.pluginSettings, ...updates },
        }))
      },

      setPluginDirectory: (pluginDirectory) => {
        set({ pluginDirectory })
      },

      setGlobalPermissionPolicy: (policy) => {
        set({ globalPermissionPolicy: policy })
      },

      setGroupPermissionPolicy: (group, policy) => {
        set((state) => ({
          groupPermissionPolicies: {
            ...state.groupPermissionPolicies,
            [group]: policy,
          },
        }))
      },

      setRememberedPermissionDecision: (pluginId, permission, decision) => {
        set((state) => ({
          rememberedPermissions: {
            ...state.rememberedPermissions,
            [pluginId]: {
              ...(state.rememberedPermissions[pluginId] || {}),
              [permission]: decision,
            },
          },
        }))
      },

      clearRememberedPermissionDecision: (pluginId, permission) => {
        set((state) => {
          const current = { ...(state.rememberedPermissions[pluginId] || {}) }
          delete current[permission]

          const nextRememberedPermissions = { ...state.rememberedPermissions }
          if (Object.keys(current).length === 0) {
            delete nextRememberedPermissions[pluginId]
          } else {
            nextRememberedPermissions[pluginId] = current
          }

          return {
            rememberedPermissions: nextRememberedPermissions,
          }
        })
      },

      addReview: (pluginId, review) => {
        set((state) => ({
          reviews: {
            ...state.reviews,
            [pluginId]: [review, ...(state.reviews[pluginId] || [])].slice(0, 50),
          },
        }))
      },

      getReviews: (pluginId) => {
        return get().reviews[pluginId] || []
      },

      // =====================================================================
      // Plugin Registration Actions
      // =====================================================================

      registerPluginHooks: (pluginId, hooks) => {
        set((state) => ({
          plugins: {
            ...state.plugins,
            [pluginId]: { ...state.plugins[pluginId], hooks },
          },
        }))
      },

      registerPluginTool: (pluginId, tool) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin) return state

          const existingTools = plugin.tools || []
          const filteredTools = existingTools.filter((t) => t.name !== tool.name)

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: { ...plugin, tools: [...filteredTools, tool] },
            },
          }
        })
      },

      unregisterPluginTool: (pluginId, toolName) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin || !plugin.tools) return state

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...plugin,
                tools: plugin.tools.filter((t) => t.name !== toolName),
              },
            },
          }
        })
      },

      registerPluginComponent: (pluginId, component) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin) return state

          const existingComponents = plugin.components || []
          const filteredComponents = existingComponents.filter((c) => c.type !== component.type)

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...plugin,
                components: [...filteredComponents, component],
              },
            },
          }
        })
      },

      unregisterPluginComponent: (pluginId, componentType) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin || !plugin.components) return state

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...plugin,
                components: plugin.components.filter((c) => c.type !== componentType),
              },
            },
          }
        })
      },

      registerPluginMode: (pluginId, mode) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin) return state

          const existingModes = plugin.modes || []
          const filteredModes = existingModes.filter((m) => m.id !== mode.id)

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: { ...plugin, modes: [...filteredModes, mode] },
            },
          }
        })
      },

      unregisterPluginMode: (pluginId, modeId) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin || !plugin.modes) return state

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...plugin,
                modes: plugin.modes.filter((m) => m.id !== modeId),
              },
            },
          }
        })
      },

      registerPluginCommand: (pluginId, command) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin) return state

          const existingCommands = plugin.commands || []
          const filteredCommands = existingCommands.filter((c) => c.id !== command.id)

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...plugin,
                commands: [...filteredCommands, command],
              },
            },
          }
        })
      },

      unregisterPluginCommand: (pluginId, commandId) => {
        set((state) => {
          const plugin = state.plugins[pluginId]
          if (!plugin || !plugin.commands) return state

          return {
            plugins: {
              ...state.plugins,
              [pluginId]: {
                ...plugin,
                commands: plugin.commands.filter((c) => c.id !== commandId),
              },
            },
          }
        })
      },

      // =====================================================================
      // System Actions
      // =====================================================================

      initialize: async (pluginDirectory) => {
        set({ pluginDirectory, initialized: true })
      },

      scanPlugins: async () => {
        const { pluginDirectory } = get()
        if (!pluginDirectory) return

        try {
          const results = await invoke<
            Array<{
              manifest: PluginManifest
              path: string
              source?: PluginSource
              installRootKind?: PluginInstallRootKind
              compatibilityDiagnostics?: ExtensionCompatibilityDiagnostic[]
            }>
          >("plugin_scan_directory", {
            directory: pluginDirectory,
          })

          const validResults = results.filter((r) => {
            const validation = validatePluginManifest(r.manifest)
            return validation.valid
          })

          set((state) => {
            const nextPlugins = { ...state.plugins }

            for (const entry of validResults) {
              const { manifest, path } = entry
              const source = entry.source || "local"
              const existing = nextPlugins[manifest.id]
              const observedSources = mergeObservedSources(existing, source)
              const mergedDiagnostics = withSourceTransitionDiagnostics(
                existing,
                source,
                entry.compatibilityDiagnostics
              )
              const descriptor = buildExtensionDescriptor({
                manifest,
                source,
                path,
                pluginDirectory,
                installRootKind: entry.installRootKind,
                observedSources,
                compatibilityDiagnostics: mergedDiagnostics,
              })
              if (!existing) {
                nextPlugins[manifest.id] = {
                  manifest,
                  status: "installed",
                  source,
                  path,
                  descriptor,
                  resolvedIcon: resolvePluginIcon({ icon: manifest.icon, pluginRoot: path }),
                  config: (manifest.defaultConfig as Record<string, unknown>) || {},
                  installedAt: new Date(),
                }
                continue
              }

              nextPlugins[manifest.id] = {
                ...existing,
                manifest,
                source,
                path,
                descriptor,
                resolvedIcon: resolvePluginIcon({ icon: manifest.icon, pluginRoot: path }),
              }
            }

            return {
              plugins: nextPlugins,
            }
          })
        } catch (error) {
          log.error("Failed to scan plugins", error as Error)
        }
      },

      getPlugin: (pluginId) => {
        return get().plugins[pluginId]
      },

      getEnabledPlugins: () => {
        return Object.values(get().plugins).filter((p) => p.status === "enabled")
      },

      getPluginsByCapability: (capability) => {
        return Object.values(get().plugins).filter(
          (p) => p.status === "enabled" && p.manifest.capabilities.includes(capability as never)
        )
      },

      getAllTools: () => {
        const enabledPlugins = get().getEnabledPlugins()
        return enabledPlugins.flatMap((p) => p.tools || [])
      },

      getAllComponents: () => {
        const enabledPlugins = get().getEnabledPlugins()
        return enabledPlugins.flatMap((p) => p.components || [])
      },

      getAllModes: () => {
        const enabledPlugins = get().getEnabledPlugins()
        return enabledPlugins.flatMap((p) => p.modes || [])
      },

      getAllCommands: () => {
        const enabledPlugins = get().getEnabledPlugins()
        return enabledPlugins.flatMap((p) => p.commands || [])
      },

      // =====================================================================
      // Event System
      // =====================================================================

      addEventListener: (type, listener) => {
        const listeners = get().eventListeners
        if (!listeners.has(type)) {
          listeners.set(type, new Set())
        }
        listeners.get(type)!.add(listener)

        // Return unsubscribe function
        return () => {
          const typeListeners = listeners.get(type)
          if (typeListeners) {
            typeListeners.delete(listener)
          }
        }
      },

      emitEvent: (event) => {
        const listeners = get().eventListeners

        // Emit to specific type listeners
        const typeListeners = listeners.get(event.type)
        if (typeListeners) {
          typeListeners.forEach((listener) => listener(event))
        }

        // Emit to wildcard listeners
        const wildcardListeners = listeners.get("*")
        if (wildcardListeners) {
          wildcardListeners.forEach((listener) => listener(event))
        }
      },

      // =====================================================================
      // Reset
      // =====================================================================

      reset: () => {
        set({
          ...initialState,
          eventListeners: new Map(),
        })
      },
    }),
    {
      name: "cognia-plugins",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Record<string, unknown>
        if (version === 0) {
          // v0 -> v1: Ensure pluginDirectory field exists
          if (!state.pluginDirectory) {
            state.pluginDirectory = null
          }
          if (!state.plugins || typeof state.plugins !== "object") {
            state.plugins = {}
          }
        }
        return state
      },
      partialize: (state) => ({
        // Only persist essential plugin state
        plugins: Object.fromEntries(
          Object.entries(state.plugins).map(([id, plugin]) => [
            id,
            {
              manifest: plugin.manifest,
              status: plugin.status === "enabled" ? "installed" : plugin.status,
              source: plugin.source,
              path: plugin.path,
              config: plugin.config,
              verificationSnapshot: plugin.verificationSnapshot,
              lastKnownGoodVerification: plugin.lastKnownGoodVerification,
              installedAt: plugin.installedAt,
              updatedAt: plugin.updatedAt,
            },
          ])
        ),
        pluginDirectory: state.pluginDirectory,
        pluginSettings: state.pluginSettings,
        rememberedPermissions: state.rememberedPermissions,
        globalPermissionPolicy: state.globalPermissionPolicy,
        groupPermissionPolicies: state.groupPermissionPolicies,
        reviews: state.reviews,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<PluginState> | undefined
        return {
          ...currentState,
          ...persisted,
          pluginSettings: {
            ...currentState.pluginSettings,
            ...(persisted?.pluginSettings || {}),
          },
          rememberedPermissions: {
            ...currentState.rememberedPermissions,
            ...(persisted?.rememberedPermissions || {}),
          },
          globalPermissionPolicy:
            persisted?.globalPermissionPolicy || currentState.globalPermissionPolicy,
          groupPermissionPolicies: {
            ...currentState.groupPermissionPolicies,
            ...(persisted?.groupPermissionPolicies || {}),
          },
          reviews: {
            ...currentState.reviews,
            ...(persisted?.reviews || {}),
          },
          // Ensure non-serializable fields are always proper types after hydration
          loading: new Set<string>(),
          eventListeners: new Map<string, Set<(event: PluginSystemEvent) => void>>(),
          // Merge plugins from persisted state, keeping current state's runtime fields
          plugins: {
            ...currentState.plugins,
            ...(persisted?.plugins || {}),
          },
        }
      },
    }
  )
)

// =============================================================================
// Selectors
// =============================================================================

export const selectPlugin = (pluginId: string) => (state: PluginState) => state.plugins[pluginId]

export const selectEnabledPlugins = (state: PluginState) =>
  Object.values(state.plugins).filter((p) => p.status === "enabled")

export const selectPluginsByStatus = (status: PluginStatus) => (state: PluginState) =>
  Object.values(state.plugins).filter((p) => p.status === status)

export const selectPluginConfig = (pluginId: string) => (state: PluginState) =>
  state.plugins[pluginId]?.config

export const selectAllPluginTools = (state: PluginState) =>
  Object.values(state.plugins)
    .filter((p) => p.status === "enabled")
    .flatMap((p) => p.tools || [])

export const selectAllPluginComponents = (state: PluginState) =>
  Object.values(state.plugins)
    .filter((p) => p.status === "enabled")
    .flatMap((p) => p.components || [])

export const selectAllPluginModes = (state: PluginState) =>
  Object.values(state.plugins)
    .filter((p) => p.status === "enabled")
    .flatMap((p) => p.modes || [])
