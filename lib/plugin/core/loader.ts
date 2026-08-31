/**
 * Plugin Loader - Handles loading plugin modules dynamically
 */

import { detectPlatform, isTauri } from "@/lib/platform/detect"
import { loggers } from "@cognia/logging"
import type {
  Plugin,
  PluginContext,
  PluginDefinition,
  PluginManifest,
  PluginPermission,
} from "@/types/plugin"
import { TimeoutError, withTimeout } from "@cognia/primitives"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { getBrowserBuiltinRegistryEntry } from "./browser-builtin-registry"
import { fetchAndVerifyBrowserBuiltinAsset } from "./browser-builtin-assets"
import { getWasmRuntimeGeneration, loadWasmDefinition, unloadWasmPlugin } from "./wasm-loader"
import {
  getVscodeRuntimeGeneration,
  loadVscodeDefinition,
  unloadVscodeExtension,
} from "./vscode-loader"
import {
  deriveScopeFromManifest,
  launchPluginJs,
  type LaunchPluginJsResult,
  type NodePluginActivationSnapshot,
  type PluginJsHostInvoker,
} from "../launcher/launchPluginJs"
import { resolvePluginPath } from "./plugin-path"
import { createPluginRequire, primeSharedModules } from "./shared-modules"
import { assertNoHostPrivateImports } from "../security/import-boundary"
import { persistRuntimeStubWarning, RUNTIME_STUB_WARNINGS } from "./runtime-stub-warning"

const pluginLoaderLogger = loggers.plugin.child("loader")

/**
 * Per-runtime teardown budget. WASM / VSCode unload calls cross an IPC
 * boundary and can stall under host pressure; 5s is enough for clean
 * paths while keeping a hung teardown from blocking
 * `disablePlugin` / `uninstallPlugin` indefinitely. On expiry the
 * runtime call is left running in the background, the failure is
 * recorded via `recordSilentFailure`, and the plugin is marked dirty
 * via `dirtyTeardowns` so a subsequent `load()` can react.
 */
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 5_000

/**
 * The plugin's code was retrieved and then threw while evaluating.
 *
 * Distinct from a transport failure so `importModule` can stop walking its
 * fallback chain: another transport would fetch the same bytes and throw the
 * same way, and continuing would bury the author's real error.
 */
export class PluginEvaluationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "PluginEvaluationError"
  }
}

// =============================================================================
// Types
// =============================================================================

interface LoadedModule {
  definition: PluginDefinition
  exports: Record<string, unknown>
  runtimeGeneration?: string
}

/**
 * Reason a plugin's previous teardown did not finish cleanly. Stored
 * per-pluginId so the manager (or a future re-load policy) can decide
 * whether to refuse, force-clean, or proceed.
 */
export type DirtyTeardownReason = "timeout" | "error"

export interface DirtyTeardownRecord {
  reason: DirtyTeardownReason
  /** Manifest type the previous unload targeted (wasm / vscode-extension). */
  manifestType: string
  /** Wall-clock ms when the dirty event was recorded. */
  at: number
  /** Original error message, when one was thrown / produced. */
  message: string
  /** Opaque isolated-runtime generation that cleanup is allowed to remove. */
  runtimeGeneration?: string
}

function isNodeTargetFrontend(manifest: PluginManifest): boolean {
  return Boolean(
    manifest.engines?.node || manifest.runtimeCompatibility?.tauri?.entrypoint === "node"
  )
}

function resolveRuntimeEntry(pluginPath: string, entry: string | undefined): string {
  if (!entry?.trim()) {
    throw new Error("Node-target frontend plugin missing 'main' entry point")
  }
  return resolvePluginPath(pluginPath, entry)
}

function selectRuntimeEntry(manifest: PluginManifest): string | undefined {
  const platform = detectPlatform()
  if (platform === "headless") return manifest.main
  const runtime = platform === "web" ? "browser" : platform
  const override = manifest.runtimeCompatibility?.[runtime]?.entrypoint
  return override && override !== "node" ? override : manifest.main
}

function hasPermission(manifest: PluginManifest, permission: PluginPermission): boolean {
  return (manifest.permissions ?? []).includes(permission)
}

function deriveNodePermissionScope(manifest: PluginManifest) {
  const permissions = manifest.permissions ?? []
  const fileScope = manifest.fileScope ?? {}
  const hasNetwork =
    hasPermission(manifest, "network:fetch") || hasPermission(manifest, "network:websocket")
  const canSpawn =
    hasPermission(manifest, "shell:execute") || hasPermission(manifest, "process:spawn")
  return deriveScopeFromManifest(permissions, {
    readPaths: hasPermission(manifest, "filesystem:read") ? (fileScope.readPaths ?? []) : [],
    writePaths: hasPermission(manifest, "filesystem:write") ? (fileScope.writePaths ?? []) : [],
    netHosts: hasNetwork ? (manifest.networkAccess?.allowedDomains ?? []) : [],
    subprocesses: canSpawn ? (manifest.shellCommands ?? []) : [],
  })
}

