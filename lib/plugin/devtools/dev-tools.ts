/**
 * Plugin Developer Tools
 *
 * Utilities for plugin development, debugging, and testing.
 */

import { usePluginStore } from "@/stores/plugin"
import type { Plugin, PluginManifest } from "@/types/plugin"
import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"
import type { FullPluginContext } from "../core/context"
import { loggers } from "../core/logger"

// =============================================================================
// Debug Logger
// =============================================================================

interface DebugLogEntry {
  timestamp: Date
  pluginId: string
  level: "debug" | "info" | "warn" | "error"
  category: string
  message: string
  data?: unknown
}

const debugLogs: DebugLogEntry[] = []
const MAX_LOG_ENTRIES = 1000
let debugEnabled = false

/**
 * Enable or disable debug mode
 */
export function setDebugMode(enabled: boolean) {
  debugEnabled = enabled
  if (enabled) {
    loggers.devTools.info("Debug mode enabled")
  }
}

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  return debugEnabled
}

/**
 * Log a debug entry
 */
export function debugLog(
  pluginId: string,
  level: DebugLogEntry["level"],
  category: string,
  message: string,
  data?: unknown
) {
  if (!debugEnabled) return

  const entry: DebugLogEntry = {
    timestamp: new Date(),
    pluginId,
    level,
    category,
    message,
    data,
  }

  debugLogs.push(entry)

  // Trim old entries
  if (debugLogs.length > MAX_LOG_ENTRIES) {
    debugLogs.splice(0, debugLogs.length - MAX_LOG_ENTRIES)
  }

  // Also log to console in debug mode
  const prefix = `[Plugin:${pluginId}][${category}]`
  switch (level) {
    case "debug":
      loggers.devTools.debug(prefix, message, data)
      break
    case "info":
      loggers.devTools.info(prefix, message, data)
      break
    case "warn":
      loggers.devTools.warn(prefix, message, data)
      break
    case "error":
      loggers.devTools.error(prefix, message, data)
      break
  }
}

/**
 * Get debug logs
 */
export function getDebugLogs(filter?: {
  pluginId?: string
  level?: DebugLogEntry["level"]
  category?: string
  since?: Date
}): DebugLogEntry[] {
  let logs = [...debugLogs]

  if (filter) {
    if (filter.pluginId) {
      logs = logs.filter((l) => l.pluginId === filter.pluginId)
    }
    if (filter.level) {
      logs = logs.filter((l) => l.level === filter.level)
    }
    if (filter.category) {
      logs = logs.filter((l) => l.category === filter.category)
    }
    if (filter.since) {
      logs = logs.filter((l) => l.timestamp >= filter.since!)
    }
  }

  return logs
}

/**
 * Clear debug logs
 */
export function clearDebugLogs() {
  debugLogs.length = 0
}

// =============================================================================
// Hook Inspector
// =============================================================================

interface HookCall {
  timestamp: Date
  pluginId: string
  hookName: string
  args: unknown[]
  result?: unknown
  error?: Error
  duration: number
}

const hookCalls: HookCall[] = []
const MAX_HOOK_CALLS = 500

/**
 * Record a hook call
 */
export function recordHookCall(
  pluginId: string,
  hookName: string,
  args: unknown[],
  result: unknown,
  error: Error | undefined,
  duration: number
) {
  if (!debugEnabled) return

  hookCalls.push({
    timestamp: new Date(),
    pluginId,
    hookName,
    args,
    result,
    error,
    duration,
  })

  if (hookCalls.length > MAX_HOOK_CALLS) {
    hookCalls.splice(0, hookCalls.length - MAX_HOOK_CALLS)
  }
}

/**
 * Get hook calls
 */
export function getHookCalls(filter?: {
  pluginId?: string
  hookName?: string
  hasError?: boolean
}): HookCall[] {
  let calls = [...hookCalls]

  if (filter) {
    if (filter.pluginId) {
      calls = calls.filter((c) => c.pluginId === filter.pluginId)
    }
    if (filter.hookName) {
      calls = calls.filter((c) => c.hookName === filter.hookName)
    }
    if (filter.hasError !== undefined) {
      calls = calls.filter((c) => (c.error !== undefined) === filter.hasError)
    }
  }

  return calls
}

