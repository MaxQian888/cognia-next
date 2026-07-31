/**
 * Plugin Hot Reload System
 *
 * Provides hot module replacement for plugins during development.
 * Watches plugin files for changes and reloads them without full app restart.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, UnlistenFn } from "@tauri-apps/api/event"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import type { Plugin, PluginDefinition } from "@/types/plugin"
import { loggers } from "../core/logger"
import { recordSilentFailure } from "../contracts/diagnostics-store"

// =============================================================================
// Types
// =============================================================================

export interface HotReloadConfig {
  /** Enable hot reload */
  enabled: boolean
  /** Paths to watch for changes */
  watchPaths: string[]
  /** Debounce time in milliseconds */
  debounceMs: number
  /** Preserve plugin state across reloads */
  preserveState: boolean
  /** Auto-reload on file changes */
  autoReload: boolean
  /** Show notifications on reload */
  showNotifications: boolean
}

export interface FileChangeEvent {
  type: "create" | "modify" | "delete" | "rename"
  path: string
  pluginId?: string
  timestamp: number
}

export interface ReloadResult {
  success: boolean
  pluginId: string
  duration: number
  error?: string
  preservedState?: Record<string, unknown>
}

export interface HotReloadState {
  isWatching: boolean
  watchedPlugins: Set<string>
  pendingReloads: Map<string, NodeJS.Timeout>
  reloadHistory: ReloadResult[]
  lastReloadTime: Map<string, number>
}

type ReloadCallback = (result: ReloadResult) => void
type ErrorCallback = (error: Error, pluginId: string) => void

// =============================================================================
// Hot Reload Manager
// =============================================================================

export class PluginHotReload {
  private config: HotReloadConfig
  private state: HotReloadState
  private reloadCallbacks: Set<ReloadCallback> = new Set()
  private errorCallbacks: Set<ErrorCallback> = new Set()
  private unlistenFn: UnlistenFn | null = null
  private pluginStates: Map<string, Record<string, unknown>> = new Map()
  private pluginLoader: ((pluginId: string) => Promise<PluginDefinition>) | null = null
  private pluginReloader:
    ((pluginId: string, definition: PluginDefinition) => Promise<void>) | null = null