const UNSAFE_CONTEXT_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])

function reviveNodePluginValue(value: unknown, launch: LaunchPluginJsResult): unknown {
  if (Array.isArray(value)) return value.map((item) => reviveNodePluginValue(item, launch))
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (typeof record.$callback === "string") {
    return async (...args: unknown[]) =>
      reviveNodePluginValue(await launch.invokeCallback(record.$callback as string, args), launch)
  }
  if (record.$undefined === true) return undefined
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, reviveNodePluginValue(item, launch)])
  )
}

function replayNodePluginActivation(
  context: object,
  activation: NodePluginActivationSnapshot,
  launch: LaunchPluginJsResult
): void {
  for (const call of activation.calls) {
    const segments = call.path.split(".")
    if (
      segments.length === 0 ||
      segments.some((segment) => !segment || UNSAFE_CONTEXT_SEGMENTS.has(segment))
    ) {
      throw new Error(`Node plugin requested an unsafe context path: ${call.path}`)
    }
    const methodName = segments.pop() as string
    let owner: unknown = context
    for (const segment of segments) {
      if (!owner || typeof owner !== "object") break
      owner = (owner as Record<string, unknown>)[segment]
    }
    const method =
      owner && (typeof owner === "object" || typeof owner === "function")
        ? (owner as Record<string, unknown>)[methodName]
        : undefined
    if (typeof method !== "function") {
      throw new Error(`Node plugin requested unavailable context method: ${call.path}`)
    }
    const args = reviveNodePluginValue(call.args, launch) as unknown[]
    method.apply(owner, args)
  }
}

// =============================================================================
// Plugin Loader
// =============================================================================

export interface PluginLoaderOptions {
  /**
   * Override the per-runtime teardown timeout. Defaults to
   * `DEFAULT_TEARDOWN_TIMEOUT_MS` (5s). Tests can shrink this to keep
   * fake-timer suites fast.
   */
  teardownTimeoutMs?: number

  /**
   * Inject a frontend-module importer (CLI / Node hosts). When set, non-builtin
   * `frontend` plugins load through this instead of the Tauri / fetch / eval
   * strategies in {@link PluginLoader.importModule}, which don't exist under
   * Node. Receives the absolute `main` path and the plugin id (the id lets the
   * importer cache-bust per plugin for hot reload).
   */
  frontendImporter?: (absPath: string, pluginId: string) => Promise<Record<string, unknown>>
  /**
   * Inject a fetcher for the generated browser built-in plugin chunks
   * (`/_cognia/builtin-plugins/<id>/<sha>.cjs`). Those URLs are root-relative,
   * which only resolves inside a document: under Node `fetch()` rejects with
   * `Failed to parse URL`, so every asset-delivered built-in failed to enable
   * on the CLI / brain. A Node host supplies a fetcher that reads the staged
   * chunk off disk; the digest verification in
   * {@link fetchAndVerifyBrowserBuiltinAsset} is unchanged either way.
   */
  builtinAssetFetcher?: typeof fetch
  /** Host-neutral native lifecycle transport used by Node-target plugins. */
  nodeHostInvoker?: PluginJsHostInvoker
}

export class PluginLoader {
  private loadedModules: Map<string, LoadedModule> = new Map()
  private loadingPromises: Map<string, Promise<PluginDefinition>> = new Map()
  private dirtyTeardowns: Map<string, DirtyTeardownRecord> = new Map()
  private readonly teardownTimeoutMs: number
  private readonly frontendImporter?: PluginLoaderOptions["frontendImporter"]
  private readonly builtinAssetFetcher?: typeof fetch
  private readonly nodeHostInvoker?: PluginJsHostInvoker

  constructor(options: PluginLoaderOptions = {}) {
    this.teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS
    this.frontendImporter = options.frontendImporter
    this.builtinAssetFetcher = options.builtinAssetFetcher
    this.nodeHostInvoker = options.nodeHostInvoker
  }

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
   * `sidecar/vscode-ext-host/` and is managed by Tauri; this loader is
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
      runtimeGeneration: getVscodeRuntimeGeneration(manifest.id),
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
      runtimeGeneration: getWasmRuntimeGeneration(manifest.id),
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