/**
 * Clear hook calls
 */
export function clearHookCalls() {
  hookCalls.length = 0
}

// =============================================================================
// Plugin Inspector
// =============================================================================

interface PluginInspection {
  id: string
  manifest: PluginManifest
  status: Plugin["status"]
  config: Record<string, unknown>
  registeredHooks: string[]
  registeredTools: string[]
  registeredModes: string[]
  registeredCommands: string[]
  registeredComponents: string[]
  memoryUsage?: number
  loadTime?: number
  lastError?: string
}

/**
 * Inspect a plugin
 */
export function inspectPlugin(pluginId: string): PluginInspection | null {
  const store = usePluginStore.getState()
  const plugin = store.plugins[pluginId]

  if (!plugin) return null

  const hooks = plugin.hooks as PluginHooksAll | undefined
  const registeredHooks = hooks
    ? Object.keys(hooks).filter((k) => typeof hooks[k as keyof PluginHooksAll] === "function")
    : []

  return {
    id: pluginId,
    manifest: plugin.manifest,
    status: plugin.status,
    config: plugin.config,
    registeredHooks,
    registeredTools: plugin.tools?.map((t) => t.name) || [],
    registeredModes: plugin.modes?.map((m) => m.id) || [],
    registeredCommands: plugin.commands?.map((c) => c.id) || [],
    registeredComponents: plugin.components?.map((c) => c.type) || [],
    lastError: plugin.error,
  }
}

/**
 * Get all plugin inspections
 */
export function inspectAllPlugins(): PluginInspection[] {
  const store = usePluginStore.getState()
  return Object.keys(store.plugins)
    .map((id) => inspectPlugin(id))
    .filter((p): p is PluginInspection => p !== null)
}

// =============================================================================
// Performance Profiler
// =============================================================================

interface PerformanceEntry {
  pluginId: string
  operation: string
  startTime: number
  endTime?: number
  duration?: number
}

const performanceEntries: PerformanceEntry[] = []
const activeOperations: Map<string, PerformanceEntry> = new Map()

/**
 * Start a performance measurement
 */
export function startMeasure(pluginId: string, operation: string): string {
  const id = `${pluginId}:${operation}:${Date.now()}`
  const entry: PerformanceEntry = {
    pluginId,
    operation,
    startTime: performance.now(),
  }
  activeOperations.set(id, entry)
  return id
}

/**
 * End a performance measurement
 */
export function endMeasure(measureId: string) {
  const entry = activeOperations.get(measureId)
  if (entry) {
    entry.endTime = performance.now()
    entry.duration = entry.endTime - entry.startTime
    performanceEntries.push(entry)
    activeOperations.delete(measureId)

    if (debugEnabled) {
      debugLog(
        entry.pluginId,
        "debug",
        "performance",
        `${entry.operation} took ${entry.duration.toFixed(2)}ms`
      )
    }
  }
}

/**
 * Get performance statistics for a plugin
 */
export function getPerformanceStats(pluginId: string): {
  totalOperations: number
  averageDuration: number
  maxDuration: number
  minDuration: number
  byOperation: Record<string, { count: number; avgDuration: number }>
} {
  const entries = performanceEntries.filter((e) => e.pluginId === pluginId && e.duration)

  if (entries.length === 0) {
    return {
      totalOperations: 0,
      averageDuration: 0,
      maxDuration: 0,
      minDuration: 0,
      byOperation: {},
    }
  }

  const durations = entries.map((e) => e.duration!)
  const byOperation: Record<string, { total: number; count: number }> = {}

  for (const entry of entries) {
    if (!byOperation[entry.operation]) {
      byOperation[entry.operation] = { total: 0, count: 0 }
    }
    byOperation[entry.operation].total += entry.duration!
    byOperation[entry.operation].count += 1
  }

  return {
    totalOperations: entries.length,
    averageDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
    maxDuration: Math.max(...durations),
    minDuration: Math.min(...durations),
    byOperation: Object.fromEntries(
      Object.entries(byOperation).map(([op, { total, count }]) => [
        op,
        { count, avgDuration: total / count },
      ])
    ),
  }
}

