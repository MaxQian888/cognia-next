/**
 * Plugin Loader - Handles loading plugin modules dynamically
 */

import { loggers } from "@/lib/logger"
import type { Plugin, PluginDefinition, PluginManifest } from "@/types/plugin"
import { getBrowserBuiltinRegistryEntry } from "./browser-builtin-registry"
import { loadWasmDefinition } from "./wasm-loader"
import { loadVscodeDefinition } from "./vscode-loader"

const pluginLoaderLogger = loggers.plugin.child("loader")

// =============================================================================
// Types
// =============================================================================

interface LoadedModule {
  definition: PluginDefinition
  exports: Record<string, unknown>
}

// =============================================================================
// Plugin Loader
// =============================================================================

export class PluginLoader {
  private loadedModules: Map<string, LoadedModule> = new Map()
  private loadingPromises: Map<string, Promise<PluginDefinition>> = new Map()

  /**
   * Load a plugin module
   */
  async load(plugin: Plugin): Promise<PluginDefinition> {
    const pluginId = plugin.manifest.id

    // Return cached if already loaded
    if (this.loadedModules.has(pluginId)) {
      return this.loadedModules.get(pluginId)!.definition
    }

    // Return existing loading promise to avoid duplicate loads
    if (this.loadingPromises.has(pluginId)) {
      return this.loadingPromises.get(pluginId)!
    }

    // Create loading promise
    const loadPromise = this.loadModule(plugin)
    this.loadingPromises.set(pluginId, loadPromise)

    try {
      const definition = await loadPromise
      return definition
    } finally {
      this.loadingPromises.delete(pluginId)
    }
  }

  /**
   * Load a plugin module based on type
   */
  private async loadModule(plugin: Plugin): Promise<PluginDefinition> {
    const { manifest, path } = plugin

    switch (manifest.type) {
      case "frontend":
        return this.loadFrontendModule(manifest, path)
      case "python":
        return this.loadPythonModule(manifest, path)
      case "hybrid":
        return this.loadHybridModule(manifest, path)
      case "wasm":
        return this.loadWasmModule(manifest, path)
      case "vscode-extension":
        return this.loadVscodeModule(manifest, path)
      default:
        throw new Error(`Unknown plugin type: ${manifest.type}`)
    }
  }

  /**
   * Load a VS Code extension. The Node sidecar lives in
   * `sidecars/vscode-ext-host/` and is managed by Tauri; this loader is
   * a thin IPC client mirror of `loadWasmModule`. See
   * `lib/plugin/core/vscode-loader.ts` for the IPC contract.
   */
  private async loadVscodeModule(
    manifest: PluginManifest,
    pluginPath: string
  ): Promise<PluginDefinition> {
    const definition = await loadVscodeDefinition(manifest, pluginPath)
    this.loadedModules.set(manifest.id, {
      definition,
      exports: { default: definition },
    })
    return definition
  }

  /**
   * Load a WASM Component Model plugin. The actual wasmtime engine lives in
   * `src-tauri/src/plugin_api/wasm/`; this loader thin-wraps the IPC client.
   */
  private async loadWasmModule(
    manifest: PluginManifest,
    pluginPath: string
  ): Promise<PluginDefinition> {
    const definition = await loadWasmDefinition(manifest, pluginPath)
    this.loadedModules.set(manifest.id, {
      definition,
      exports: { default: definition },
    })
    return definition
  }

  /**
   * Load a frontend (JavaScript/TypeScript) plugin
   */
  private async loadFrontendModule(
    manifest: PluginManifest,
    pluginPath: string
  ): Promise<PluginDefinition> {
    if (!manifest.main) {
      throw new Error(`Frontend plugin ${manifest.id} missing 'main' entry point`)
    }

    try {
      const builtinRegistryEntry = pluginPath.startsWith("builtin://")
        ? getBrowserBuiltinRegistryEntry(manifest.id)
        : undefined
      if (builtinRegistryEntry?.load) {
        const definition = await builtinRegistryEntry.load()
        this.loadedModules.set(manifest.id, {
          definition,
          exports: { default: definition },
        })
        return definition
      }

      // Dynamic import of the plugin module
      // In production, plugins would be bundled and served from a known location
      const modulePath = `${pluginPath}/${manifest.main}`

      // Use dynamic import with error handling
      // Note: In Tauri, we may need to use a different approach
      // such as loading via fetch and eval, or using a plugin bundler
      const moduleExports = await this.importModule(modulePath)

      // Extract the plugin definition
      const definition = this.extractDefinition(moduleExports, manifest)

      // Cache the loaded module
      this.loadedModules.set(manifest.id, {
        definition,
        exports: moduleExports as Record<string, unknown>,
      })

      return definition
    } catch (error) {
      throw new Error(`Failed to load frontend plugin ${manifest.id}: ${error}`)
    }
  }

