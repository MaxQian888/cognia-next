/**
 * Plugin Manager - Core plugin lifecycle management
 *
 * Handles plugin discovery, loading, enabling, disabling, and unloading.
 * Coordinates with Tauri backend for Python plugin support via PyO3.
 */

import { invoke } from "@tauri-apps/api/core"
import { usePluginStore } from "@/stores/plugin"
import type {
  ExtensionCompatibilityDiagnostic,
  ExtensionDescriptor,
  ExtensionRegistration,
  A2UITemplateDef,
  Plugin,
  PluginA2UIComponent,
  PluginInstallRootKind,
  PluginManifest,
  PluginSource,
  PluginContext,
  PluginHooks,
  PluginCommand,
  PluginPermission,
  PluginActivationEvent,
  PluginManifestCommandDef,
  PluginTool,
  PluginToolContext,
  PluginRuntimeProfile,
  PluginVerificationAction,
  PluginVerificationDiagnostic,
  PluginVerificationSnapshot,
  PluginVerificationStage,
} from "@/types/plugin"
import { PluginLoader } from "@/lib/plugin/core/loader"
import { PluginRegistry } from "@/lib/plugin/core/registry"
import { createFullPluginContext } from "@/lib/plugin/core/context"
import { buildExtensionDescriptor } from "@/lib/plugin/core/descriptor"
import { createPluginA2UIBridge, type PluginA2UIBridge } from "@/lib/plugin/bridge/a2ui-bridge"
import { PluginThemesBridge } from "@/lib/plugin/bridge/themes-bridge"
import { PluginLifecycleHooks, getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import { clearPluginExtensions } from "@/lib/plugin/api/extension-api"
import { getPluginExtensions, restorePluginExtensions } from "@/lib/plugin/api/extension-api"
import {
  evaluatePluginCompatibility,
  type CompatibilityDiagnostic,
  type CompatibilityRuntime,
} from "@/lib/plugin/core/compatibility"
import { loggers } from "@/lib/plugin/core/logger"
import { createPluginVerificationSnapshot } from "@/lib/plugin/core/verification"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { canUseTauriInvoke } from "@/lib/native/utils"
import {
  validateActivationEvent,
  validateHookPoint,
  type PluginPointGovernanceMode,
} from "@/lib/plugin/contracts/plugin-points"
import {
  recordPluginPointDiagnostic,
  recordSilentFailure,
} from "@/lib/plugin/contracts/diagnostics-store"
import { getBrowserBuiltinRegistry } from "./browser-builtin-registry"
import {
  registerMcpServerPreset,
  unregisterMcpServerPresetsByPlugin,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import {
  registerNativeAnthropicTool,
  unregisterNativeAnthropicToolsByPlugin,
} from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { registerSkill, unregisterSkillsByPlugin } from "@/lib/plugin/registries/skill-registry"
import {
  registerPreset as registerExternalAgentPresetOverlay,
  unregisterPresetsByPlugin as unregisterExternalAgentPresetsByPlugin,
} from "@/lib/ai/agent/external/presets"

// =============================================================================
// Governance mode resolution
// =============================================================================

/**
 * Resolve the effective plugin-point governance mode, honoring the
 * `COGNIA_PLUGIN_POINT_GOVERNANCE_MODE` env override when present so the flip
 * between warn and block can be reversed without a code deploy.
 */
export function resolveGovernanceMode(
  configured?: PluginPointGovernanceMode
): PluginPointGovernanceMode {
  const fromEnv =
    typeof process !== "undefined" ? process.env?.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE : undefined
  if (fromEnv === "warn" || fromEnv === "block") {
    return fromEnv
  }
  return configured || "warn"
}

// =============================================================================
// Types
// =============================================================================

export interface PluginManagerConfig {
  pluginDirectory: string
  runtimeProfile?: PluginRuntimeProfile
  enablePython?: boolean
  pythonPath?: string
  autoEnable?: boolean
  sandboxed?: boolean
  hostVersion?: string
  compatibilityMode?: "warn" | "block"
  pluginPointGovernanceMode?: PluginPointGovernanceMode
}

interface DiscoveredPlugin {
  manifest: PluginManifest
  path: string
  source: PluginSource
  descriptor?: ExtensionDescriptor
}

interface RuntimePluginState {
  manifest: PluginManifest
  status: Plugin["status"]
  path: string
  source?: PluginSource
  installRootKind?: PluginInstallRootKind
  compatibilityDiagnostics?: ExtensionCompatibilityDiagnostic[]
  config?: Record<string, unknown>
}

interface RuntimePluginSnapshotEntry {
  plugin: RuntimePluginState
  grantedPermissions?: string[]
}

type PluginActivationRuntimeEvent = "startup" | `onCommand:${string}` | `onTool:${string}`

interface PluginDiscoveryProjection {
  source: PluginSource
  installRootKind?: PluginInstallRootKind
  compatibilityDiagnostics: ExtensionCompatibilityDiagnostic[]
  descriptor: ExtensionDescriptor
}

interface ParsedActivationSpec {
  startup: boolean
  commandEvents: string[]
  toolEvents: string[]
  rawEvents: PluginActivationEvent[]
}

interface PluginRuntimeRollbackSnapshot {
  status: Plugin["status"]
  context?: PluginContext
  hooks?: PluginHooks
  tools: PluginTool[]
  components: PluginA2UIComponent[]
  templates: A2UITemplateDef[]
  extensions: ExtensionRegistration[]
  permissions: PluginPermission[]
  definition?: import("@/types/plugin").PluginDefinition
  moduleExports?: Record<string, unknown>
}

/** Python runtime information */
export interface PythonRuntimeInfo {
  available: boolean
  version: string | null
  plugin_count: number
  total_calls: number
  total_execution_time_ms: number
  failed_calls: number
}

/** Python plugin information */
export interface PythonPluginInfo {
  plugin_id: string
  tool_count: number
  hook_count: number
}

// =============================================================================
// Plugin Manager Singleton
// =============================================================================

let pluginManagerInstance: PluginManager | null = null

export function getPluginManager(): PluginManager {
  if (!pluginManagerInstance) {
    throw new Error("Plugin manager not initialized. Call initializePluginManager first.")
  }
  return pluginManagerInstance
}

export async function initializePluginManager(config: PluginManagerConfig): Promise<PluginManager> {
  if (pluginManagerInstance) {
    return pluginManagerInstance
  }

  pluginManagerInstance = new PluginManager(config)
  await pluginManagerInstance.initialize()
  return pluginManagerInstance
}

// =============================================================================
// Plugin Manager Class
// =============================================================================

export class PluginManager {
  private config: PluginManagerConfig
  private loader: PluginLoader
  private registry: PluginRegistry
  private hooksManager: PluginLifecycleHooks
  private a2uiBridge: PluginA2UIBridge | null = null
  private themesBridge: PluginThemesBridge | null = null
  private contexts: Map<string, PluginContext> = new Map()
  private registeredSlashCommandsByPlugin: Map<string, string[]> = new Map()
  private activationInFlight: Set<string> = new Set()
  private warnedActivationEvents: Set<string> = new Set()
  private initialized = false
  private compatibilityMode: "warn" | "block"
  private pluginPointGovernanceMode: PluginPointGovernanceMode
  private compatibilityRuntime: CompatibilityRuntime
  private runtimeProfile: PluginRuntimeProfile

  constructor(config: PluginManagerConfig) {
    this.config = config
    this.loader = new PluginLoader()
    this.registry = new PluginRegistry()
    this.hooksManager = getPluginLifecycleHooks()
    this.compatibilityMode = config.compatibilityMode || "warn"
    this.pluginPointGovernanceMode = resolveGovernanceMode(config.pluginPointGovernanceMode)
    this.runtimeProfile = config.runtimeProfile || "tauri"
    this.compatibilityRuntime = {
      cogniaVersion: config.hostVersion || "0.1.0",
      nodeVersion: typeof process !== "undefined" ? process.versions?.node : undefined,
    }
  }

  private ensureA2UIBridge(): PluginA2UIBridge {
    if (!this.a2uiBridge) {
      this.a2uiBridge = createPluginA2UIBridge({
        registry: this.registry,
        hooksManager: this.hooksManager,
        contextResolver: (pluginId: string) => this.contexts.get(pluginId),
      })
    }
    return this.a2uiBridge
  }

  private ensureThemesBridge(): PluginThemesBridge {
    if (!this.themesBridge) {
      this.themesBridge = new PluginThemesBridge()
    }
    return this.themesBridge
  }

  private buildDiscoveryProjection(
    manifest: PluginManifest,
    path: string,
    source: PluginSource,
    compatibilityDiagnostics: CompatibilityDiagnostic[] | ExtensionCompatibilityDiagnostic[] = [],
    observedSources: PluginSource[] = [],
    installRootKind?: PluginInstallRootKind
  ): PluginDiscoveryProjection {
    const normalizedCompatibilityDiagnostics: ExtensionCompatibilityDiagnostic[] =
      compatibilityDiagnostics.map((diagnostic) => ({
        ...diagnostic,
        field: diagnostic.field || undefined,
      }))

    return {
      source,
      installRootKind,
      compatibilityDiagnostics: normalizedCompatibilityDiagnostics,
      descriptor: buildExtensionDescriptor({
        manifest,
        source,
        path,
        pluginDirectory: this.config.pluginDirectory,
        installRootKind,
        observedSources,
        compatibilityDiagnostics: normalizedCompatibilityDiagnostics,
      }),
    }
  }

  private collectObservedSources(existing?: Plugin): PluginSource[] {
    if (!existing) return []
    const fromDescriptor = existing.descriptor?.identity.observedSources || []
    return fromDescriptor.length > 0 ? [...fromDescriptor] : [existing.source]
  }

  private extractCapabilityContractDiagnostics(
    diagnostics: Array<{
      code: string
      severity: "error" | "warning"
      message: string
      field?: string
      hint?: string
    }> = []
  ): ExtensionCompatibilityDiagnostic[] {
    return diagnostics
      .filter((diagnostic) => diagnostic.code.includes(".plugin.capability."))
      .map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        field: diagnostic.field || undefined,
        hint: diagnostic.hint,
      }))
  }

  private collectRuntimeProfileDiagnostics(
    manifest: PluginManifest
  ): ExtensionCompatibilityDiagnostic[] {
    if (this.runtimeProfile !== "browser") {
      return []
    }

    const compatibility = manifest.runtimeCompatibility?.browser
    if (!compatibility) {
      return [
        {
          code: "runtime.browser.unsupported",
          severity: "error",
          message: `Plugin ${manifest.id} does not declare browser runtime compatibility.`,
          hint: "Add browser runtime compatibility metadata before enabling this plugin in browser mode.",
        },
      ]
    }

    if (compatibility.availability === "supported") {
      return []
    }

    if (compatibility.availability === "degraded") {
      return [
        {
          code: "runtime.browser.degraded",
          severity: "warning",
          message:
            compatibility.reason ||
            `Plugin ${manifest.id} is only partially supported in browser runtime.`,
          hint: compatibility.entrypoint
            ? `Browser bundle entrypoint: ${compatibility.entrypoint}`
            : undefined,
        },
      ]
    }

    return [
      {
        code: "runtime.browser.unsupported",
        severity: "error",
        message: compatibility.reason || `Plugin ${manifest.id} is blocked in browser runtime.`,
        hint: compatibility.entrypoint
          ? `Declared browser entrypoint: ${compatibility.entrypoint}`
          : undefined,
      },
    ]
  }

  private recordPluginVerification(
    pluginId: string,
    params: {
      status: Plugin["status"]
      action: PluginVerificationAction
      stage: PluginVerificationStage
      successful: boolean
      resolvedVersion?: string
      diagnostics?: PluginVerificationDiagnostic[]
      metadata?: Record<string, unknown>
    }
  ): PluginVerificationSnapshot | undefined {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin) return undefined

    const snapshot = createPluginVerificationSnapshot({
      pluginId,
      source: plugin.source,
      installRootKind: plugin.descriptor?.installRoot.kind,
      declaredCapabilities: plugin.manifest.capabilities,
      status: params.status,
      verificationStage: params.stage,
      lastVerifiedAction: params.action,
      verifiedAt: new Date().toISOString(),
      lastSuccessfulAt:
        plugin.lastKnownGoodVerification?.lastSuccessfulAt ||
        plugin.verificationSnapshot?.lastSuccessfulAt,
      resolvedVersion: params.resolvedVersion || plugin.manifest.version,
      diagnostics: params.diagnostics,
      metadata: params.metadata,
      successful: params.successful,
    })

    const verificationStore = store as typeof store & {
      setPluginVerificationSnapshot?: (
        targetPluginId: string,
        verification: PluginVerificationSnapshot
      ) => void
      setPluginError?: (targetPluginId: string, error: string | null) => void
    }

    verificationStore.setPluginVerificationSnapshot?.(pluginId, snapshot)
    if (params.successful) {
      verificationStore.setPluginError?.(pluginId, null)
    }
    return snapshot
  }

  private capturePluginRuntimeRollbackSnapshot(
    pluginId: string
  ): PluginRuntimeRollbackSnapshot | undefined {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin) return undefined

    return {
      status: plugin.status,
      context: this.contexts.get(pluginId),
      hooks: plugin.hooks,
      tools: [...(plugin.tools || [])],
      components: [...(plugin.components || [])],
      templates: this.registry.getTemplatesByPlugin(pluginId),
      extensions: getPluginExtensions(pluginId),
      permissions: [...(plugin.manifest.permissions || [])],
      definition: this.loader.getDefinition(pluginId),
      moduleExports: this.loader.getModuleExports(pluginId),
    }
  }

  private async restorePluginRuntimeRollbackSnapshot(
    pluginId: string,
    snapshot?: PluginRuntimeRollbackSnapshot
  ): Promise<void> {
    if (!snapshot) return

    const store = usePluginStore.getState() as typeof usePluginStore.getState extends () => infer T
      ? T & {
          setPluginStatus?: (targetPluginId: string, status: Plugin["status"]) => void
          registerPluginHooks?: (targetPluginId: string, hooks: PluginHooks) => void
          registerPluginTool?: (targetPluginId: string, tool: PluginTool) => void
        }
      : never

    if (snapshot.definition) {
      this.loader.restoreModule(pluginId, snapshot.definition, snapshot.moduleExports || {})
    }

    if (snapshot.context) {
      this.contexts.set(pluginId, snapshot.context)
    }

    if (snapshot.hooks) {
      store.registerPluginHooks?.(pluginId, snapshot.hooks)
      this.hooksManager.registerHooks(pluginId, snapshot.hooks)
    }

    if (snapshot.permissions.length > 0) {
      this.registerPluginPermissions(pluginId, snapshot.permissions)
    }

    if (snapshot.components.length > 0 || snapshot.templates.length > 0) {
      const bridge = this.ensureA2UIBridge()
      for (const component of snapshot.components) {
        bridge.registerComponent(pluginId, component)
      }
      for (const template of snapshot.templates) {
        bridge.registerTemplate(pluginId, template)
      }
    }

    for (const tool of snapshot.tools) {
      this.registry.registerTool(pluginId, tool)
      store.registerPluginTool?.(pluginId, tool)
    }

    restorePluginExtensions(pluginId, snapshot.extensions)
    await this.registerPluginContributions(pluginId)

    store.setPluginStatus?.(pluginId, snapshot.status)
    if (
      snapshot.status === "installed" ||
      snapshot.status === "loaded" ||
      snapshot.status === "enabled" ||
      snapshot.status === "disabled"
    ) {
      await this.syncBackendStatus(pluginId, snapshot.status)
    }
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return

    const store = usePluginStore.getState()

    // Initialize store with plugin directory
    await store.initialize(this.config.pluginDirectory)

    // Initialize Python runtime if enabled
    if (this.config.enablePython) {
      await this.initializePythonRuntime()
    }

    // Scan for plugins
    await this.scanPlugins()

    // Sync persisted runtime status from backend when available.
    await this.syncRuntimeState()

    // Restore plugin runtime state from persisted config and activation rules.
    await this.restorePluginStates()

    // Trigger startup lazy activation.
    await this.handleActivationEvent("startup")

    this.initialized = true
  }

  private async initializePythonRuntime(): Promise<void> {
    try {
      await invoke("plugin_python_initialize", {
        pythonPath: this.config.pythonPath,
      })
      const runtime = await this.getPythonRuntimeInfo().catch(() => null)
      if (runtime?.version) {
        this.compatibilityRuntime.pythonVersion = runtime.version
      }
    } catch (error) {
      loggers.manager.error("Failed to initialize Python runtime:", error)
      // Continue without Python support
    }
  }

  private applyCompatibilityPolicy(
    manifest: PluginManifest,
    sourceContext: string
  ): { blocked: boolean; diagnostics: CompatibilityDiagnostic[] } {
    const result = evaluatePluginCompatibility(manifest, this.compatibilityRuntime)
    if (result.diagnostics.length === 0) {
      return { blocked: false, diagnostics: [] }
    }

    const errors = result.diagnostics.filter((entry) => entry.severity === "error")
    const warnings = result.diagnostics.filter((entry) => entry.severity === "warning")

    if (warnings.length > 0) {
      loggers.manager.warn(
        `[plugin:${manifest.id}] compatibility warnings in ${sourceContext}:`,
        warnings
      )
    }

    if (errors.length > 0) {
      if (this.compatibilityMode === "block") {
        loggers.manager.error(
          `[plugin:${manifest.id}] compatibility blocked in ${sourceContext}:`,
          errors
        )
        return { blocked: true, diagnostics: result.diagnostics }
      }

      loggers.manager.warn(
        `[plugin:${manifest.id}] compatibility errors (warn mode) in ${sourceContext}:`,
        errors
      )
    }

    return { blocked: false, diagnostics: result.diagnostics }
  }

  private async restorePluginStates(): Promise<void> {
    const store = usePluginStore.getState()
    const plugins = Object.values(store.plugins)

    for (const plugin of plugins) {
      if (
        plugin.status === "installed" &&
        (this.config.autoEnable || this.shouldActivateOnStartup(plugin.manifest))
      ) {
        try {
          await this.enablePlugin(plugin.manifest.id)
        } catch (error) {
          loggers.manager.error(`Failed to restore plugin ${plugin.manifest.id}:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Plugin Discovery
  // ===========================================================================

  async scanPlugins(): Promise<DiscoveredPlugin[]> {
    if (this.runtimeProfile === "browser") {
      return this.scanBrowserBuiltins()
    }

    const discovered: DiscoveredPlugin[] = []
    const store = usePluginStore.getState()

    try {
      // Scan local plugin directory via Tauri
      const localPlugins = await invoke<
        Array<{
          manifest: PluginManifest
          path: string
          source?: PluginSource
          installRootKind?: PluginInstallRootKind
        }>
      >("plugin_scan_directory", {
        directory: this.config.pluginDirectory,
      })

      for (const entry of localPlugins) {
        const { manifest, path } = entry
        // Validate manifest
        const validation = validatePluginManifest(manifest, {
          governanceMode: this.pluginPointGovernanceMode,
        })
        if (!validation.valid) {
          loggers.manager.warn(
            `Invalid plugin manifest at ${path}:`,
            validation.diagnostics || validation.errors
          )
          continue
        }

        const compatibility = this.applyCompatibilityPolicy(manifest, `scan:${path}`)
        if (compatibility.blocked) {
          continue
        }

        const capabilityContractDiagnostics = this.extractCapabilityContractDiagnostics(
          validation.diagnostics || []
        )

        if (!(await this.verifyPluginSignature(path, manifest.id))) {
          loggers.manager.warn(`Signature verification failed for plugin ${manifest.id}`)
          continue
        }

        const existing = store.plugins[manifest.id]
        const projection = this.buildDiscoveryProjection(
          manifest,
          path,
          entry.source || "local",
          [...capabilityContractDiagnostics, ...compatibility.diagnostics],
          this.collectObservedSources(existing),
          entry.installRootKind
        )

        store.discoverPlugin(manifest, projection.source, path, {
          installRootKind: projection.installRootKind,
          compatibilityDiagnostics: projection.compatibilityDiagnostics,
          descriptor: projection.descriptor,
        })

        if (!existing) {
          await store.installPlugin(manifest.id)
        }

        this.registerPluginPermissions(manifest.id, manifest.permissions || [])

        discovered.push({
          manifest,
          path,
          source: projection.source,
          descriptor: projection.descriptor,
        })
      }
    } catch (error) {
      loggers.manager.error("Failed to scan plugins:", error)
    }

    return discovered
  }

  private async scanBrowserBuiltins(): Promise<DiscoveredPlugin[]> {
    const discovered: DiscoveredPlugin[] = []
    const store = usePluginStore.getState()

    for (const entry of getBrowserBuiltinRegistry()) {
      const manifest = entry.manifest
      const validation = validatePluginManifest(manifest, {
        governanceMode: this.pluginPointGovernanceMode,
      })
      if (!validation.valid) {
        loggers.manager.warn(
          `Invalid browser builtin manifest for ${manifest.id}:`,
          validation.diagnostics || validation.errors
        )
        continue
      }

      const compatibility = this.applyCompatibilityPolicy(manifest, `browser:${manifest.id}`)
      const capabilityContractDiagnostics = this.extractCapabilityContractDiagnostics(
        validation.diagnostics || []
      )
      const runtimeDiagnostics = [
        ...entry.compatibilityDiagnostics,
        ...this.collectRuntimeProfileDiagnostics(manifest),
      ]

      const existing = store.plugins[manifest.id]
      const projection = this.buildDiscoveryProjection(
        manifest,
        entry.path,
        "builtin",
        [...capabilityContractDiagnostics, ...compatibility.diagnostics, ...runtimeDiagnostics],
        this.collectObservedSources(existing),
        "builtin"
      )

      store.discoverPlugin(manifest, "builtin", entry.path, {
        installRootKind: "builtin",
        compatibilityDiagnostics: projection.compatibilityDiagnostics,
        descriptor: projection.descriptor,
      })

      if (!existing) {
        await store.installPlugin(manifest.id)
      }

      this.registerPluginPermissions(manifest.id, manifest.permissions || [])

      discovered.push({
        manifest,
        path: entry.path,
        source: "builtin",
        descriptor: projection.descriptor,
      })
    }

    return discovered
  }

  // ===========================================================================
  // Plugin Lifecycle
  // ===========================================================================

  async installPlugin(
    source: string,
    options?: {
      type?: "local" | "git" | "marketplace"
      name?: string
    }
  ): Promise<Plugin> {
    const store = usePluginStore.getState()
    const type = options?.type || "local"

    try {
      // Install via Tauri backend
      const result = await invoke<{
        manifest: PluginManifest
        path: string
        source?: PluginSource
        installRootKind?: PluginInstallRootKind
      }>("plugin_install", {
        source,
        installType: type,
        pluginDir: this.config.pluginDirectory,
      })

      // Validate manifest
      const validation = validatePluginManifest(result.manifest, {
        governanceMode: this.pluginPointGovernanceMode,
      })
      if (!validation.valid) {
        throw new Error(`Invalid plugin manifest: ${validation.errors.join(", ")}`)
      }

      const compatibility = this.applyCompatibilityPolicy(result.manifest, `install:${type}`)
      if (compatibility.blocked) {
        const messages = compatibility.diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => `${item.code}: ${item.message}`)
        throw new Error(`Incompatible plugin manifest: ${messages.join("; ")}`)
      }

      const capabilityContractDiagnostics = this.extractCapabilityContractDiagnostics(
        validation.diagnostics || []
      )

      // Verify signature
      if (!(await this.verifyPluginSignature(result.path, result.manifest.id))) {
        throw new Error(`Signature verification failed for plugin ${result.manifest.id}`)
      }

      const projection = this.buildDiscoveryProjection(
        result.manifest,
        result.path,
        result.source || (type as PluginSource),
        [...capabilityContractDiagnostics, ...compatibility.diagnostics],
        this.collectObservedSources(store.plugins[result.manifest.id]),
        result.installRootKind
      )

      // Register with store
      store.discoverPlugin(result.manifest, projection.source, result.path, {
        installRootKind: projection.installRootKind,
        compatibilityDiagnostics: projection.compatibilityDiagnostics,
        descriptor: projection.descriptor,
      })
      await store.installPlugin(result.manifest.id)
      this.recordPluginVerification(result.manifest.id, {
        status: "installed",
        action: "install",
        stage: "installation",
        successful: true,
        resolvedVersion: result.manifest.version,
      })

      this.registerPluginPermissions(result.manifest.id, result.manifest.permissions || [])

      return store.plugins[result.manifest.id]
    } catch (error) {
      const existingPluginId =
        options?.name || (typeof source === "string" && store.plugins[source] ? source : undefined)
      if (existingPluginId && store.plugins[existingPluginId]) {
        this.recordPluginVerification(existingPluginId, {
          status: "error",
          action: "install",
          stage: "installation",
          successful: false,
          diagnostics: [
            {
              code: "plugin.install.failed",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        })
      }
      throw new Error(`Failed to install plugin: ${error}`)
    }
  }

  async loadPlugin(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    if (
      this.loader.isLoaded(pluginId) &&
      (plugin.status === "loaded" || plugin.status === "enabled")
    ) {
      return
    }

    try {
      const validation = validatePluginManifest(plugin.manifest, {
        governanceMode: this.pluginPointGovernanceMode,
      })
      if (!validation.valid) {
        throw new Error(`Invalid plugin manifest: ${validation.errors.join(", ")}`)
      }

      const compatibility = this.applyCompatibilityPolicy(plugin.manifest, "load")
      if (compatibility.blocked) {
        const messages = compatibility.diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => `${item.code}: ${item.message}`)
        throw new Error(`Incompatible plugin: ${messages.join("; ")}`)
      }

      const runtimeDiagnostics = this.collectRuntimeProfileDiagnostics(plugin.manifest)
      const blockingRuntimeDiagnostics = runtimeDiagnostics.filter(
        (item) => item.severity === "error"
      )
      if (blockingRuntimeDiagnostics.length > 0) {
        throw new Error(
          `Runtime incompatible plugin: ${blockingRuntimeDiagnostics
            .map((item) => `${item.code}: ${item.message}`)
            .join("; ")}`
        )
      }

      if (!(await this.verifyPluginSignature(plugin.path, pluginId))) {
        throw new Error(`Signature verification failed for plugin ${pluginId}`)
      }

      this.registerPluginPermissions(pluginId, plugin.manifest.permissions || [])

      // Load the plugin module
      const definition = await this.loader.load(plugin)
      definition.activation = this.parseActivationSpec(plugin.manifest)

      // Check if debug mode is enabled for this plugin
      const enableDebug =
        plugin.config?.debug === true ||
        (process.env.NODE_ENV === "development" && plugin.config?.devMode === true)

      // Create plugin context with optional debug instrumentation
      const context = createFullPluginContext(plugin, this, { enableDebug })
      this.contexts.set(pluginId, context)

      // Activate the plugin
      let hooks: PluginHooks | undefined
      if (typeof definition.activate === "function") {
        hooks = (await definition.activate(context)) || undefined
      }

      // Register hooks
      if (hooks) {
        this.validateHookDeclarations(pluginId, hooks)
        store.registerPluginHooks(pluginId, hooks)
        this.hooksManager.registerHooks(pluginId, hooks)
      }

      if (plugin.manifest.type !== "frontend") {
        await this.loadPythonPlugin(pluginId)
      }

      // Update store status
      await store.loadPlugin(pluginId, { viaManager: false })
      await this.syncBackendStatus(pluginId, "loaded")
      await this.hooksManager.dispatchOnLoad(pluginId)
      this.recordPluginVerification(pluginId, {
        status: "loaded",
        action: "load",
        stage: "activation",
        successful: true,
      })
    } catch (error) {
      store.setPluginError(pluginId, String(error))
      this.recordPluginVerification(pluginId, {
        status: "error",
        action: "load",
        stage: "activation",
        successful: false,
        diagnostics: [
          {
            code: "plugin.load.failed",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      })
      throw error
    }
  }

  async enablePlugin(pluginId: string, reason: string = "manual"): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    if (plugin.status === "enabled") {
      return
    }

    try {
      // Load first when not currently active in runtime.
      if (
        plugin.status === "installed" ||
        plugin.status === "disabled" ||
        !this.loader.isLoaded(pluginId)
      ) {
        await this.loadPlugin(pluginId)
      }

      // Enable the plugin
      await store.enablePlugin(pluginId, { viaManager: false })

      // Register plugin contributions
      await this.registerPluginContributions(pluginId)

      await this.syncBackendStatus(pluginId, "enabled")
      this.recordPluginVerification(pluginId, {
        status: "enabled",
        action: "enable",
        stage: "activation",
        successful: true,
        metadata: { reason },
      })
      loggers.manager.debug(`[plugin:${pluginId}] enabled (${reason})`)
    } catch (error) {
      store.setPluginError(pluginId, String(error))
      this.recordPluginVerification(pluginId, {
        status: "error",
        action: "enable",
        stage: "activation",
        successful: false,
        diagnostics: [
          {
            code: "plugin.enable.failed",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        metadata: { reason },
      })
      throw error
    }
  }

  async disablePlugin(pluginId: string, reason: string = "manual"): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    if (plugin.status !== "enabled") {
      return
    }

    const rollbackSnapshot = this.capturePluginRuntimeRollbackSnapshot(pluginId)

    try {
      // Fully deactivate runtime resources for deterministic cleanup.
      await this.deactivatePluginRuntime(pluginId, { unloadModule: true })

      // Unregister contributions after runtime deactivation.
      await this.unregisterPluginContributions(pluginId)

      // Disable in store
      await store.disablePlugin(pluginId, { viaManager: false })

      this.hooksManager.unregisterHooks(pluginId)
      this.contexts.delete(pluginId)

      await this.revokePluginPermissions(pluginId, plugin.manifest.permissions || [])
      await this.syncBackendStatus(pluginId, "disabled")
      this.recordPluginVerification(pluginId, {
        status: "disabled",
        action: "disable",
        stage: "cleanup",
        successful: true,
        metadata: { reason },
      })
      loggers.manager.debug(`[plugin:${pluginId}] disabled (${reason})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.restorePluginRuntimeRollbackSnapshot(pluginId, rollbackSnapshot)
      store.setPluginError(pluginId, message)
      store.setPluginStatus?.(pluginId, rollbackSnapshot?.status || plugin.status)
      this.recordPluginVerification(pluginId, {
        status: "error",
        action: "disable",
        stage: "cleanup",
        successful: false,
        diagnostics: [
          {
            code: "plugin.disable.failed",
            severity: "error",
            message,
          },
        ],
        metadata: { reason },
      })
      loggers.manager.error(`[plugin:${pluginId}] disable failed (${reason})`, error)
      throw error
    }
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      return
    }

    const rollbackSnapshot = this.capturePluginRuntimeRollbackSnapshot(pluginId)

    try {
      // Disable first if enabled
      if (plugin.status === "enabled") {
        await this.disablePlugin(pluginId, "unload")
      } else {
        await this.deactivatePluginRuntime(pluginId, { unloadModule: true })
        await this.unregisterPluginContributions(pluginId)
      }

      // Unregister hooks
      this.hooksManager.unregisterHooks(pluginId)

      // Remove context
      this.contexts.delete(pluginId)

      // Unload from loader
      this.loader.unload(pluginId)

      // Update store
      await store.unloadPlugin(pluginId, { viaManager: false })
      await this.syncBackendStatus(pluginId, "installed")
      this.recordPluginVerification(pluginId, {
        status: "installed",
        action: "unload",
        stage: "cleanup",
        successful: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.restorePluginRuntimeRollbackSnapshot(pluginId, rollbackSnapshot)
      store.setPluginError(pluginId, message)
      store.setPluginStatus?.(pluginId, rollbackSnapshot?.status || plugin.status)
      this.recordPluginVerification(pluginId, {
        status: "error",
        action: "unload",
        stage: "cleanup",
        successful: false,
        diagnostics: [
          {
            code: "plugin.unload.failed",
            severity: "error",
            message,
          },
        ],
      })
      loggers.manager.error(`[plugin:${pluginId}] unload failed`, error)
      throw error
    }
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    const rollbackSnapshot = this.capturePluginRuntimeRollbackSnapshot(pluginId)

    try {
      // Unload first
      if (["loaded", "enabled", "disabled"].includes(plugin.status)) {
        await this.unloadPlugin(pluginId)
      }

      // Remove files via Tauri
      await invoke("plugin_uninstall", {
        pluginId,
        pluginPath: plugin.path,
      })

      // Remove from store
      await store.uninstallPlugin(pluginId, { skipFileRemoval: true, viaManager: false })

      await this.revokePluginPermissions(pluginId, plugin.manifest.permissions || [])
      getPermissionGuard().unregisterPlugin(pluginId)
      this.registeredSlashCommandsByPlugin.delete(pluginId)
      this.activationInFlight.delete(pluginId)
      this.recordPluginVerification(pluginId, {
        status: "installed",
        action: "uninstall",
        stage: "cleanup",
        successful: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.restorePluginRuntimeRollbackSnapshot(pluginId, rollbackSnapshot)
      store.setPluginError(pluginId, message)
      store.setPluginStatus?.(pluginId, rollbackSnapshot?.status || plugin.status)
      this.recordPluginVerification(pluginId, {
        status: "error",
        action: "uninstall",
        stage: "cleanup",
        successful: false,
        diagnostics: [
          {
            code: "plugin.uninstall.failed",
            severity: "error",
            message,
          },
        ],
      })
      loggers.manager.error(`[plugin:${pluginId}] uninstall failed`, error)
      throw error
    }
  }

  private async verifyPluginSignature(pluginPath: string, pluginId: string): Promise<boolean> {
    try {
      const verifier = getPluginSignatureVerifier()
      const config = verifier.getConfig()

      // Skip verification entirely if signatures are not required and untrusted plugins are allowed
      // This is the default configuration - signature backend commands may not be available
      if (!config.requireSignatures && config.allowUntrusted) {
        return true
      }

      const result = await verifier.verify(pluginPath)
      if (!result.valid) {
        loggers.manager.warn(`Signature verification failed for ${pluginId}:`, result.reason)
      }
      return result.valid
    } catch (error) {
      // If signature verification fails due to missing backend support,
      // allow loading if signatures are not strictly required
      const verifier = getPluginSignatureVerifier()
      const config = verifier.getConfig()
      if (!config.requireSignatures) {
        loggers.manager.debug(
          `Signature verification skipped for ${pluginId} (backend unavailable)`
        )
        return true
      }
      loggers.manager.warn(`Signature verification error for ${pluginId}:`, error)
      return false
    }
  }

  private registerPluginPermissions(pluginId: string, permissions: PluginPermission[]): void {
    const guard = getPermissionGuard()
    guard.registerPlugin(pluginId, permissions)
  }

  private parseActivationSpec(manifest: PluginManifest): ParsedActivationSpec {
    const rawEvents = (manifest.activationEvents || []).filter(
      (event): event is PluginActivationEvent => typeof event === "string"
    )

    const startup = Boolean(
      manifest.activateOnStartup || rawEvents.includes("startup") || rawEvents.includes("onStartup")
    )

    const commandEvents = rawEvents
      .filter((event) => event.startsWith("onCommand:"))
      .map((event) => event.slice("onCommand:".length))
      .filter(Boolean)

    const toolEvents = rawEvents
      .filter((event) => event.startsWith("onTool:") || event.startsWith("onAgentTool:"))
      .map((event) =>
        event.startsWith("onTool:")
          ? event.slice("onTool:".length)
          : event.slice("onAgentTool:".length)
      )
      .filter(Boolean)

    for (const event of rawEvents) {
      const validation = validateActivationEvent(event, {
        governanceMode: this.pluginPointGovernanceMode,
      })

      for (const diagnostic of validation.diagnostics) {
        const diagnosticKey = `${manifest.id}:${event}:${diagnostic.code}`
        if (this.warnedActivationEvents.has(diagnosticKey)) {
          continue
        }
        this.warnedActivationEvents.add(diagnosticKey)
        recordPluginPointDiagnostic(manifest.id, diagnostic)
        const message = `[plugin:${manifest.id}] ${diagnostic.message}`
        if (diagnostic.severity === "error") {
          loggers.manager.error(message)
        } else {
          loggers.manager.warn(message)
        }
      }

      if (!validation.allowed) {
        throw new Error(
          `Activation event "${event}" is blocked by plugin point governance mode "${this.pluginPointGovernanceMode}".`
        )
      }
    }

    return {
      startup,
      commandEvents,
      toolEvents,
      rawEvents,
    }
  }

  private shouldActivateOnStartup(manifest: PluginManifest): boolean {
    try {
      return this.parseActivationSpec(manifest).startup
    } catch (error) {
      loggers.manager.warn(`[plugin:${manifest.id}] startup activation evaluation failed:`, error)
      return false
    }
  }

  private matchesActivation(eventPattern: string, value: string): boolean {
    const normalizedPattern = eventPattern.trim().toLowerCase()
    const normalizedValue = value.trim().toLowerCase()
    if (normalizedPattern === "*") return true
    if (!normalizedPattern.includes("*")) {
      return normalizedPattern === normalizedValue
    }

    const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const wildcardPattern = escaped.replace(/\\\*/g, ".*")
    return new RegExp(`^${wildcardPattern}$`).test(normalizedValue)
  }

  private shouldActivateForEvent(
    manifest: PluginManifest,
    event: PluginActivationRuntimeEvent
  ): boolean {
    const spec = this.parseActivationSpec(manifest)

    if (event === "startup") {
      return spec.startup
    }

    if (event.startsWith("onCommand:")) {
      const command = event.slice("onCommand:".length)
      return spec.commandEvents.some((pattern) => this.matchesActivation(pattern, command))
    }

    const tool = event.slice("onTool:".length)
    return spec.toolEvents.some((pattern) => this.matchesActivation(pattern, tool))
  }

  async handleActivationEvent(event: PluginActivationRuntimeEvent): Promise<void> {
    const store = usePluginStore.getState()
    const plugins = Object.values(store.plugins)

    for (const plugin of plugins) {
      if (plugin.status === "enabled") {
        continue
      }

      if (!this.shouldActivateForEvent(plugin.manifest, event)) {
        continue
      }

      if (this.activationInFlight.has(plugin.manifest.id)) {
        continue
      }

      this.activationInFlight.add(plugin.manifest.id)
      try {
        await this.enablePlugin(plugin.manifest.id, `activation:${event}`)
      } catch (error) {
        loggers.manager.warn(
          `[plugin:${plugin.manifest.id}] activation failed for event "${event}":`,
          error
        )
      } finally {
        this.activationInFlight.delete(plugin.manifest.id)
      }
    }
  }

  async syncRuntimeState(): Promise<void> {
    const store = usePluginStore.getState()

    if (this.runtimeProfile === "browser" || !canUseTauriInvoke()) {
      return
    }

    try {
      const runtimeSnapshot = await invoke<RuntimePluginSnapshotEntry[]>("plugin_runtime_snapshot")
      for (const entry of runtimeSnapshot) {
        const runtime = entry.plugin
        const validation = validatePluginManifest(runtime.manifest, {
          governanceMode: this.pluginPointGovernanceMode,
        })
        if (!validation.valid) {
          loggers.manager.warn(
            `Invalid runtime manifest for ${runtime.manifest.id}:`,
            validation.diagnostics || validation.errors
          )
          continue
        }
        const capabilityContractDiagnostics = this.extractCapabilityContractDiagnostics(
          validation.diagnostics || []
        )
        const existing = store.plugins[runtime.manifest.id]
        const projection = this.buildDiscoveryProjection(
          runtime.manifest,
          runtime.path,
          runtime.source || "local",
          [...capabilityContractDiagnostics, ...(runtime.compatibilityDiagnostics || [])],
          this.collectObservedSources(existing),
          runtime.installRootKind
        )
        store.discoverPlugin(runtime.manifest, projection.source, runtime.path, {
          installRootKind: projection.installRootKind,
          compatibilityDiagnostics: projection.compatibilityDiagnostics,
          descriptor: projection.descriptor,
        })

        if (!existing) {
          await store.installPlugin(runtime.manifest.id)
        }

        if (runtime.status) {
          store.setPluginStatus(runtime.manifest.id, runtime.status)
        }

        if (runtime.config && typeof runtime.config === "object") {
          store.setPluginConfig(runtime.manifest.id, runtime.config)
        }

        const permissionUnion = new Set<PluginPermission>(runtime.manifest.permissions || [])
        for (const permission of entry.grantedPermissions || []) {
          permissionUnion.add(permission as PluginPermission)
        }
        this.registerPluginPermissions(runtime.manifest.id, Array.from(permissionUnion))
      }
      return
    } catch {
      // Fall back to legacy endpoint.
    }

    try {
      const runtimePlugins = await invoke<RuntimePluginState[]>("plugin_get_all")
      for (const runtime of runtimePlugins) {
        const validation = validatePluginManifest(runtime.manifest, {
          governanceMode: this.pluginPointGovernanceMode,
        })
        if (!validation.valid) {
          loggers.manager.warn(
            `Invalid runtime manifest for ${runtime.manifest.id}:`,
            validation.diagnostics || validation.errors
          )
          continue
        }
        const capabilityContractDiagnostics = this.extractCapabilityContractDiagnostics(
          validation.diagnostics || []
        )
        const existing = store.plugins[runtime.manifest.id]
        const projection = this.buildDiscoveryProjection(
          runtime.manifest,
          runtime.path,
          runtime.source || "local",
          [...capabilityContractDiagnostics, ...(runtime.compatibilityDiagnostics || [])],
          this.collectObservedSources(existing),
          runtime.installRootKind
        )
        store.discoverPlugin(runtime.manifest, projection.source, runtime.path, {
          installRootKind: projection.installRootKind,
          compatibilityDiagnostics: projection.compatibilityDiagnostics,
          descriptor: projection.descriptor,
        })

        if (!existing) {
          await store.installPlugin(runtime.manifest.id)
        }

        if (runtime.status) {
          store.setPluginStatus(runtime.manifest.id, runtime.status)
        }

        if (runtime.config && typeof runtime.config === "object") {
          store.setPluginConfig(runtime.manifest.id, runtime.config)
        }

        this.registerPluginPermissions(runtime.manifest.id, runtime.manifest.permissions || [])
      }
    } catch (error) {
      // Non-fatal in web mode or when backend command is unavailable.
      loggers.manager.debug("Runtime state sync skipped:", error)
    }
  }

  private async syncBackendStatus(
    pluginId: string,
    status: "installed" | "loaded" | "enabled" | "disabled" | "error"
  ): Promise<void> {
    try {
      await invoke("plugin_set_state", { pluginId, status })
    } catch (error) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.syncBackendStatus",
          message: `Failed to sync plugin status to backend (${status}).`,
          expected: !canUseTauriInvoke(),
        },
        error
      )
    }
  }

  private async revokePluginPermissions(
    pluginId: string,
    permissions: PluginPermission[]
  ): Promise<void> {
    const guard = getPermissionGuard()
    if (typeof (guard as { revokeAll?: (id: string) => void }).revokeAll === "function") {
      ;(guard as { revokeAll: (id: string) => void }).revokeAll(pluginId)
    } else {
      guard.unregisterPlugin(pluginId)
      guard.registerPlugin(pluginId, [])
    }

    const permissionSet = new Set<string>(permissions)
    try {
      const granted = await invoke<string[]>("plugin_permission_list", { pluginId })
      for (const permission of granted) {
        permissionSet.add(permission)
      }
    } catch (error) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.revokePluginPermissions.list",
          message: "Could not enumerate granted permissions; revoking declared set only.",
          expected: !canUseTauriInvoke(),
        },
        error
      )
    }

    const revokeFailures: Array<{ permission: string; error: unknown }> = []
    for (const permission of permissionSet) {
      try {
        await invoke("plugin_permission_revoke", {
          request: {
            plugin_id: pluginId,
            permission,
          },
        })
      } catch (error) {
        revokeFailures.push({ permission, error })
      }
    }
    if (revokeFailures.length > 0) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.revokePluginPermissions.revoke",
          message: `Failed to revoke ${revokeFailures.length} permission(s) on backend: ${revokeFailures
            .map((f) => f.permission)
            .join(", ")}.`,
          expected: !canUseTauriInvoke(),
        },
        revokeFailures[0].error
      )
    }
  }

  private async deactivatePluginRuntime(
    pluginId: string,
    options: { unloadModule: boolean }
  ): Promise<void> {
    const plugin = usePluginStore.getState().plugins[pluginId]

    const definition = this.loader.getDefinition(pluginId)
    if (definition?.deactivate) {
      await Promise.resolve(definition.deactivate())
    }

    if (plugin && plugin.manifest.type !== "frontend") {
      try {
        await this.unloadPythonPlugin(pluginId)
      } catch (error) {
        recordSilentFailure(
          pluginId,
          {
            site: "manager.deactivatePluginRuntime.python.unload",
            message: "Failed to unload Python plugin module.",
            expected: !canUseTauriInvoke(),
          },
          error
        )
      }
    }

    if (options.unloadModule) {
      this.loader.unload(pluginId)
    }
  }

  private toRuntimePluginCommand(
    pluginId: string,
    manifestCommand: PluginManifestCommandDef
  ): PluginCommand {
    const namespacedId = `${pluginId}.${manifestCommand.id}`
    return {
      id: namespacedId,
      name: manifestCommand.name,
      description: manifestCommand.description,
      icon: manifestCommand.icon,
      execute: async () => {
        await this.hooksManager.dispatchOnCommand(manifestCommand.id, [])
      },
    }
  }

  private async registerPluginSlashCommand(
    pluginId: string,
    manifestCommand: PluginManifestCommandDef,
    namespacedId: string
  ): Promise<void> {
    // The slash-command registry keys by full id (pluginId.commandId in our
    // scheme); aliases are registered as separate ids that share a handler.
    // We only track the canonical id in `registeredSlashCommandsByPlugin` —
    // aliases hang off it via the alias suffix below.
    const commandName = manifestCommand.id.toLowerCase()
    const registrationList = this.registeredSlashCommandsByPlugin.get(pluginId) || []

    try {
      const { getSlashCommand, registerSlashCommand } =
        await import("@/lib/chat/slash-command-registry")
      if (getSlashCommand(namespacedId)) {
        loggers.manager.warn(
          `[plugin:${pluginId}] slash command conflict "${commandName}" - keeping existing registration`
        )
        this.registeredSlashCommandsByPlugin.set(pluginId, registrationList)
        return
      }

      const requestedAliases = Array.from(
        new Set(
          (manifestCommand.aliases || [])
            .map((alias) => alias.trim().toLowerCase())
            .filter((alias) => alias.length > 0 && alias !== commandName)
        )
      )

      const handler = async (args: string) => {
        // Manifest hooks expect `string[]` args; `dispatchSlashCommand` hands
        // us the post-`/cmd ` tail as a single string. Splitting on
        // whitespace mirrors how the chat composer used to forward them.
        const argv = args.trim().length > 0 ? args.trim().split(/\s+/) : []
        const handled = await this.hooksManager.dispatchOnCommand(manifestCommand.id, argv)
        return handled
          ? { message: `Command handled by plugin: /${commandName}` }
          : { message: `Plugin command not handled: /${commandName}` }
      }

      registerSlashCommand({
        id: namespacedId,
        name: manifestCommand.name,
        description: manifestCommand.description || manifestCommand.name,
        source: "plugin",
        pluginId,
        handler,
      })
      registrationList.push(namespacedId)

      for (const alias of requestedAliases) {
        const aliasId = `${namespacedId}#alias:${alias}`
        if (getSlashCommand(aliasId)) {
          loggers.manager.warn(
            `[plugin:${pluginId}] slash alias conflict "${alias}" - keeping existing registration`
          )
          continue
        }
        registerSlashCommand({
          id: aliasId,
          name: `${manifestCommand.name} (alias: ${alias})`,
          description: manifestCommand.description || manifestCommand.name,
          source: "plugin",
          pluginId,
          handler,
        })
        registrationList.push(aliasId)
      }

      this.registeredSlashCommandsByPlugin.set(pluginId, registrationList)
    } catch (error) {
      loggers.manager.warn(
        `[plugin:${pluginId}] failed to register slash command "${commandName}":`,
        error
      )
    }
  }

  private async unregisterPluginSlashCommands(pluginId: string): Promise<void> {
    const commands = this.registeredSlashCommandsByPlugin.get(pluginId)
    if (!commands || commands.length === 0) {
      return
    }

    try {
      const { unregisterSlashCommand } = await import("@/lib/chat/slash-command-registry")
      for (const command of commands) {
        unregisterSlashCommand(command)
      }
    } catch (error) {
      loggers.manager.warn(`[plugin:${pluginId}] failed to unregister slash commands:`, error)
    } finally {
      this.registeredSlashCommandsByPlugin.delete(pluginId)
    }
  }

  // ===========================================================================
  // Plugin Contributions
  // ===========================================================================

  private async registerPluginContributions(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    const context = this.contexts.get(pluginId)

    if (!plugin || !context) return

    // Note: Tool implementations are provided by the plugin's activate function
    // through the context.agent.registerTool API

    // Note: A2UI component implementations are provided by the plugin
    // and registered via context.a2ui.registerComponent API

    // Register modes
    if (plugin.manifest.modes) {
      for (const modeDef of plugin.manifest.modes) {
        const mode = {
          id: `${pluginId}:${modeDef.id}`,
          type: "custom" as const,
          name: modeDef.name,
          description: modeDef.description,
          icon: modeDef.icon,
          systemPrompt: modeDef.systemPrompt,
          tools: modeDef.tools,
          outputFormat: modeDef.outputFormat,
          previewEnabled: modeDef.previewEnabled,
        }
        this.registry.registerMode(pluginId, mode)
        store.registerPluginMode(pluginId, mode)
      }
    }

    // Register manifest command metadata for UI and slash command execution.
    if (plugin.manifest.commands?.length) {
      for (const manifestCommand of plugin.manifest.commands) {
        const command = this.toRuntimePluginCommand(pluginId, manifestCommand)
        this.registry.registerCommand(pluginId, command)
        store.registerPluginCommand(pluginId, command)
        await this.registerPluginSlashCommand(pluginId, manifestCommand, command.id)
      }
    }

    // Register theme contributions. Failures inside the bridge are collected
    // and logged per-contribution; we never throw here so a single bad theme
    // can't block the rest of the plugin's contributions.
    if (plugin.manifest.themes?.length) {
      const result = await this.ensureThemesBridge().registerPluginThemes(
        pluginId,
        plugin.manifest.name,
        plugin.manifest,
        plugin.path
      )
      if (result.errors.length > 0) {
        loggers.manager.warn(
          `[plugin:${pluginId}] ${result.errors.length} theme contribution(s) failed; ${result.registered} registered.`
        )
      }
    }

    // M1·T5 — Plugin-first Computer Use capability contributions. Each
    // declarative manifest array writes into the matching §A-3 overlay
    // registry, tagged with `pluginId` so bulk cleanup in
    // `unregisterPluginContributions` can drop everything in one call.
    // Failures are isolated per-entry so a single malformed def can't block
    // the rest of the plugin's contributions.
    if (plugin.manifest.mcpServerPresets?.length) {
      for (const def of plugin.manifest.mcpServerPresets) {
        try {
          registerMcpServerPreset(def.id, def, { pluginId })
        } catch (err) {
          loggers.manager.warn(
            `[plugin:${pluginId}] failed to register MCP server preset ${def.id}:`,
            err
          )
        }
      }
    }
    if (plugin.manifest.nativeAnthropicTools?.length) {
      for (const def of plugin.manifest.nativeAnthropicTools) {
        try {
          registerNativeAnthropicTool(def.id, def, { pluginId })
        } catch (err) {
          loggers.manager.warn(
            `[plugin:${pluginId}] failed to register native Anthropic tool ${def.id}:`,
            err
          )
        }
      }
    }
    if (plugin.manifest.skills?.length) {
      for (const def of plugin.manifest.skills) {
        try {
          registerSkill(def.id, def, { pluginId })
        } catch (err) {
          loggers.manager.warn(`[plugin:${pluginId}] failed to register skill ${def.id}:`, err)
        }
      }
    }
    if (plugin.manifest.externalAgentPresets?.length) {
      for (const def of plugin.manifest.externalAgentPresets) {
        try {
          const { id, ...config } = def
          registerExternalAgentPresetOverlay(id, config, { pluginId })
        } catch (err) {
          loggers.manager.warn(
            `[plugin:${pluginId}] failed to register external-agent preset ${def.id}:`,
            err
          )
        }
      }
    }
  }

  private async unregisterPluginContributions(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) return

    this.a2uiBridge?.unregisterPluginComponents(pluginId)
    this.a2uiBridge?.unregisterPluginTemplates(pluginId)
    this.themesBridge?.unregisterPluginThemes(pluginId)
    clearPluginExtensions(pluginId)

    // Unregister all tools
    if (plugin.tools) {
      for (const tool of plugin.tools) {
        this.registry.unregisterTool(tool.name)
        store.unregisterPluginTool(pluginId, tool.name)
      }
    }

    // Unregister all components
    if (plugin.components) {
      for (const component of plugin.components) {
        this.registry.unregisterComponent(component.type)
        store.unregisterPluginComponent(pluginId, component.type)
      }
    }

    // Unregister all modes
    if (plugin.modes) {
      for (const mode of plugin.modes) {
        this.registry.unregisterMode(mode.id)
        store.unregisterPluginMode(pluginId, mode.id)
      }
    }

    // Unregister all commands
    if (plugin.commands) {
      for (const command of plugin.commands) {
        this.registry.unregisterCommand(command.id)
        store.unregisterPluginCommand(pluginId, command.id)
      }
    }

    await this.unregisterPluginSlashCommands(pluginId)

    // M1·T5 — Bulk-drop Plugin-first Computer Use overlay contributions.
    // Each registry's `unregister*ByPlugin` is idempotent and returns the
    // count removed; we don't act on the count here, but a future
    // diagnostic surface could surface it.
    unregisterMcpServerPresetsByPlugin(pluginId)
    unregisterNativeAnthropicToolsByPlugin(pluginId)
    unregisterSkillsByPlugin(pluginId)
    unregisterExternalAgentPresetsByPlugin(pluginId)

    this.registry.unregisterAll(pluginId)
  }

  // ===========================================================================
  // Python Plugin Support
  // ===========================================================================

  async loadPythonPlugin(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin || plugin.manifest.type === "frontend") {
      throw new Error(`Plugin ${pluginId} is not a Python plugin`)
    }

    try {
      // Load Python plugin via Tauri/PyO3
      await invoke("plugin_python_load", {
        pluginId,
        pluginPath: plugin.path,
        mainModule: plugin.manifest.pythonMain,
        dependencies: plugin.manifest.pythonDependencies,
      })

      // Get registered tools from Python
      const pythonTools = await invoke<
        Array<{
          name: string
          description: string
          parameters: Record<string, unknown>
        }>
      >("plugin_python_get_tools", { pluginId })

      // Register Python tools
      for (const toolDef of pythonTools) {
        const tool: PluginTool = {
          name: `${pluginId}:${toolDef.name}`,
          pluginId,
          definition: {
            name: toolDef.name,
            description: toolDef.description,
            parametersSchema: toolDef.parameters,
          },
          execute: async (args: Record<string, unknown>, _context: PluginToolContext) => {
            return invoke("plugin_python_call_tool", {
              pluginId,
              toolName: toolDef.name,
              args,
            })
          },
        }
        this.registry.registerTool(pluginId, tool)
        store.registerPluginTool(pluginId, tool)
      }
    } catch (error) {
      store.setPluginError(pluginId, String(error))
      throw error
    }
  }

  async callPythonFunction<T>(pluginId: string, functionName: string, args: unknown[]): Promise<T> {
    return invoke<T>("plugin_python_call", {
      pluginId,
      functionName,
      args,
    })
  }

  /**
   * Get Python runtime information
   */
  async getPythonRuntimeInfo(): Promise<PythonRuntimeInfo> {
    return invoke<PythonRuntimeInfo>("plugin_python_runtime_info")
  }

  /**
   * Check if a Python plugin is initialized
   */
  async isPythonPluginInitialized(pluginId: string): Promise<boolean> {
    return invoke<boolean>("plugin_python_is_initialized", { pluginId })
  }

  /**
   * Get Python plugin info (tool/hook counts)
   */
  async getPythonPluginInfo(pluginId: string): Promise<PythonPluginInfo | null> {
    return invoke<PythonPluginInfo | null>("plugin_python_get_info", { pluginId })
  }

  /**
   * Unload a Python plugin
   */
  async unloadPythonPlugin(pluginId: string): Promise<void> {
    return invoke("plugin_python_unload", { pluginId })
  }

  /**
   * List all loaded Python plugins
   */
  async listPythonPlugins(): Promise<string[]> {
    return invoke<string[]>("plugin_python_list")
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  getPlugin(pluginId: string): Plugin | undefined {
    return usePluginStore.getState().plugins[pluginId]
  }

  getPluginContext(pluginId: string): PluginContext | undefined {
    return this.contexts.get(pluginId)
  }

  getRegistry(): PluginRegistry {
    return this.registry
  }

  getHooksManager(): PluginLifecycleHooks {
    return this.hooksManager
  }

  getA2UIBridge(): PluginA2UIBridge {
    return this.ensureA2UIBridge()
  }

  isInitialized(): boolean {
    return this.initialized
  }

  getPluginPointGovernanceMode(): PluginPointGovernanceMode {
    return this.pluginPointGovernanceMode
  }

  private validateHookDeclarations(pluginId: string, hooks: PluginHooks): void {
    for (const hookName of Object.keys(hooks)) {
      const validation = validateHookPoint(hookName, {
        governanceMode: this.pluginPointGovernanceMode,
      })

      for (const diagnostic of validation.diagnostics) {
        recordPluginPointDiagnostic(pluginId, diagnostic)
        const message = `[plugin:${pluginId}] ${diagnostic.message}`
        if (diagnostic.severity === "error") {
          loggers.manager.error(message)
        } else {
          loggers.manager.warn(message)
        }
      }

      if (!validation.allowed) {
        throw new Error(
          `Hook declaration "${hookName}" is blocked by plugin point governance mode "${this.pluginPointGovernanceMode}".`
        )
      }
    }
  }
}