// =============================================================================
// Mock Context for Testing
// =============================================================================

/**
 * Create a mock plugin context for testing
 */
export function createMockPluginContext(
  pluginId: string,
  options: {
    config?: Record<string, unknown>
    simulateErrors?: boolean
  } = {}
): Partial<FullPluginContext> {
  const logs: { level: string; message: string; args: unknown[] }[] = []

  return {
    pluginId,
    pluginPath: `/mock/plugins/${pluginId}`,
    config: options.config || {},

    logger: {
      debug: (msg: string, ...args: unknown[]) => logs.push({ level: "debug", message: msg, args }),
      info: (msg: string, ...args: unknown[]) => logs.push({ level: "info", message: msg, args }),
      warn: (msg: string, ...args: unknown[]) => logs.push({ level: "warn", message: msg, args }),
      error: (msg: string, ...args: unknown[]) => logs.push({ level: "error", message: msg, args }),
    },

    storage: {
      get: async <T>(key: string): Promise<T | undefined> => {
        if (options.simulateErrors) throw new Error("Storage error")
        const val = localStorage.getItem(`mock:${pluginId}:${key}`)
        return val ? (JSON.parse(val) as T) : undefined
      },
      getOrDefault: async <T>(key: string, defaultValue: T): Promise<T> => {
        const val = localStorage.getItem(`mock:${pluginId}:${key}`)
        return val ? (JSON.parse(val) as T) : defaultValue
      },
      set: async <T>(key: string, value: T): Promise<void> => {
        if (options.simulateErrors) throw new Error("Storage error")
        localStorage.setItem(`mock:${pluginId}:${key}`, JSON.stringify(value))
      },
      remove: async (key: string) => {
        if (options.simulateErrors) throw new Error("Storage error")
        localStorage.removeItem(`mock:${pluginId}:${key}`)
      },
      delete: async (key: string) => {
        if (options.simulateErrors) throw new Error("Storage error")
        localStorage.removeItem(`mock:${pluginId}:${key}`)
      },
      has: async (key: string) => {
        if (options.simulateErrors) throw new Error("Storage error")
        return localStorage.getItem(`mock:${pluginId}:${key}`) !== null
      },
      keys: async () => {
        if (options.simulateErrors) throw new Error("Storage error")
        const prefix = `mock:${pluginId}:`
        const keys: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key?.startsWith(prefix)) {
            keys.push(key.slice(prefix.length))
          }
        }
        return keys
      },
      clear: async () => {
        if (options.simulateErrors) throw new Error("Storage error")
        const prefix = `mock:${pluginId}:`
        const keysToRemove: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key?.startsWith(prefix)) {
            keysToRemove.push(key)
          }
        }
        keysToRemove.forEach((k) => localStorage.removeItem(k))
      },
      getUsage: async () => {
        const prefix = `mock:${pluginId}:`
        let totalBytes = 0
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key?.startsWith(prefix)) {
            const value = localStorage.getItem(key)
            totalBytes += key.length + (value?.length || 0)
          }
        }
        return totalBytes * 2
      },
    },

    events: {
      emit: (event: string, data: unknown) => {
        debugLog(pluginId, "debug", "events", `Emit: ${event}`, data)
      },
      on: (event: string, _handler: (data: unknown) => void) => {
        debugLog(pluginId, "debug", "events", `Subscribe: ${event}`)
        return () => {
          debugLog(pluginId, "debug", "events", `Unsubscribe: ${event}`)
        }
      },
      off: (event: string, _handler: (data: unknown) => void) => {
        debugLog(pluginId, "debug", "events", `Off: ${event}`)
      },
      once: (event: string, _handler: (data: unknown) => void) => {
        debugLog(pluginId, "debug", "events", `Once: ${event}`)
        return () => {}
      },
    },
  }
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validate a plugin manifest
 */