  /**
   * Load a Python plugin via Tauri/PyO3 backend
   *
   * In Tauri, Python plugins are loaded by the Rust backend which manages
   * the Python runtime. The loader creates a definition that delegates
   * activation/deactivation to Tauri IPC commands.
   */
  private async loadPythonModule(
    manifest: PluginManifest,
    pluginPath: string
  ): Promise<PluginDefinition> {
    // Check if Tauri is available for native Python execution
    const isTauriAvailable = await this.checkTauriAvailable()

    if (isTauriAvailable) {
      try {
        // Load the Python plugin via Tauri's Python runtime
        const { invoke } = await import("@tauri-apps/api/core")

        await invoke("plugin_load_python", {
          pluginId: manifest.id,
          manifestJson: JSON.stringify(manifest),
          pluginPath,
        })

        return {
          manifest,
          activate: async (context) => {
            context.logger.info(`Activating Python plugin ${manifest.id} via Tauri`)

            // Activate the Python plugin via Tauri
            const result = await invoke<{
              tools?: Array<{ name: string; description: string; parameters?: unknown }>
              hooks?: string[]
            }>("plugin_activate_python", {
              pluginId: manifest.id,
              config: JSON.stringify({}),
            })

            // Register tools returned from Python runtime
            if (result?.tools && Array.isArray(result.tools)) {
              for (const tool of result.tools) {
                context.logger.debug(`Registering Python tool: ${tool.name}`)
              }
            }

            return result?.hooks ? this.buildHooksFromPython(manifest.id, result.hooks, invoke) : {}
          },
          deactivate: async () => {
            try {
              await invoke("plugin_deactivate_python", {
                pluginId: manifest.id,
              })
            } catch (error) {
              // Log but don't throw on deactivation failure
              pluginLoaderLogger.warn("Failed to deactivate Python plugin", {
                pluginId: manifest.id,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          },
        }
      } catch (error) {
        pluginLoaderLogger.warn("Failed to load Python plugin via Tauri, falling back to stub", {
          pluginId: manifest.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Fallback: return stub definition for non-Tauri environments (web dev)
    return {
      manifest,
      activate: async (context) => {
        context.logger.warn(
          `Python plugin ${manifest.id} requires Tauri runtime. Running in stub mode.`
        )
        // Persist a runtime warning on the plugin row so the UI can render
        // a degraded badge. Fire-and-forget so activate doesn't block on
        // a Dexie write (the runtime is happy regardless).
        void this.persistPythonStubWarning(manifest.id)
        return {}
      },
      deactivate: async () => {},
    }
  }

  /**
   * Best-effort: append "python-runtime-unavailable" to the row's
   * `manifest._cogniaWarnings` so the UI can render a degraded badge. Runs
   * detached from the activate flow so a Dexie hiccup never blocks plugin
   * load.
   */
  private async persistPythonStubWarning(pluginId: string): Promise<void> {
    try {
      const { getPlugin, updatePlugin } = await import("@/lib/db/plugins")
      const row = await getPlugin(pluginId)
      if (!row) return
      const existing = (
        (row.manifest as { _cogniaWarnings?: string[] })._cogniaWarnings ?? []
      ).slice()
      const warning = "python-runtime-unavailable"
      if (existing.includes(warning)) return
      existing.push(warning)
      await updatePlugin(pluginId, {
        manifest: { ...row.manifest, _cogniaWarnings: existing },
      })
    } catch (writeError) {
      pluginLoaderLogger.debug("Skipped runtime warning write for Python stub", {
        pluginId,
        error: writeError instanceof Error ? writeError.message : String(writeError),
      })
    }
  }

  /**
   * Check if Tauri runtime is available
   */
  private async checkTauriAvailable(): Promise<boolean> {
    try {
      // Check for __TAURI_INTERNALS__ which is set by Tauri's webview
      return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    } catch {
      return false
    }
  }

  /**
   * Build hook handlers that delegate to the Python runtime via Tauri IPC
   */
  private buildHooksFromPython(
    pluginId: string,
    hookNames: string[],
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  ): Record<string, (...args: unknown[]) => void | Promise<void>> {
    const hooks: Record<string, (...args: unknown[]) => void | Promise<void>> = {}

    for (const hookName of hookNames) {
      hooks[hookName] = async (...args: unknown[]) => {
        try {
          await invoke("plugin_dispatch_python_hook", {
            pluginId,
            hookName,
            argsJson: JSON.stringify(args),
          })
        } catch (error) {
          pluginLoaderLogger.error("Failed to dispatch Python hook", error, {
            pluginId,
            hookName,
          })
        }
      }
    }

    return hooks
  }

  /**
   * Load a hybrid plugin (both frontend and Python)
   *
   * Hybrid plugins have both a TypeScript/JS frontend part and a Python backend part.
   * The frontend is loaded via the standard module loader, and the Python part
   * is loaded via Tauri IPC.
   */
  private async loadHybridModule(
    manifest: PluginManifest,
    pluginPath: string
  ): Promise<PluginDefinition> {
    // Load frontend part if exists
    let frontendDefinition: PluginDefinition | null = null
    if (manifest.main) {
      frontendDefinition = await this.loadFrontendModule(manifest, pluginPath)
    }

    // Load Python part
    let pythonDefinition: PluginDefinition | null = null
    if (manifest.pythonMain) {
      pythonDefinition = await this.loadPythonModule(manifest, pluginPath)
    }

    // Return combined definition that coordinates both parts
    return {
      manifest,
      activate: async (context) => {
        const allHooks: Record<string, unknown> = {}

        // Activate frontend part
        if (frontendDefinition) {
          const result = await frontendDefinition.activate(context)
          if (result) {
            Object.assign(allHooks, result)
          }
          context.logger.info(`Hybrid plugin ${manifest.id} frontend activated`)
        }

        // Activate Python part
        if (pythonDefinition) {
          const result = await pythonDefinition.activate(context)
          if (result) {
            // Python hooks are merged; frontend hooks take priority on conflict
            for (const [key, value] of Object.entries(result)) {
              if (!(key in allHooks)) {
                allHooks[key] = value
              }
            }
          }
          context.logger.info(`Hybrid plugin ${manifest.id} Python activated`)
        }

        return allHooks
      },
      deactivate: async () => {
        // Deactivate both parts, Python first to clean up native resources
        if (pythonDefinition?.deactivate) {
          await pythonDefinition.deactivate()
        }
        if (frontendDefinition?.deactivate) {
          await frontendDefinition.deactivate()
        }
      },
    }
  }

  /**
   * Import a module dynamically
   *
   * In Tauri, file system paths cannot be used directly as script src.
   * We use multiple strategies:
   * 1. Tauri asset protocol (convertFileSrc) for loading bundled plugins
   * 2. Fetch + eval for loading plugin code from the file system
   * 3. Script tag with blob URL as fallback
   */
  private async importModule(modulePath: string): Promise<unknown> {
    // Strategy 1: Try Tauri asset protocol if available
    try {
      const { convertFileSrc } = await import("@tauri-apps/api/core")
      const assetUrl = convertFileSrc(modulePath)
      return await this.loadViaFetch(assetUrl, modulePath)
    } catch {
      // Tauri not available or convertFileSrc failed
    }

    // Strategy 2: Try fetch + eval with file:// protocol or direct path
    try {
      return await this.loadViaFetch(modulePath, modulePath)
    } catch {
      // Fetch failed
    }

    // Strategy 3: Fallback to script tag with blob URL
    return this.loadAsScript(modulePath)
  }

  /**
   * Load module by fetching its content and evaluating it
   */
  private async loadViaFetch(url: string, originalPath: string): Promise<unknown> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch plugin: ${response.status} ${response.statusText}`)
    }

    const code = await response.text()

    // Create a module-like environment for the plugin
    const pluginExports: Record<string, unknown> = {}
    const pluginModule: { exports: Record<string, unknown> } = { exports: pluginExports }

    // Wrap the plugin code in a function to provide module/exports
    const wrappedCode = `(function(module, exports, require) { ${code} })`

    try {
      const factory = (0, eval)(wrappedCode)
      factory(pluginModule, pluginExports, () => {
        throw new Error(
          `require() is not supported in plugins. Use ES module imports in your build. Path: ${originalPath}`
        )
      })

      // Return either module.exports or the exports object
      return pluginModule.exports !== pluginExports ? pluginModule.exports : pluginExports
    } catch (error) {
      throw new Error(`Failed to evaluate plugin code from ${originalPath}: ${error}`)
    }
  }

  /**
   * Load module as script tag with blob URL (fallback)
   */
  private async loadAsScript(modulePath: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Create a unique global variable name for the plugin to export to
      const exportVar = `__pluginExport_${Date.now()}_${Math.random().toString(36).slice(2)}`

      // Set up the global receiver
      ;(window as unknown as Record<string, unknown>)[exportVar] = undefined

      // For script tag loading, the plugin must call window[exportVar] = { activate, deactivate }
      // or assign to window.__cognia_plugin
      const checkExport = () => {
        const result =
          (window as unknown as Record<string, unknown>)[exportVar] ||
          (window as unknown as Record<string, unknown>).__cognia_plugin
        delete (window as unknown as Record<string, unknown>)[exportVar]
        delete (window as unknown as Record<string, unknown>).__cognia_plugin
        return result
      }

      // Create script element
      const script = document.createElement("script")
      script.type = "text/javascript"

      // Try to convert file path to asset URL for Tauri
      script.src = modulePath
      script.onload = () => {
        const result = checkExport()
        if (result) {
          resolve(result)
        } else {
          reject(new Error(`Plugin loaded but did not export anything: ${modulePath}`))
        }
        script.remove()
      }
      script.onerror = () => {
        checkExport()
        reject(new Error(`Failed to load script: ${modulePath}`))
        script.remove()
      }

      document.head.appendChild(script)

      // Timeout after 30 seconds
      setTimeout(() => {
        const result = checkExport()
        if (!result) {
          reject(new Error(`Timeout loading script: ${modulePath}`))
          script.remove()
        }
      }, 30000)
    })
  }

  /**
   * Extract plugin definition from module exports
   */
  private extractDefinition(moduleExports: unknown, manifest: PluginManifest): PluginDefinition {
    const exports = moduleExports as Record<string, unknown>

    // Check for default export
    if (exports.default && this.isPluginDefinition(exports.default)) {
      return exports.default as PluginDefinition
    }

    // Check for named 'plugin' export
    if (exports.plugin && this.isPluginDefinition(exports.plugin)) {
      return exports.plugin as PluginDefinition
    }

    // Check for 'activate' function export
    if (typeof exports.activate === "function") {
      return {
        manifest,
        activate: exports.activate as PluginDefinition["activate"],
        deactivate: exports.deactivate as PluginDefinition["deactivate"],
      }
    }

    throw new Error(`Plugin ${manifest.id} does not export a valid plugin definition`)
  }

  /**
   * Check if an object is a valid plugin definition
   */
  private isPluginDefinition(obj: unknown): obj is PluginDefinition {
    if (typeof obj !== "object" || obj === null) return false
    const def = obj as Record<string, unknown>
    return typeof def.activate === "function" || typeof def.manifest === "object"
  }

  /**
   * Unload a plugin module
   */
  unload(pluginId: string): void {
    const entry = this.loadedModules.get(pluginId)
    const manifestType = entry?.definition?.manifest?.type
    if (manifestType === "wasm") {
      void import("./wasm-loader").then(({ unloadWasmPlugin }) =>
        unloadWasmPlugin(pluginId).catch(() => {})
      )
    } else if (manifestType === "vscode-extension") {
      void import("./vscode-loader").then(({ unloadVscodeExtension }) =>
        unloadVscodeExtension(pluginId).catch(() => {})
      )
    }
    this.loadedModules.delete(pluginId)
    this.loadingPromises.delete(pluginId)
  }

  /**
   * Check if a plugin is loaded
   */
  isLoaded(pluginId: string): boolean {
    return this.loadedModules.has(pluginId)
  }

  /**
   * Get loaded module exports
   */
  getModuleExports(pluginId: string): Record<string, unknown> | undefined {
    return this.loadedModules.get(pluginId)?.exports
  }

  /**
   * Get loaded plugin definition
   */
  getDefinition(pluginId: string): PluginDefinition | undefined {
    return this.loadedModules.get(pluginId)?.definition
  }

  restoreModule(
    pluginId: string,
    definition: PluginDefinition,
    exports: Record<string, unknown> = {}
  ): void {
    this.loadedModules.set(pluginId, {
      definition,
      exports,
    })
  }

  /**
   * Clear all loaded modules
   */
  clear(): void {
    this.loadedModules.clear()
    this.loadingPromises.clear()
  }
}