    if (isNodeTargetFrontend(manifest)) {
      return this.loadNodeFrontendModule(manifest, pluginPath)
    }

    try {
      const builtinRegistryEntry = pluginPath.startsWith("builtin://")
        ? getBrowserBuiltinRegistryEntry(manifest.id)
        : undefined
      if (builtinRegistryEntry?.asset) {
        const code = await fetchAndVerifyBrowserBuiltinAsset(
          builtinRegistryEntry.asset,
          this.builtinAssetFetcher
        )
        await primeSharedModules(builtinRegistryEntry.asset.sharedModules)
        const moduleExports = this.evaluatePluginCode(code, builtinRegistryEntry.asset.url)
        const definition = this.extractDefinition(moduleExports, manifest)
        this.loadedModules.set(manifest.id, {
          definition,
          exports: moduleExports as Record<string, unknown>,
        })
        return definition
      }
      if (builtinRegistryEntry?.load) {
        const definition = await builtinRegistryEntry.load()
        this.loadedModules.set(manifest.id, {
          definition,
          // Prefer the entry's full export namespace when provided (built-ins
          // whose manifest declares connectors[] and expose a named factory);
          // otherwise the default-only shape is enough for the common case.
          exports: builtinRegistryEntry.moduleExports ?? { default: definition },
        })
        return definition
      }

      // Dynamic import of the plugin module
      // In production, plugins would be bundled and served from a known location
      const runtimeEntry = selectRuntimeEntry(manifest)
      const modulePath = resolveRuntimeEntry(pluginPath, runtimeEntry)

      // CLI / Node hosts inject a `frontendImporter` (the Tauri / fetch / eval
      // strategies below don't exist under Node). Otherwise fall back to the
      // browser / Tauri strategies in `importModule`.
      const moduleExports = this.frontendImporter
        ? await this.frontendImporter(modulePath, manifest.id)
        : await this.importInstalledEntry(manifest.id, pluginPath, runtimeEntry!, modulePath)

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

  private async loadNodeFrontendModule(
    manifest: PluginManifest,
    pluginPath: string
  ): Promise<PluginDefinition> {
    const entryPath = selectRuntimeEntry(manifest)
    resolveRuntimeEntry(pluginPath, entryPath)
    const validatedEntryPath = entryPath as string
    const scope = deriveNodePermissionScope(manifest)
    let launch: LaunchPluginJsResult | null = null
    let activeHooks: unknown
    const definition: PluginDefinition = {
      manifest,
      activate: async (context) => {
        if (launch && (await launch.process.isRunning())) return activeHooks as never
        launch = await launchPluginJs({
          pluginId: manifest.id,
          entryPath: validatedEntryPath,
          cwd: pluginPath,
          scope,
          hostInvoker: this.nodeHostInvoker,
        })
        replayNodePluginActivation(context, launch.activation, launch)
        activeHooks = reviveNodePluginValue(launch.activation.hooks, launch)
        const namedExports = reviveNodePluginValue(launch.activation.exports, launch) as Record<
          string,
          unknown
        >
        this.loadedModules.set(manifest.id, {
          definition,
          exports: { default: definition, ...namedExports },
          runtimeGeneration: launch.generation,
        })
        return activeHooks as never
      },
      deactivate: async () => {
        if (!launch) return
        await launch.deactivate()
        if (!launch.process.killed) {
          await launch.process.kill()
        }
        launch = null
        activeHooks = undefined
      },
    }
    this.loadedModules.set(manifest.id, {
      definition,
      exports: { default: definition },
    })
    return definition
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
    // In the supervised headless brain the canonical PluginManager owns the
    // Python subprocess lifecycle through `plugin_python_*` service RPCs. This
    // loader still needs a definition so hybrid/frontend activation can run,
    // but it must neither create a duplicate host nor stamp the web-only
    // degraded warning. `PluginManager.loadPythonPlugin()` performs the real
    // load immediately after this definition activates.
    if (detectPlatform() === "headless") {
      return {
        manifest,
        activate: async () => ({}),
        deactivate: async () => {},
      }
    }

    // Check if Tauri is available for native Python execution
    const isTauriAvailable = await this.checkTauriAvailable()

    if (isTauriAvailable) {
      try {
        // Load the Python plugin via Tauri's Python runtime
        const { invoke } = await import("@tauri-apps/api/core")

        // invoke-parity-exempt: Python plugin runtime not yet shipped in Rust; caught and surfaced as load failure
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
              // invoke-parity-exempt: Python plugin runtime not yet shipped in Rust; caught and logged
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
        void persistRuntimeStubWarning(manifest.id, RUNTIME_STUB_WARNINGS.python)
        return {}
      },
      deactivate: async () => {},
    }
  }

  /**
   * Check if Tauri runtime is available
   */
  private async checkTauriAvailable(): Promise<boolean> {
    try {
      return isTauri()
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
          // invoke-parity-exempt: Python plugin runtime not yet shipped in Rust; caught and logged
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
      deactivate: async (ctx?: PluginContext) => {
        // Deactivate both parts, Python first to clean up native resources.
        // Forward the context: plugin teardown routinely guards on
        // `ctx?.pluginId` (slash-command unregistration, interval cleanup),
        // so dropping it here would silently no-op both halves.
        if (pythonDefinition?.deactivate) {
          await pythonDefinition.deactivate(ctx)
        }
        if (frontendDefinition?.deactivate) {
          await frontendDefinition.deactivate(ctx)
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
   *
   * The fallback chain only covers *transport* failures — "this path could not
   * be reached this way". A `PluginEvaluationError` means the opposite: the
   * code was fetched and then threw. Retrying that over another transport
   * fetches the same bytes and fails the same way, so it is rethrown instead.
   * Swallowing it would replace an author's actionable diagnostic (an
   * unavailable `require`, a syntax error) with a blob-URL script tag that
   * never resolves.
   */
  private async importModule(modulePath: string): Promise<unknown> {
    // Strategy 1: Try Tauri asset protocol if available
    try {
      const { convertFileSrc } = await import("@tauri-apps/api/core")
      const assetUrl = convertFileSrc(modulePath)
      return await this.loadViaFetch(assetUrl, modulePath)
    } catch (error) {
      if (error instanceof PluginEvaluationError) throw error
      // Tauri not available or convertFileSrc failed
    }

    // Strategy 2: Try fetch + eval with file:// protocol or direct path
    try {
      return await this.loadViaFetch(modulePath, modulePath)
    } catch (error) {
      if (error instanceof PluginEvaluationError) throw error
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
    await primeSharedModules()
    return this.evaluatePluginCode(code, originalPath)
  }

  /**
   * Evaluate a CJS plugin bundle.
   *
   * `require` resolves the host's shared-module whitelist (React and friends)
   * and throws for everything else — see `shared-modules.ts` for why sharing
   * React is load-bearing rather than a convenience. Callers must have awaited
   * `primeSharedModules()` first: `require` is synchronous, so the instances
   * have to already be in hand by the time the bundle runs.
   */
  private evaluatePluginCode(code: string, originalPath: string): unknown {
    assertNoHostPrivateImports(code, originalPath)

    // Create a module-like environment for the plugin
    const pluginExports: Record<string, unknown> = {}
    const pluginModule: { exports: Record<string, unknown> } = { exports: pluginExports }

    // Wrap the plugin code in a function to provide module/exports
    const wrappedCode = `(function(module, exports, require) { ${code} })`

    try {
      const factory = (0, eval)(wrappedCode)
      factory(pluginModule, pluginExports, createPluginRequire(originalPath))

      // Return either module.exports or the exports object
      return pluginModule.exports !== pluginExports ? pluginModule.exports : pluginExports
    } catch (error) {
      throw new PluginEvaluationError(
        `Failed to evaluate plugin code from ${originalPath}: ${error}`,
        error
      )
    }
  }

  private async importInstalledEntry(
    pluginId: string,
    pluginRoot: string,
    relativeEntry: string,
    absolutePath: string
  ): Promise<unknown> {
    if (pluginRoot.startsWith("builtin://")) {
      const restoredExports = this.loadedModules.get(pluginId)?.exports
      if (restoredExports) return restoredExports
      return this.importModule(absolutePath)
    }
    if (!isTauri()) {
      return this.frontendImporter
        ? this.frontendImporter(absolutePath, pluginId)
        : this.importModule(absolutePath)
    }
    const { invoke } = await import("@tauri-apps/api/core")
    const code = await invoke<string>("plugin_read_entry", {
      pluginId,
      pluginPath: pluginRoot,
      entry: relativeEntry,
    })
    await primeSharedModules()
    return this.evaluatePluginCode(code, absolutePath)
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
   * Unload a plugin module. Awaits the per-runtime teardown (WASM /
   * VSCode) with a timeout so the caller (`disablePlugin` /
   * `uninstallPlugin`) can be confident the next activation starts
   * from a clean slate. On timeout or failure, the call is dropped
   * into the background (no JS-side cancellation available), the
   * failure is recorded via `recordSilentFailure`, and the plugin id
   * is marked dirty via `dirtyTeardowns`.
   *
   * The `loadedModules` and `loadingPromises` entries are cleared
   * unconditionally — once the unload starts the plugin is no longer
   * usable, regardless of whether the runtime call resolved.
   */
  async unload(pluginId: string): Promise<void> {
    const entry = this.loadedModules.get(pluginId)
    const manifestType = entry?.definition?.manifest?.type

    if (manifestType === "wasm") {
      await this.runTeardown(
        pluginId,
        manifestType,
        "loader.unloadWasmPlugin",
        () => unloadWasmPlugin(pluginId, entry?.runtimeGeneration),
        entry?.runtimeGeneration
      )
    } else if (manifestType === "vscode-extension") {
      await this.runTeardown(
        pluginId,
        manifestType,
        "loader.unloadVscodeExtension",
        () => unloadVscodeExtension(pluginId, entry?.runtimeGeneration),
        entry?.runtimeGeneration
      )
    }

    this.loadedModules.delete(pluginId)
    this.loadingPromises.delete(pluginId)
  }

  private async runTeardown(
    pluginId: string,
    manifestType: string,
    site: string,
    runner: () => Promise<void>,
    runtimeGeneration?: string
  ): Promise<boolean> {
    try {
      await withTimeout(runner(), this.teardownTimeoutMs, site)
      this.dirtyTeardowns.delete(pluginId)
      return true
    } catch (error) {
      const reason: DirtyTeardownReason = error instanceof TimeoutError ? "timeout" : "error"
      const message = error instanceof Error ? error.message : String(error)
      this.dirtyTeardowns.set(pluginId, {
        reason,
        manifestType,
        at: Date.now(),
        message,
        runtimeGeneration,
      })
      recordSilentFailure(
        pluginId,
        {
          site,
          message:
            reason === "timeout"
              ? `${manifestType} unload exceeded ${this.teardownTimeoutMs}ms — abandoned`
              : `Failed to unload ${manifestType} plugin during teardown`,
          expected: false,
        },
        error
      )
      return false
    }
  }

  async recoverDirtyTeardown(pluginId: string): Promise<boolean> {
    const dirty = this.dirtyTeardowns.get(pluginId)
    if (!dirty) return true
    if (dirty.manifestType === "wasm") {
      return this.runTeardown(pluginId, dirty.manifestType, "loader.recoverWasmPlugin", () =>
        unloadWasmPlugin(pluginId, dirty.runtimeGeneration)
      )
    }
    if (dirty.manifestType === "vscode-extension") {
      return this.runTeardown(
        pluginId,
        dirty.manifestType,
        "loader.recoverVscodeExtension",
        () => unloadVscodeExtension(pluginId, dirty.runtimeGeneration),
        dirty.runtimeGeneration
      )
    }
    return false
  }

  /**
   * Returns the dirty-teardown record for a plugin, or `null` when the
   * previous unload completed cleanly. Manager / re-load policy can
   * consult this before resurrecting a plugin.
   */
  getDirtyTeardown(pluginId: string): DirtyTeardownRecord | null {
    return this.dirtyTeardowns.get(pluginId) ?? null
  }

  /**
   * Clear the dirty marker for a plugin (call after a successful
   * forced re-load, or when the user explicitly accepts the risk).
   */
  clearDirtyTeardown(pluginId: string): boolean {
    return this.dirtyTeardowns.delete(pluginId)
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

  getRuntimeGeneration(pluginId: string): string | undefined {
    return this.loadedModules.get(pluginId)?.runtimeGeneration
  }

  /**
   * Import a secondary plugin entry module (e.g. an `ocrProviders[].entry`
   * file) by absolute path, reusing the same cross-runtime strategy as the
   * main-module loader (Tauri asset protocol → fetch+eval → script tag).
   * Used by the module-bridge capabilities (`module-bridge-map.ts`) as the
   * default `importer` so lazy-factory entries resolve identically to the
   * plugin's main bundle. Tests inject their own importer and never hit this.
   */
  async importEntry(
    absolutePath: string,
    pluginId?: string,
    pluginRoot?: string
  ): Promise<Record<string, unknown>> {
    if (!pluginId || !pluginRoot) {
      return (await this.importModule(absolutePath)) as Record<string, unknown>
    }
    const normalizedRoot = pluginRoot.replace(/[\\/]+$/, "")
    const prefix = `${normalizedRoot}/`
    if (!absolutePath.startsWith(prefix)) {
      throw new Error(`Plugin entry is outside the declared root: ${absolutePath}`)
    }
    const relativeEntry = absolutePath.slice(prefix.length)
    return (await this.importInstalledEntry(
      pluginId,
      pluginRoot,
      relativeEntry,
      absolutePath
    )) as Record<string, unknown>
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