  constructor(config: Partial<HotReloadConfig> = {}) {
    this.config = {
      enabled: false,
      watchPaths: [],
      debounceMs: 300,
      preserveState: true,
      autoReload: true,
      showNotifications: true,
      ...config,
    }

    this.state = {
      isWatching: false,
      watchedPlugins: new Set(),
      pendingReloads: new Map(),
      reloadHistory: [],
      lastReloadTime: new Map(),
    }
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  setConfig(config: Partial<HotReloadConfig>): void {
    this.config = { ...this.config, ...config }

    if (!this.config.enabled && this.state.isWatching) {
      this.stopWatching()
    }
  }

  getConfig(): HotReloadConfig {
    return { ...this.config }
  }

  setPluginLoader(loader: (pluginId: string) => Promise<PluginDefinition>): void {
    this.pluginLoader = loader
  }

  setPluginReloader(
    reloader: (pluginId: string, definition: PluginDefinition) => Promise<void>
  ): void {
    this.pluginReloader = reloader
  }

  // ===========================================================================
  // Watching
  // ===========================================================================

  async startWatching(plugins: Plugin[]): Promise<void> {
    if (!this.config.enabled) {
      loggers.hotReload.warn("Hot reload is disabled")
      return
    }

    if (this.state.isWatching) {
      await this.stopWatching()
    }

    try {
      // Collect plugin paths to watch
      const pathsToWatch: string[] = []

      for (const plugin of plugins) {
        if (plugin.source === "dev" || plugin.source === "local") {
          pathsToWatch.push(plugin.path)
          this.state.watchedPlugins.add(plugin.manifest.id)
        }
      }

      // Add any custom watch paths
      pathsToWatch.push(...this.config.watchPaths)

      if (pathsToWatch.length === 0) {
        loggers.hotReload.info("No plugins to watch")
        return
      }

      // Start watching via Tauri
      await invoke("plugin_watch_start", { paths: pathsToWatch })

      // Listen for file change events
      this.unlistenFn = await listen<FileChangeEvent>("plugin:file-change", (event) => {
        this.handleFileChange(event.payload)
      })

      this.state.isWatching = true
      loggers.hotReload.info(`Watching ${pathsToWatch.length} paths for changes`)
    } catch (error) {
      loggers.hotReload.error("Failed to start watching:", error)
      throw error
    }
  }

  async stopWatching(): Promise<void> {
    if (!this.state.isWatching) return

    try {
      // Cancel pending reloads
      for (const timeout of this.state.pendingReloads.values()) {
        clearTimeout(timeout)
      }
      this.state.pendingReloads.clear()

      // Stop watching via Tauri
      await invoke("plugin_watch_stop")

      // Remove event listener
      if (this.unlistenFn) {
        safeUnlisten(this.unlistenFn)
        this.unlistenFn = null
      }

      this.state.isWatching = false
      this.state.watchedPlugins.clear()
      loggers.hotReload.info("Stopped watching")
    } catch (error) {
      loggers.hotReload.error("Failed to stop watching:", error)
    }
  }

  // ===========================================================================
  // File Change Handling
  // ===========================================================================

  private handleFileChange(event: FileChangeEvent): void {
    const pluginId = this.resolvePluginId(event.path)
    if (!pluginId) return

    if (!this.state.watchedPlugins.has(pluginId)) return

    loggers.hotReload.debug(`File changed: ${event.path} (${event.type})`)

    // Debounce reloads
    const existingTimeout = this.state.pendingReloads.get(pluginId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }

    if (this.config.autoReload) {
      const timeout = setTimeout(() => {
        this.reloadPlugin(pluginId)
        this.state.pendingReloads.delete(pluginId)
      }, this.config.debounceMs)

      this.state.pendingReloads.set(pluginId, timeout)
    }
  }

  private resolvePluginId(filePath: string): string | null {
    // Extract plugin ID from file path
    // Expects paths like: /plugins/<plugin-id>/...
    const match = filePath.match(/[/\\]plugins[/\\]([^/\\]+)[/\\]/)
    if (match) {
      return match[1]
    }

    // Try to match against watched plugins
    for (const pluginId of this.state.watchedPlugins) {
      if (filePath.includes(pluginId)) {
        return pluginId
      }
    }

    return null
  }

  // ===========================================================================
  // Plugin Reloading
  // ===========================================================================

  async reloadPlugin(pluginId: string): Promise<ReloadResult> {
    const startTime = Date.now()

    try {
      loggers.hotReload.info(`Reloading plugin: ${pluginId}`)

      // Preserve state if configured
      if (this.config.preserveState) {
        await this.preservePluginState(pluginId)
      }

      // Invalidate module cache
      await this.invalidateModuleCache(pluginId)

      // Reload the plugin
      if (this.pluginLoader && this.pluginReloader) {
        const definition = await this.pluginLoader(pluginId)
        await this.pluginReloader(pluginId, definition)
      } else {
        // Fallback: use Tauri command
        await invoke("plugin_reload", { pluginId })
      }

      // python/hybrid plugins also carry a subprocess host running the old
      // module — cycle it so edits to .py files actually land. Re-load
      // re-reads persisted config + host settings.
      await this.reloadPythonHost(pluginId)

      // Restore state if preserved
      const preservedState = this.pluginStates.get(pluginId)
      if (this.config.preserveState && preservedState) {
        await this.restorePluginState(pluginId, preservedState)
      }

      const duration = Date.now() - startTime
      const result: ReloadResult = {
        success: true,
        pluginId,
        duration,
        preservedState,
      }

      this.state.lastReloadTime.set(pluginId, Date.now())
      this.state.reloadHistory.push(result)
      this.trimReloadHistory()

      // Notify callbacks
      this.notifyReload(result)

      if (this.config.showNotifications) {
        this.showNotification(`Plugin ${pluginId} reloaded in ${duration}ms`, "success")
      }

      return result
    } catch (error) {
      const duration = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : String(error)

      const result: ReloadResult = {
        success: false,
        pluginId,
        duration,
        error: errorMessage,
      }

      this.state.reloadHistory.push(result)
      this.trimReloadHistory()

      // Notify error callbacks
      this.notifyError(new Error(errorMessage), pluginId)

      if (this.config.showNotifications) {
        this.showNotification(`Failed to reload ${pluginId}: ${errorMessage}`, "error")
      }

      return result
    }
  }

  /**
   * Cycle a python/hybrid plugin's subprocess host (unload → load) so the
   * fresh module is imported. No-op for other plugin types or when the
   * manager isn't initialized (web mode / unit tests).
   */
  private async reloadPythonHost(pluginId: string): Promise<void> {
    let manager: import("@/lib/plugin/core/manager").PluginManager
    try {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      manager = getPluginManager()
    } catch {
      return // manager not initialized — nothing to cycle
    }
    const type = manager.getPlugin(pluginId)?.manifest.type
    if (type !== "python" && type !== "hybrid") {
      return
    }
    // Failures here are real reload failures (stale code keeps running) —
    // let them propagate into the ReloadResult error path.
    await manager.unloadPythonPlugin(pluginId)
    await manager.loadPythonPlugin(pluginId)
    loggers.hotReload.info(`Python host cycled for ${pluginId}`)
  }

  async reloadAll(): Promise<ReloadResult[]> {
    const results: ReloadResult[] = []

    for (const pluginId of this.state.watchedPlugins) {
      const result = await this.reloadPlugin(pluginId)
      results.push(result)
    }

    return results
  }

  // ===========================================================================
  // State Preservation
  // ===========================================================================

  private async preservePluginState(pluginId: string): Promise<void> {
    try {
      // Get plugin state from storage
      const storageKey = `cognia-plugin-storage:${pluginId}`
      const stateJson = localStorage.getItem(storageKey)

      if (stateJson) {
        const state = JSON.parse(stateJson)
        this.pluginStates.set(pluginId, state)
      }

      // Also try to get runtime state via event
      const runtimeState = await invoke<Record<string, unknown> | null>("plugin_get_state", {
        pluginId,
      }).catch(() => null)

      if (runtimeState) {
        const existingState = this.pluginStates.get(pluginId) || {}
        this.pluginStates.set(pluginId, { ...existingState, _runtime: runtimeState })
      }
    } catch (error) {
      loggers.hotReload.warn(`Failed to preserve state for ${pluginId}:`, error)
    }
  }

  private async restorePluginState(
    pluginId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    try {
      // Restore storage state
      const { _runtime, ...storageState } = state
      const storageKey = `cognia-plugin-storage:${pluginId}`
      localStorage.setItem(storageKey, JSON.stringify(storageState))

      // Restore runtime state
      if (_runtime) {
        await invoke("plugin_set_state", {
          pluginId,
          state: _runtime,
        }).catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "hotReload.restoreState",
              message: "Failed to restore plugin runtime state during hot reload",
              expected: false,
            },
            error
          )
        )
      }

