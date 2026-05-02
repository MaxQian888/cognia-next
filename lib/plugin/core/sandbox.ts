/**
 * Plugin Sandbox - Provides isolated execution environment for plugins
 */

import type { PluginPermission } from "@/types/plugin"
import type { SandboxExecutionResult } from "@/types/system/sandbox"
import { loggers } from "./logger"

// =============================================================================
// Types
// =============================================================================

interface BackendSandboxConfig {
  pluginId: string
  permissions: PluginPermission[]
  timeout?: number
  memoryLimit?: number
}

interface SandboxedAPI {
  fetch?: typeof fetch
  localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
  console: Console
  setTimeout: typeof setTimeout
  setInterval: typeof setInterval
  clearTimeout: typeof clearTimeout
  clearInterval: typeof clearInterval
}

// =============================================================================
// Plugin Sandbox
// =============================================================================

export class PluginSandbox {
  private config: BackendSandboxConfig
  private allowedAPIs: Set<string>
  private sandboxedGlobals: SandboxedAPI

  constructor(config: BackendSandboxConfig) {
    this.config = config
    this.allowedAPIs = this.buildAllowedAPIs(config.permissions)
    this.sandboxedGlobals = this.createSandboxedGlobals()
  }

  // ===========================================================================
  // Permission Mapping
  // ===========================================================================

  private buildAllowedAPIs(permissions: PluginPermission[]): Set<string> {
    const allowed = new Set<string>()

    // Always allow basic APIs
    allowed.add("console")
    allowed.add("setTimeout")
    allowed.add("setInterval")
    allowed.add("clearTimeout")
    allowed.add("clearInterval")
    allowed.add("Promise")
    allowed.add("JSON")
    allowed.add("Math")
    allowed.add("Date")
    allowed.add("Array")
    allowed.add("Object")
    allowed.add("String")
    allowed.add("Number")
    allowed.add("Boolean")
    allowed.add("RegExp")
    allowed.add("Error")
    allowed.add("Map")
    allowed.add("Set")
    allowed.add("WeakMap")
    allowed.add("WeakSet")

    // Permission-based APIs
    for (const permission of permissions) {
      switch (permission) {
        case "network:fetch":
          allowed.add("fetch")
          allowed.add("Headers")
          allowed.add("Request")
          allowed.add("Response")
          break

        case "network:websocket":
          allowed.add("WebSocket")
          break

        case "clipboard:read":
        case "clipboard:write":
          allowed.add("navigator.clipboard")
          break

        case "notification":
          allowed.add("Notification")
          break

        // Storage permissions handled separately
        case "database:read":
        case "database:write":
          allowed.add("indexedDB")
          break
      }
    }

    return allowed
  }

  // ===========================================================================
  // Sandboxed Globals Creation
  // ===========================================================================

  private createSandboxedGlobals(): SandboxedAPI {
    const globals: SandboxedAPI = {
      console: this.createSandboxedConsole(),
      setTimeout: this.createSandboxedTimeout(),
      setInterval: this.createSandboxedInterval(),
      clearTimeout: window.clearTimeout.bind(window),
      clearInterval: window.clearInterval.bind(window),
    }

    // Add fetch if permitted
    if (this.allowedAPIs.has("fetch")) {
      globals.fetch = this.createSandboxedFetch()
    }

    // Add localStorage proxy if permitted
    if (
      this.config.permissions.includes("database:read") ||
      this.config.permissions.includes("database:write")
    ) {
      globals.localStorage = this.createSandboxedStorage()
    }

    return globals
  }

  private createSandboxedConsole(): Console {
    const prefix = `[Plugin:${this.config.pluginId}]`

    const pluginLogger = loggers.sandbox
    return {
      ...console,
      log: (...args: unknown[]) => pluginLogger.info(prefix, ...args),
      info: (...args: unknown[]) => pluginLogger.info(prefix, ...args),
      warn: (...args: unknown[]) => pluginLogger.warn(prefix, ...args),
      error: (...args: unknown[]) => pluginLogger.error(prefix, ...args),
      debug: (...args: unknown[]) => pluginLogger.debug(prefix, ...args),
    }
  }

