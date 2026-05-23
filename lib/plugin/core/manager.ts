/**
 * Plugin Manager - Core plugin lifecycle management
 *
 * Handles plugin discovery, loading, enabling, disabling, and unloading.
 * Coordinates with Tauri backend for Python plugin support via PyO3.
 */

import { invoke } from "@tauri-apps/api/core"
import { usePluginStore } from "@/stores/plugin-runtime"
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
import { applyPluginTables, removePluginTables } from "@/lib/plugin/dexie/bridge"
import { getDb } from "@/lib/db/schema"
import { clearPluginExtensions } from "@/lib/plugin/api/extension-api"
import { purgeMessagePartRenderersForPlugin } from "@/lib/plugin/api/message-part-api"
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
import {
  applyWasmCapabilityGrant,
  clearWasmCapabilityGrant,
  type WasmCapabilityGrantDecision,
} from "@/lib/plugin/security/wasm-grant"
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
// PR-D — overlay-registry capabilities (skills / mcp-server-preset /
// native-anthropic-tool / external-agent-preset) now flow through the
// codified `CAPABILITY_BRIDGE_MAP`. Bespoke capabilities (modes,
// commands, themes, lsp, custom-theme cleanup, message-part renderers,
// extensions, slash commands, a2ui components/templates) stay on
// their existing hand-rolled branches because their per-entry logic
// doesn't fit the uniform register/unregister contract.
import {
  OVERLAY_REGISTRY_CAPABILITIES,
  OVERLAY_REGISTRY_CAPABILITY_KEYS,
} from "@/lib/plugin/contracts/capability-bridge-map"
// Skill detach still calls unregisterSkillsByPlugin directly after the
// per-character cleanup hook; the map's bulk unregister fires for the
// other three capabilities via the disable loop.
import { unregisterSkillsByPlugin } from "@/lib/plugin/registries/skill-registry"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { clearCustomThemesForPluginContext } from "@/lib/plugin/api/theme-api"

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
// Typed errors (PR-A)
// =============================================================================

/**
 * Thrown when a plugin's `enablePlugin` flow fails partway. Carries
 * the original cause + pluginId so UI callers can pattern-match
 * (e.g. show a "retry" affordance only for known recoverable errors)
 * without parsing a free-form error message.
 *
 * The original cause is preserved on the `cause` field per the
 * standard `Error` extension pattern.
 */
export class PluginEnableError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly originalError: unknown
  ) {
    super(
      `Failed to enable plugin "${pluginId}": ${
        originalError instanceof Error ? originalError.message : String(originalError)
      }`,
      { cause: originalError }
    )
    this.name = "PluginEnableError"
  }
}

/**
 * Window CustomEvent name fired when `enablePlugin` rolls back after a
 * failure. The detail carries the pluginId + a short error string so a
 * React component near the app root can translate + render a toast
 * (decoupling the manager from i18n at the .ts boundary). Mirrors the
 * established pattern used by `plugin:consent-request` /
 * `plugin:updates-available` / `plugin:hot-reload-notification`.
 */
export const PLUGIN_ENABLE_FAILED_EVENT = "plugin:enable-failed"

export interface PluginEnableFailedEventDetail {
  pluginId: string
  /** Best-effort plugin display name (falls back to pluginId). */
  pluginName: string
  /** Short error message — the toast UI may wrap or truncate. */
  errorMessage: string
  /** Reason string passed to enablePlugin (e.g. "manual" / "startup"). */
  reason: string
}

// =============================================================================
// Plugin Manager Singleton + Factory (PR-E)
// =============================================================================

let pluginManagerInstance: PluginManager | null = null

export function getPluginManager(): PluginManager {
  if (!pluginManagerInstance) {
    throw new Error("Plugin manager not initialized. Call initializePluginManager first.")
  }
  return pluginManagerInstance
}

/**
 * Build a fresh `PluginManager` without touching the module-level
 * default instance. PR-E added this so tests / dev-mode can spin up
 * an isolated manager alongside the running one (e.g. for plugin
 * dev-server sandboxing). Behaviour matches `new PluginManager(config)`
 * — exposed as a named export so callers reading the code at a glance
 * see "factory" rather than `new`.
 */
export function createPluginManager(config: PluginManagerConfig): PluginManager {
  return new PluginManager(config)
}