      // Clean up
      this.pluginStates.delete(pluginId)
    } catch (error) {
      loggers.hotReload.warn(`Failed to restore state for ${pluginId}:`, error)
    }
  }

  // ===========================================================================
  // Module Cache Invalidation
  // ===========================================================================

  private async invalidateModuleCache(pluginId: string): Promise<void> {
    try {
      // Clear browser module cache if possible
      // This is a best-effort operation as browsers don't expose module cache directly

      // Notify Tauri to clear any cached modules
      await invoke("plugin_invalidate_cache", { pluginId })

      // Clear any in-memory caches
      if (typeof window !== "undefined") {
        // Clear dynamic import cache by appending timestamp
        const cacheKey = `__plugin_cache_${pluginId}`
        ;(window as unknown as Record<string, unknown>)[cacheKey] = Date.now()
      }
    } catch (error) {
      loggers.hotReload.debug(`Cache invalidation warning for ${pluginId}:`, error)
    }
  }

  // ===========================================================================
  // Callbacks
  // ===========================================================================

  onReload(callback: ReloadCallback): () => void {
    this.reloadCallbacks.add(callback)
    return () => this.reloadCallbacks.delete(callback)
  }

  onError(callback: ErrorCallback): () => void {
    this.errorCallbacks.add(callback)
    return () => this.errorCallbacks.delete(callback)
  }

  private notifyReload(result: ReloadResult): void {
    for (const callback of this.reloadCallbacks) {
      try {
        callback(result)
      } catch (error) {
        loggers.hotReload.error("Reload callback error:", error)
      }
    }
  }

  private notifyError(error: Error, pluginId: string): void {
    for (const callback of this.errorCallbacks) {
      try {
        callback(error, pluginId)
      } catch (err) {
        loggers.hotReload.error("Error callback error:", err)
      }
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private trimReloadHistory(): void {
    const maxHistory = 100
    if (this.state.reloadHistory.length > maxHistory) {
      this.state.reloadHistory = this.state.reloadHistory.slice(-maxHistory)
    }
  }

  private showNotification(message: string, type: "success" | "error"): void {
    // Dispatch custom event for UI to handle
    const event = new CustomEvent("plugin:hot-reload-notification", {
      detail: { message, type },
    })
    window.dispatchEvent(event)
  }

  getState(): HotReloadState {
    return {
      ...this.state,
      watchedPlugins: new Set(this.state.watchedPlugins),
      pendingReloads: new Map(this.state.pendingReloads),
      lastReloadTime: new Map(this.state.lastReloadTime),
    }
  }

  getReloadHistory(pluginId?: string): ReloadResult[] {
    if (pluginId) {
      return this.state.reloadHistory.filter((r) => r.pluginId === pluginId)
    }
    return [...this.state.reloadHistory]
  }

  isWatching(): boolean {
    return this.state.isWatching
  }

  isPluginWatched(pluginId: string): boolean {
    return this.state.watchedPlugins.has(pluginId)
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let hotReloadInstance: PluginHotReload | null = null

export function getPluginHotReload(config?: Partial<HotReloadConfig>): PluginHotReload {
  if (!hotReloadInstance) {
    hotReloadInstance = new PluginHotReload(config)
  } else if (config) {
    hotReloadInstance.setConfig(config)
  }
  return hotReloadInstance
}

export function resetPluginHotReload(): void {
  if (hotReloadInstance) {
    hotReloadInstance.stopWatching()
    hotReloadInstance = null
  }
}