export function validateManifestStrict(manifest: PluginManifest): {
  valid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  // Required fields
  if (!manifest.id) errors.push("Missing required field: id")
  if (!manifest.name) errors.push("Missing required field: name")
  if (!manifest.version) errors.push("Missing required field: version")
  if (!manifest.type) errors.push("Missing required field: type")

  // ID format
  if (manifest.id && !/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
    errors.push(
      "Invalid id format: must be lowercase, start with letter, contain only letters, numbers, and hyphens"
    )
  }

  // Version format
  if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    warnings.push("Version should follow semver format (e.g., 1.0.0)")
  }

  // Type validation
  if (manifest.type && !["frontend", "python", "hybrid", "wasm"].includes(manifest.type)) {
    errors.push(`Invalid type: ${manifest.type}. Must be frontend, python, hybrid, or wasm`)
  }

  // Main entry point
  if (manifest.type === "frontend" && !manifest.main) {
    errors.push("Frontend plugins must specify a main entry point")
  }

  if (manifest.type === "wasm" && !manifest.wasmMain) {
    errors.push("WASM plugins must specify a wasmMain entry point")
  }
  if (manifest.type === "wasm" && !manifest.wasm?.apiVersion) {
    errors.push("WASM plugins must declare wasm.apiVersion (semver)")
  }

  // Capabilities validation
  if (manifest.capabilities) {
    const validCapabilities = [
      "tools",
      "components",
      "modes",
      "skills",
      "themes",
      "commands",
      "hooks",
      "processors",
      "providers",
      "exporters",
      "importers",
      "a2ui",
      "python",
    ]
    for (const cap of manifest.capabilities) {
      if (!validCapabilities.includes(cap)) {
        warnings.push(`Unknown capability: ${cap}`)
      }
    }
  }

  // Permissions check
  if (manifest.permissions?.length === 0) {
    warnings.push("No permissions declared - plugin may have limited functionality")
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

// =============================================================================
// Hot Reload Support
// =============================================================================

let hotReloadEnabled = false
const hotReloadCallbacks: Map<string, () => void> = new Map()

/**
 * Enable hot reload for development
 */
export function enableHotReload() {
  hotReloadEnabled = true
  loggers.devTools.info("Hot reload enabled")
}

/**
 * Disable hot reload
 */
export function disableHotReload() {
  hotReloadEnabled = false
  hotReloadCallbacks.clear()
}

/**
 * Register a hot reload callback for a plugin
 */
export function onHotReload(pluginId: string, callback: () => void): () => void {
  if (!hotReloadEnabled) return () => {}

  hotReloadCallbacks.set(pluginId, callback)
  return () => {
    hotReloadCallbacks.delete(pluginId)
  }
}

/**
 * Trigger hot reload for a plugin
 */
export function triggerHotReload(pluginId: string) {
  if (!hotReloadEnabled) return

  const callback = hotReloadCallbacks.get(pluginId)
  if (callback) {
    loggers.devTools.info(`Hot reloading plugin: ${pluginId}`)
    callback()
  }
}

// =============================================================================
// Export Dev Tools Bundle
// =============================================================================

export const PluginDevTools = {
  // Debug logging
  setDebugMode,
  isDebugEnabled,
  debugLog,
  getDebugLogs,
  clearDebugLogs,

  // Hook inspection
  recordHookCall,
  getHookCalls,
  clearHookCalls,

  // Plugin inspection
  inspectPlugin,
  inspectAllPlugins,

  // Performance profiling
  startMeasure,
  endMeasure,
  getPerformanceStats,

  // Testing utilities
  createMockPluginContext,
  validateManifestStrict,

  // Hot reload
  enableHotReload,
  disableHotReload,
  onHotReload,
  triggerHotReload,
}

export default PluginDevTools