export async function initializePluginManager(config: PluginManagerConfig): Promise<PluginManager> {
  if (pluginManagerInstance) {
    return pluginManagerInstance
  }

  pluginManagerInstance = createPluginManager(config)
  await pluginManagerInstance.initialize()
  return pluginManagerInstance
}

/**
 * Test-only escape hatch — drops the default instance so the next
 * `initializePluginManager()` call starts from scratch. Throws when
 * called outside the test runner so production code can't reach for
 * it accidentally. Matches the `__resetForTesting` convention from
 * `lib/plugin/registries/createOverlayRegistry.ts:74`.
 */
export function __resetPluginManagerForTesting(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetPluginManagerForTesting is only callable in NODE_ENV=test")
  }
  pluginManagerInstance = null
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

    // ADR 0016 P1-8 — rewrite legacy permission names (`fs:read` →
    // `filesystem:read`, etc.) in the persisted plugin_permissions table.
    // Idempotent. Runs before scanPlugins so manifest validation sees the
    // canonical names when re-discovery happens against existing rows.
    try {
      const { migrateLegacyPermissionNames } =
        await import("@/lib/plugin/security/permission-migration")
      await migrateLegacyPermissionNames()
    } catch (error) {
      loggers.manager.warn("[manager] permission migration failed:", error)
    }

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

      if (result.manifest.type === "wasm") {
        await this.preloadWasmComponent(result.manifest, result.path)
      }

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

  /**
   * Install a WASM plugin from a local bundle (either a single `.wasm` file
   * or a `.zip` containing `plugin.json` + `.wasm`). Persists the user's
   * capability grant decision via `applyWasmCapabilityGrant` before
   * delegating to the canonical `installPlugin` path so manifest validation,
   * compatibility checks, and store wiring stay shared with other types.
   */
  async installWasmPluginFromLocalFile(
    bundlePath: string,
    grantDecision?: WasmCapabilityGrantDecision
  ): Promise<Plugin> {
    if (grantDecision) {
      applyWasmCapabilityGrant(grantDecision)
    }
    const plugin = await this.installPlugin(bundlePath, { type: "local" })
    if (plugin.manifest.type !== "wasm") {
      throw new Error(
        `installWasmPluginFromLocalFile: bundle at ${bundlePath} did not declare type: "wasm"`
      )
    }
    return plugin
  }

  /**
   * Compile a WASM component on the Rust host immediately after install
   * so the first `enablePlugin` call doesn't pay the wasmtime compile
   * cost. Tauri-only — silently no-ops when the host is unavailable
   * (browser mode is already in a degraded state at this point).
   */
  private async preloadWasmComponent(manifest: PluginManifest, pluginPath: string): Promise<void> {
    if (!canUseTauriInvoke()) return
    try {
      await invoke("plugin_wasm_load", {
        pluginId: manifest.id,
        manifestJson: JSON.stringify(manifest),
        pluginPath,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      loggers.manager.warn(`[plugin:${manifest.id}] WASM preload failed`, { error: message })
      // Don't rethrow — install itself succeeded. Enable will surface the
      // same error in a more actionable place if it persists.
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

      // Apply any declared Dexie tables before enabling the plugin so that
      // ctx.dexie is ready when the plugin's activate() runs.
      if (plugin.manifest.dexie) {
        await applyPluginTables(
          getDb() as unknown as import("dexie").default,
          pluginId,
          plugin.manifest.dexie
        )
      }

      // Register plugin-provided i18n strings so the next render of any
      // useTranslations() consumer sees the new `plugin.<id>.<key>` entries.
      // Done before activate() so plugin code that itself calls into the
      // host UI (rare but possible via hooks) can resolve its own keys.
      const i18nLocales = plugin.manifest.i18n?.locales
      if (i18nLocales) {
        const prefixed: Partial<Record<string, Record<string, string>>> = {}
        for (const [locale, dict] of Object.entries(i18nLocales)) {
          if (!dict) continue
          const entries: Record<string, string> = {}
          for (const [key, value] of Object.entries(dict)) {
            entries[`plugin.${pluginId}.${key}`] = value
          }
          prefixed[locale] = entries
        }
        registerPluginI18n({ pluginId, messages: prefixed })
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
      // Rollback: if `registerPluginContributions` (or anything after it)
      // threw partway, registries may have entries we never cleaned up.
      // Running `unregisterPluginContributions` here is safe — every
      // `unregister*ByPlugin` is idempotent and a no-op for plugins that
      // never registered. Without this, a failed activation leaks skill /
      // tool / preset / character-attachment state into the next enable.
      try {
        await this.unregisterPluginContributions(pluginId)
      } catch (rollbackError) {
        loggers.manager.warn(
          `[plugin:${pluginId}] rollback after failed enable also failed:`,
          rollbackError
        )
      }
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
      // PR-A — route the failure through the shared diagnostics store
      // so the devtools panel surfaces it alongside other plugin-point
      // diagnostics (existing flow only wrote to per-plugin error
      // state via `setPluginError`, which the audit panel doesn't
      // read). The verification entry above is for the verification
      // log; this is for the audit timeline.
      recordSilentFailure(
        pluginId,
        {
          site: "manager.enablePlugin",
          message: `Failed to enable plugin: ${reason}`,
          expected: false,
        },
        error
      )
      // Toast UX (PR-A backlog). The manager can't reach
      // `useTranslations()` directly from .ts code; we emit a typed
      // CustomEvent that `PluginEnableFailureToaster` (React) listens
      // for, translates via next-intl, and renders via sonner. SSR
      // and Tauri-isolated worker contexts where `window` is missing
      // are safe no-ops.
      if (typeof window !== "undefined") {
        const detail: PluginEnableFailedEventDetail = {
          pluginId,
          pluginName: plugin.manifest.name || pluginId,
          errorMessage: error instanceof Error ? error.message : String(error),
          reason,
        }
        window.dispatchEvent(new CustomEvent(PLUGIN_ENABLE_FAILED_EVENT, { detail }))
      }
      throw new PluginEnableError(pluginId, error)
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

      // Drop plugin-provided i18n bundles so the merged messages object no
      // longer surfaces `plugin.<id>.*` keys after disable.
      unregisterPluginI18n(pluginId)

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

      // Unload from loader (awaited so a hung runtime teardown can't
      // race the store update — PR-B of the plugin optimization plan).
      await this.loader.unload(pluginId)

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

  async uninstallPlugin(pluginId: string, options?: { purgeData?: boolean }): Promise<void> {
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

      // Drop plugin-provided i18n bundles in case disable didn't run (e.g.,
      // direct uninstall from "installed" state). Idempotent.
      unregisterPluginI18n(pluginId)

      // Remove files via Tauri
      await invoke("plugin_uninstall", {
        pluginId,
        pluginPath: plugin.path,
      })

      // Remove from store
      await store.uninstallPlugin(pluginId, { skipFileRemoval: true, viaManager: false })

      // Remove plugin Dexie tables. Default: keep data (allows reinstall to resume).
      // Pass purgeData: true from the settings "Delete plugin data" action.
      await removePluginTables(
        getDb() as unknown as import("dexie").default,
        pluginId,
        options?.purgeData ? "purge" : "keep"
      )

      await this.revokePluginPermissions(pluginId, plugin.manifest.permissions || [])
      getPermissionGuard().unregisterPlugin(pluginId)
      if (plugin.manifest.type === "wasm") {
        clearWasmCapabilityGrant(pluginId)
      }
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
      await this.loader.unload(pluginId)
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

    // M1·T5 — Plugin-first Computer Use capability contributions.
    //
    // PR-D consolidated the 4 overlay-registry capabilities
    // (skills / mcp-server-preset / native-anthropic-tool /
    // external-agent-preset) into `OVERLAY_REGISTRY_CAPABILITIES`.
    // Each entry's per-entry register failures stay isolated so a
    // single malformed def can't block the rest of the plugin's
    // contributions — matching the original hand-rolled behaviour.
    for (const cap of OVERLAY_REGISTRY_CAPABILITY_KEYS) {
      const descriptor = OVERLAY_REGISTRY_CAPABILITIES[cap]
      const entries = plugin.manifest[descriptor.manifestField] as
        | ReadonlyArray<{ id: string }>
        | undefined
      if (!entries?.length) continue
      for (const entry of entries) {
        try {
          descriptor.registerEntry(entry, { pluginId })
        } catch (err) {
          loggers.manager.warn(`[plugin:${pluginId}] failed to register ${cap} ${entry.id}:`, err)
        }
      }
    }

    // Phase B of the LSP reuse work — `manifest.lspServers[]`. Kept
    // outside the map because the registry awaits the binary-policy
    // gate per entry and spawns each server through an injected
    // client adapter — bespoke wiring that doesn't fit the uniform
    // overlay-registry shape.
    if (plugin.manifest.lspServers?.length) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { registerPluginLspServers } = require("@/lib/plugin/lsp/lsp-registry") as {
          registerPluginLspServers: (input: {
            pluginId: string
            pluginPath: string
            publisherFingerprint?: string
            servers: NonNullable<typeof plugin.manifest.lspServers>
          }) => Promise<unknown>
        }
        await registerPluginLspServers({
          pluginId,
          pluginPath: plugin.path ?? "",
          publisherFingerprint: plugin.manifest.vscodeExtension?.publisherKeyFingerprint,
          servers: plugin.manifest.lspServers,
        })
      } catch (err) {
        loggers.manager.warn(
          `[plugin:${pluginId}] failed to register LSP servers (registry not configured?):`,
          err
        )
      }
    }

    // Skills carry an additional post-enable hook: attach skill ids
    // to opted-in characters' `pluginSkillIds`. The map's
    // `registerEntry` only handles the registry write; this hook
    // mirrors the disable-side `detachPluginSkillsFromCharacters`
    // call. Idempotent on duplicate enables.
    if (plugin.manifest.skills?.length) {
      await this.attachPluginSkillsToCharacters(pluginId, plugin.manifest.skills)
    }
  }

  /**
   * Append each plugin skill's id to the `pluginSkillIds` list on every
   * character it declares via `attachToCharacterIds`. Idempotent — running
   * twice doesn't duplicate the entry. Skill rows that don't declare
   * `attachToCharacterIds` (or declare an empty list) are no-ops here.
   */
  private async attachPluginSkillsToCharacters(
    pluginId: string,
    skills: ReadonlyArray<import("@/types/plugin/plugin-skill").PluginSkillDef>
  ): Promise<void> {
    const { getCharacter, updateCharacter } = await import("@/lib/db/characters")
    // Build a per-character bag of skill ids to add. Done in two passes so
    // a character mentioned by N skills incurs only one update.
    const toAdd = new Map<string, string[]>()
    for (const def of skills) {
      const targets = def.attachToCharacterIds ?? []
      for (const characterId of targets) {
        const bag = toAdd.get(characterId) ?? []
        bag.push(def.id)
        toAdd.set(characterId, bag)
      }
    }
    for (const [characterId, skillIds] of toAdd) {
      try {
        const row = await getCharacter(characterId)
        if (!row) {
          loggers.manager.warn(
            `[plugin:${pluginId}] attachToCharacterIds references missing character ${characterId}`
          )
          continue
        }
        const existing = new Set(row.pluginSkillIds ?? [])
        for (const id of skillIds) existing.add(id)
        await updateCharacter(characterId, { pluginSkillIds: [...existing] })
      } catch (err) {
        loggers.manager.warn(
          `[plugin:${pluginId}] failed to attach skill(s) to character ${characterId}:`,
          err
        )
      }
    }
  }

  /**
   * Remove each plugin skill's id from every character that referenced it.
   * Mirrors `attachPluginSkillsToCharacters` so disable / re-enable is a
   * clean round-trip.
   */
  private async detachPluginSkillsFromCharacters(
    skills: ReadonlyArray<import("@/types/plugin/plugin-skill").PluginSkillDef>
  ): Promise<void> {
    const { listCharacters, updateCharacter } = await import("@/lib/db/characters")
    const drop = new Set(skills.map((s) => s.id))
    if (drop.size === 0) return
    const all = await listCharacters()
    for (const character of all) {
      if (!character.pluginSkillIds?.length) continue
      const before = character.pluginSkillIds
      const after = before.filter((id) => !drop.has(id))
      if (after.length === before.length) continue
      try {
        await updateCharacter(character.id, {
          pluginSkillIds: after.length > 0 ? after : undefined,
        })
      } catch (err) {
        loggers.manager.warn(
          `failed to detach plugin skill(s) from character ${character.id}:`,
          err
        )
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
    // GC any `CustomTheme` rows the plugin created via `ctx.theme.registerCustomTheme`.
    // The manifest-themes path above handles in-memory plugin themes; this
    // line handles the persistent Dexie-backed rows. Both are required to
    // avoid orphan entries lingering after disable.
    clearCustomThemesForPluginContext(pluginId)
    clearPluginExtensions(pluginId)
    purgeMessagePartRenderersForPlugin(pluginId)

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
    // PR-D — routed through `OVERLAY_REGISTRY_CAPABILITIES` so adding
    // a new uniform-shape capability picks up disable cleanup for free.
    // Skills are intentionally handled below the
    // `detachPluginSkillsFromCharacters` hook to preserve ordering.
    for (const cap of OVERLAY_REGISTRY_CAPABILITY_KEYS) {
      if (cap === "skills") continue
      OVERLAY_REGISTRY_CAPABILITIES[cap].unregisterAllByPlugin(pluginId)
    }
    // Tear down any LSP servers this plugin contributed. The registry's
    // adapter handles the actual sidecar stop; failures are logged but
    // never block the disable flow.
    if (plugin.manifest.lspServers?.length) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { unregisterByOwner } = require("@/lib/plugin/lsp/lsp-registry") as {
          unregisterByOwner: (ownerId: string) => Promise<number>
        }
        await unregisterByOwner(pluginId)
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] LSP unregister failed:`, err)
      }
    }
    // Remove this plugin's skill ids from every character's
    // `pluginSkillIds` before the overlay is dropped so a re-enable
    // re-attaches cleanly.
    if (plugin.manifest.skills?.length) {
      await this.detachPluginSkillsFromCharacters(plugin.manifest.skills)
    }
    // Skill bulk-drop happens after the per-character detach hook so
    // a re-enable starts from a fully clean slate (PR-D ordering).
    unregisterSkillsByPlugin(pluginId)
    // Every overlay capability this plugin contributed is now gone — re-run
    // the agent-team capability audit so any team/teammate that referenced a
    // dropped id surfaces a stale-capability warning. Fire-and-forget: the
    // disable flow must not block on the (async, Dexie-backed) sweep.
    try {
      const { refreshAllInstanceCapabilityWarnings } =
        await import("@/lib/ai/agent/team/capability-audit")
      void refreshAllInstanceCapabilityWarnings()
    } catch (err) {
      loggers.manager.warn(`[plugin:${pluginId}] capability-audit refresh failed:`, err)
    }
    // Bulk-drop telemetry rows for this plugin's skills so usage counters
    // don't outlive the plugin.
    try {
      const { deletePluginSkillUsageByPlugin } = await import("@/lib/db/plugin-skill-usage")
      await deletePluginSkillUsageByPlugin(pluginId)
    } catch (err) {
      loggers.manager.warn(`[plugin:${pluginId}] failed to purge skill usage rows:`, err)
    }
    // External-agent presets get dropped via the
    // OVERLAY_REGISTRY_CAPABILITIES loop above (PR-D).

    // System-tray cleanup — drops any items the plugin contributed via
    // `ctx.tray.register(...)`. Mirrors the slash-command teardown above so
    // the disable lifecycle stays uniform across registries.
    try {
      const trayModule = await import("@/lib/tray/registry")
      trayModule.unregisterTrayItemsByPlugin(pluginId)
      // Bulk-drop the Rust-side records as well so a re-enable starts fresh.
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin_tray_item_unregister_by_plugin", { pluginId }).catch(() => {})
    } catch {
      // optional dep — non-Tauri builds and tests without the modules wired
    }

    // VS Code shim cleanup — lm provider registrations + chat participants.
    // For non-vscode-extension plugins these are no-ops (the maps will be
    // empty); for VS Code extensions they tear down every recorded handle.
    try {
      const lmModule = await import("@/lib/plugin/vscode-shim/lm-handler")
      lmModule.unregisterAllLmFor(pluginId)
      const chatModule = await import("@/lib/plugin/vscode-shim/chat-participant-registry")
      await chatModule.disposeAllParticipantsFor(pluginId)
      const monacoModule = await import("@/lib/plugin/vscode-shim/monaco-bridge")
      monacoModule.unregisterByExtension(pluginId)
    } catch {
      // VS Code shim modules are optional; ignore when not present in tests.
    }

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

  /**
   * Update the runtime governance mode. Used by the Settings → Plugins
   * Policy panel so toggling the switch takes effect without a page
   * reload. Validation paths that read `this.pluginPointGovernanceMode`
   * will pick up the new value on their next invocation; already-passed
   * manifests aren't re-validated retroactively. The Zustand store-level
   * persisted setting (`cognia.plugins.policy.governance`) survives
   * reloads — this setter only updates the live instance.
   */
  setPluginPointGovernanceMode(mode: PluginPointGovernanceMode): void {
    this.pluginPointGovernanceMode = mode
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