  private createSandboxedTimeout(): typeof setTimeout {
    const maxTimeout = this.config.timeout || 30000

    return ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const actualMs = Math.min(ms || 0, maxTimeout)
      return window.setTimeout(callback, actualMs, ...args)
    }) as typeof setTimeout
  }

  private createSandboxedInterval(): typeof setInterval {
    const minInterval = 100 // Minimum 100ms to prevent CPU abuse

    return ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const actualMs = Math.max(ms || 0, minInterval)
      return window.setInterval(callback, actualMs, ...args)
    }) as typeof setInterval
  }

  private createSandboxedFetch(): typeof fetch {
    const pluginId = this.config.pluginId

    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // Log fetch requests from plugins
      loggers.sandbox.debug(`[Plugin:${pluginId}] fetch:`, input)

      // Add plugin identifier to headers
      const headers = new Headers(init?.headers)
      headers.set("X-Plugin-Id", pluginId)

      return fetch(input, {
        ...init,
        headers,
      })
    }
  }

  private createSandboxedStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
    const prefix = `plugin:${this.config.pluginId}:`
    const canRead = this.config.permissions.includes("database:read")
    const canWrite = this.config.permissions.includes("database:write")

    return {
      getItem: (key: string): string | null => {
        if (!canRead) {
          throw new Error("Storage read permission denied")
        }
        return localStorage.getItem(prefix + key)
      },

      setItem: (key: string, value: string): void => {
        if (!canWrite) {
          throw new Error("Storage write permission denied")
        }
        localStorage.setItem(prefix + key, value)
      },

      removeItem: (key: string): void => {
        if (!canWrite) {
          throw new Error("Storage write permission denied")
        }
        localStorage.removeItem(prefix + key)
      },
    }
  }

  // ===========================================================================
  // Code Execution
  // ===========================================================================

  /**
   * Execute code in the sandbox
   */
  execute<T>(code: string, context: Record<string, unknown> = {}): T {
    // Create a safe evaluation context
    const safeContext = {
      ...this.sandboxedGlobals,
      ...context,
    }

    // Build argument names and values
    const argNames = Object.keys(safeContext)
    const argValues = Object.values(safeContext)

    try {
      // Create function with explicit arguments to avoid scope pollution
      const fn = new Function(...argNames, `"use strict"; return (${code})`)
      return fn(...argValues) as T
    } catch (error) {
      throw new Error(`Plugin sandbox execution error: ${error}`)
    }
  }

  /**
   * Execute an async function in the sandbox
   */
  async executeAsync<T>(code: string, context: Record<string, unknown> = {}): Promise<T> {
    const safeContext = {
      ...this.sandboxedGlobals,
      ...context,
    }

    const argNames = Object.keys(safeContext)
    const argValues = Object.values(safeContext)

    try {
      // Create async function
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const fn = new AsyncFunction(...argNames, `"use strict"; return (${code})`)

      // Execute with timeout
      const timeout = this.config.timeout || 30000
      const result = await Promise.race([
        fn(...argValues),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Execution timeout")), timeout)
        ),
      ])

      return result as T
    } catch (error) {
      throw new Error(`Plugin sandbox async execution error: ${error}`)
    }
  }

  // ===========================================================================
  // Permission Checking
  // ===========================================================================

  hasPermission(permission: PluginPermission): boolean {
    return this.config.permissions.includes(permission)
  }

  checkPermission(permission: PluginPermission): void {
    if (!this.hasPermission(permission)) {
      throw new Error(`Plugin ${this.config.pluginId} does not have permission: ${permission}`)
    }
  }

  getPermissions(): PluginPermission[] {
    return [...this.config.permissions]
  }

  // ===========================================================================
  // Web Sandbox Code Execution
  // ===========================================================================

  /**
   * Execute code in the browser-based web sandbox (Pyodide for Python, Worker/iframe for JS).
   * Requires the `sandbox:web-execute` permission.
   */
  async executeCode(language: string, code: string): Promise<SandboxExecutionResult> {
    this.checkPermission("sandbox:web-execute")

    const { getWebSandboxService } = await import("@/lib/sandbox/web")
    const service = getWebSandboxService()

    if (!service.isAvailable()) {
      throw new Error("Web sandbox is not available. Enable it in settings.")
    }
    if (!service.isLanguageSupported(language)) {
      throw new Error(`Language '${language}' is not supported by the web sandbox.`)
    }

    loggers.sandbox.info(
      `Plugin ${this.config.pluginId} executing ${language} code via web sandbox`
    )
    return service.execute({ language, code })
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  getPluginId(): string {
    return this.config.pluginId
  }

  getSandboxedGlobals(): SandboxedAPI {
    return { ...this.sandboxedGlobals }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createPluginSandbox(config: BackendSandboxConfig): PluginSandbox {
  return new PluginSandbox(config)
}
