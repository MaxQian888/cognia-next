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
  PythonHookDeclaration,
  PythonHostSettings,
  PythonLoadResult,
} from "@/types/plugin"
import { PluginLoader } from "@/lib/plugin/core/loader"
import { PluginRegistry } from "@/lib/plugin/core/registry"
import {
  createFullPluginContext,
  teardownPluginWorkflowRegistrations,
} from "@/lib/plugin/core/context"
import { buildExtensionDescriptor } from "@/lib/plugin/core/descriptor"
import { createPluginA2UIBridge, type PluginA2UIBridge } from "@/lib/plugin/bridge/a2ui-bridge"
import { PluginThemesBridge } from "@/lib/plugin/bridge/themes-bridge"
import { PluginLifecycleHooks, getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { isPluginSuspendEligible } from "@/lib/plugin/core/idle-policy"
import { seedPluginConfigDefaults } from "@/lib/plugin/core/config-defaults"
import { emitPluginConfigChange } from "@/lib/plugin/api/config-api"
import { clearPluginSecrets } from "@/lib/plugin/api/secrets-api"

/** How often the idle sweep runs (only active when a plugin opts into idleSuspend). */
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000
import { getMessageBus, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { getPluginIPC } from "@/lib/plugin/messaging/ipc"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import { applyPluginTables, removePluginTables } from "@/lib/plugin/dexie/bridge"
import {
  activationBreakerKey,
  getOrCreateBreaker,
  loadBreakerKey,
  resetPluginBreakers,
} from "@/lib/plugin/resilience/breaker-registry"
import { isRetryableLoadError, LOAD_RESILIENCE } from "@/lib/plugin/resilience/config"
import { runResilient } from "@/lib/plugin/resilience/run-resilient"
import { runWithConcurrency } from "@/lib/plugin/core/concurrency"
import {
  recordActivationFailure,
  recordLoadAttempt,
  recordLoadFailure,
  recordLoadRetry,
  recordLoadSuccess,
} from "@/lib/plugin/core/resilience-telemetry"
import { getDb } from "@/lib/db/schema"
import {
  updatePlugin,
  getPlugin,
  setPluginConfig,
  getPythonHostSettings,
  setPythonHostSettings,
} from "@/lib/db/plugins"
import { appendPythonEvent, type PythonPluginEvent } from "@/lib/plugin/python/log-buffer"
import { clearPluginExtensions } from "@/lib/plugin/api/extension-api"
import { unregisterUriHandlersByPlugin } from "@/lib/plugin/uri/uri-handler-registry"
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
import { grantPluginPermission, revokePluginPermission } from "./transport"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
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
import {
  resolveLoadOrder,
  type LoadOrderPluginInput,
  type LoadOrderBlockReason,
} from "@/lib/plugin/core/load-order"
import { getBrowserBuiltinRegistry } from "./browser-builtin-registry"
import { buildWasmToolDefinitions } from "./wasm-loader"
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
// Async sibling of the overlay map: 7 contribution fields wired through
// dynamic-import bridges (ai/ocr/workspace/message-renderer/connectors/
// fonts/wallpapers). Driven by one `await` loop on each side, mirroring the
// overlay dispatch.
import {
  MODULE_BRIDGE_CAPABILITIES,
  MODULE_BRIDGE_CAPABILITY_KEYS,
} from "@/lib/plugin/contracts/module-bridge-map"
import { createPluginAssetResolver } from "@/lib/plugin/core/plugin-asset-resolver"
import { invalidateConfigComponentForPlugin } from "@/lib/plugin/bridge/config-component-bridge"
// Skill detach still calls unregisterSkillsByPlugin directly after the
// per-character cleanup hook; the map's bulk unregister fires for the
// other three capabilities via the disable loop.
import { unregisterSkillsByPlugin } from "@/lib/plugin/registries/skill-registry"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { clearCustomThemesForPluginContext } from "@/lib/plugin/api/theme-api"
import { dispatchPluginError } from "@/lib/plugin/error-bus"

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
  /**
   * Inject a frontend-module importer for Node hosts (the CLI). Forwarded to the
   * {@link PluginLoader} so non-builtin `frontend` plugins load via dynamic
   * `import()` instead of the Tauri / fetch / eval strategies that don't exist
   * under Node. See `cli/src/plugin/node-importer.ts`.
   */
  frontendImporter?: (absPath: string, pluginId: string) => Promise<Record<string, unknown>>
  /**
   * Max plugins enabled concurrently within a single dependency layer at
   * startup restore. Bounds the thundering-herd of module loads against the
   * sidecar. Default 4. Tests pin it to 1 for deterministic ordering.
   */
  maxLoadConcurrency?: number
}

/** Default concurrency for layered startup restore. */
const DEFAULT_MAX_LOAD_CONCURRENCY = 4

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

type PluginActivationRuntimeEvent =
  | "startup"
  | `onCommand:${string}`
  | `onTool:${string}`
  | `onView:${string}`
  | `onUri:${string}`

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
  viewEvents: string[]
  /** True when the plugin declares `onUri` (it handles its own deep-links). */
  uriActivation: boolean
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

/**
 * Mutable progress record passed through `installPlugin`. Each step the
 * pipeline completes flips a boolean here; if a later step throws, the
 * catch block uses this record to undo only the work that actually
 * landed (no double-revoke, no remove-of-things-never-added).
 *
 * Kept narrow on purpose — install only needs to undo a handful of
 * side effects (`plugin_install` Tauri call, store row, permission
 * grants, WASM preload). The richer `PluginRuntimeRollbackSnapshot`
 * applies to disable/unload/uninstall which have to restore activation
 * state too.
 */
interface InstallTransactionState {
  pluginId: string | null
  pluginPath: string | null
  manifest: PluginManifest | null
  stepsCompleted: {
    backendInstall: boolean
    storeDiscovery: boolean
    storeInstall: boolean
    permissionRegistration: boolean
  }
}

/** Python runtime information */
export interface PythonRuntimeInfo {
  available: boolean
  version: string | null
  plugin_count: number
  /** Loaded plugins currently demoted to a dormant lazy slot. */
  lazy_hosts: number
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
 * Thrown when a plugin can't be enabled because a *required* dependency is
 * missing, disabled, version-mismatched, or part of a dependency cycle (see
 * `lib/plugin/core/load-order.ts`). Distinct from `PluginEnableError` so UI
 * callers can show "install/enable the missing dependency" rather than a
 * generic retry. The unmet reasons are carried for messaging.
 */
/**
 * Thrown when a python/hybrid plugin is loaded while the manager's
 * `enablePython` config is off (browser profile, or desktop with the
 * runtime explicitly disabled). Typed so UI callers can distinguish
 * "runtime disabled by configuration" from a backend load failure.
 */
export class PythonRuntimeDisabledError extends Error {
  constructor(public readonly pluginId: string) {
    super(`Cannot load Python plugin "${pluginId}": the Python runtime is disabled in this profile`)
    this.name = "PythonRuntimeDisabledError"
  }
}

export class PluginDependencyError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly reasons: readonly LoadOrderBlockReason[]
  ) {
    super(
      `Cannot enable plugin "${pluginId}": unmet required dependencies — ${reasons
        .map((r) => `${r.dependencyId} (${r.kind})`)
        .join(", ")}`
    )
    this.name = "PluginDependencyError"
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
  /**
   * In-flight `enablePlugin` promises keyed by plugin id. Dedupes concurrent
   * enables of the same plugin (e.g. a shared dependency enabled by two
   * dependents in the same restore layer) so its contributions register and
   * its `onEnable` hook fire exactly once. Without this, the `status ===
   * "enabled"` early-return races the late `store.enablePlugin` flip.
   */
  private enableInFlight: Map<string, Promise<void>> = new Map()
  private warnedActivationEvents: Set<string> = new Set()
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null
  private initialized = false
  private compatibilityMode: "warn" | "block"
  private pluginPointGovernanceMode: PluginPointGovernanceMode
  private compatibilityRuntime: CompatibilityRuntime
  private runtimeProfile: PluginRuntimeProfile
  /** `plugin:python` Tauri event unlisten — set once by subscribePythonEvents. */
  private pythonEventsUnlisten: (() => void) | null = null

  constructor(config: PluginManagerConfig) {
    this.config = config
    this.loader = new PluginLoader({ frontendImporter: config.frontendImporter })
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

    // Begin the idle sweep if any enabled plugin opted into idle-suspension.
    this.startIdleSweep()

    this.initialized = true
  }

  private async initializePythonRuntime(): Promise<void> {
    try {
      await invoke("plugin_python_initialize", {
        pythonPath: this.config.pythonPath,
      })
      await this.subscribePythonEvents()
      const runtime = await this.getPythonRuntimeInfo().catch(() => null)
      if (runtime && !runtime.available) {
        // Supported configuration, not an error: the backend probed and
        // found no usable interpreter — python plugins stay disabled.
        loggers.manager.warn(
          "Python runtime unavailable: no python >= 3.9 interpreter found; python plugins disabled"
        )
        return
      }
      if (runtime?.version) {
        this.compatibilityRuntime.pythonVersion = runtime.version
      }
    } catch (error) {
      // Pass a string: a bare Error renders as "{}" in the console
      // transport's data slot, hiding the actual failure.
      loggers.manager.error("Failed to initialize Python runtime:", String(error))
      // Continue without Python support
    }
  }

  /**
   * Route `plugin:python` notifications (host logs, pip progress, streaming
   * chunks, exits) into the per-plugin log ring buffer consumed by the
   * detail Logs tab. Idempotent — subscribed once per manager lifetime.
   */
  private async subscribePythonEvents(): Promise<void> {
    if (this.pythonEventsUnlisten) {
      return
    }
    try {
      const { listen } = await import("@tauri-apps/api/event")
      this.pythonEventsUnlisten = await listen<PythonPluginEvent>("plugin:python", (event) => {
        appendPythonEvent(event.payload)
      })
    } catch (error) {
      // Web mode (no Tauri event bridge) — logs surface is desktop-only.
      recordSilentFailure(
        "python-runtime",
        {
          site: "manager.subscribePythonEvents",
          message: "Failed to subscribe to plugin:python events",
          expected: !canUseTauriInvoke(),
        },
        error
      )
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

  /** Snapshot the live plugin set as load-order resolver inputs. */
  private buildLoadOrderInputs(): LoadOrderPluginInput[] {
    const store = usePluginStore.getState()
    return Object.values(store.plugins).map((p) => ({
      id: p.manifest.id,
      version: p.manifest.version,
      dependencies: p.manifest.dependencies,
      optionalDependencies: p.manifest.optionalDependencies,
      status: p.status,
    }))
  }

  /** Record `plugin.dependency.*` runtime diagnostics for unmet required deps. */
  private recordDependencyDiagnostics(
    pluginId: string,
    reasons: readonly LoadOrderBlockReason[]
  ): void {
    const codeByKind = {
      missing: "plugin.dependency.missing",
      disabled: "plugin.dependency.disabled",
      "version-mismatch": "plugin.dependency.version-mismatch",
      cycle: "plugin.dependency.cycle",
    } as const
    for (const reason of reasons) {
      const found = reason.kind === "version-mismatch" ? ` (found ${reason.found})` : ""
      const hint =
        reason.kind === "missing"
          ? `Install the "${reason.dependencyId}" plugin, then re-enable this one.`
          : reason.kind === "disabled"
            ? `Enable the "${reason.dependencyId}" plugin first.`
            : reason.kind === "cycle"
              ? `"${reason.dependencyId}" and this plugin require each other — break the cycle.`
              : `Install a "${reason.dependencyId}" version matching "${reason.constraint}".`
      recordPluginPointDiagnostic(pluginId, {
        code: codeByKind[reason.kind],
        severity: "error",
        pointKind: "runtime",
        pointId: reason.dependencyId,
        message: `Required dependency "${reason.dependencyId}" ${reason.kind.replace("-", " ")}${found}; needs "${reason.constraint}".`,
        hint,
      })
    }
  }

  /**
   * Throw `PluginDependencyError` (after recording diagnostics) when a plugin's
   * required dependencies can't be satisfied. Evaluated against the live store
   * snapshot, so a dependency that is merely "installed" (and will be enabled)
   * does NOT block — only missing / disabled / version-mismatched / cyclic deps do.
   */
  private assertRequiredDependenciesSatisfied(pluginId: string): void {
    const { blocked, cycles } = resolveLoadOrder(this.buildLoadOrderInputs())
    const reasons = blocked.get(pluginId)
    if (reasons && reasons.length > 0) {
      this.recordDependencyDiagnostics(pluginId, reasons)
      throw new PluginDependencyError(pluginId, reasons)
    }
    const cycle = cycles.find((c) => c.includes(pluginId))
    if (cycle) {
      const cycleReasons: LoadOrderBlockReason[] = cycle
        .filter((id) => id !== pluginId)
        .map((id) => ({ kind: "cycle", dependencyId: id, constraint: "*" }))
      this.recordDependencyDiagnostics(pluginId, cycleReasons)
      throw new PluginDependencyError(pluginId, cycleReasons)
    }
  }

  private async restorePluginStates(): Promise<void> {
    const store = usePluginStore.getState()
    const plugins = Object.values(store.plugins)

    const candidateIds = new Set(
      plugins
        .filter(
          (plugin) =>
            plugin.status === "installed" &&
            (this.config.autoEnable || this.shouldActivateOnStartup(plugin.manifest))
        )
        .map((plugin) => plugin.manifest.id)
    )
    if (candidateIds.size === 0) return

    // Resolve a dependency-respecting enable order over the whole known set so a
    // candidate's required dependency is enabled before it. Blocked / cyclic
    // candidates are surfaced as diagnostics and skipped.
    const { layers, blocked, cycles, degraded } = resolveLoadOrder(this.buildLoadOrderInputs())

    for (const [id, reasons] of blocked) {
      if (candidateIds.has(id)) this.recordDependencyDiagnostics(id, reasons)
    }
    for (const cycle of cycles) {
      for (const id of cycle) {
        if (!candidateIds.has(id)) continue
        this.recordDependencyDiagnostics(
          id,
          cycle
            .filter((other) => other !== id)
            .map((other) => ({ kind: "cycle", dependencyId: other, constraint: "*" }))
        )
      }
    }
    for (const [id, unmet] of degraded) {
      if (!candidateIds.has(id)) continue
      for (const depId of unmet) {
        recordPluginPointDiagnostic(id, {
          code: "plugin.dependency.optional-degraded",
          severity: "warning",
          pointKind: "runtime",
          pointId: depId,
          message: `Optional dependency "${depId}" is unavailable; "${id}" runs with reduced functionality.`,
        })
      }
    }

    // Enable layer-by-layer: every plugin in a layer has its required deps in
    // earlier layers, so a layer's members enable CONCURRENTLY (bounded) while
    // dependency edges are still respected. A per-plugin failure is logged and
    // never aborts the layer or the cold start.
    const limit = this.config.maxLoadConcurrency ?? DEFAULT_MAX_LOAD_CONCURRENCY
    for (const layer of layers) {
      const candidates = layer.filter((id) => candidateIds.has(id))
      await runWithConcurrency(candidates, limit, async (id) => {
        try {
          await this.enablePlugin(id)
        } catch (error) {
          loggers.manager.error(`Failed to restore plugin ${id}:`, error)
        }
      })
    }
  }

  // ===========================================================================
  // Plugin Discovery
  // ===========================================================================

  async scanPlugins(): Promise<DiscoveredPlugin[]> {
    if (this.runtimeProfile === "browser") {
      return this.scanBrowserBuiltins()
    }

    // Built-in plugins are statically bundled into the renderer (see
    // `browser-builtin-registry.ts`) — they are not present in the on-disk
    // plugin directory, so the desktop shell must discover them through the
    // same registry walk the browser profile uses. Run it first so a failed
    // directory scan below still leaves the built-ins discovered.
    const discovered: DiscoveredPlugin[] = await this.scanBrowserBuiltins()
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

  /**
   * Register a single on-disk plugin (its full manifest + directory) into the
   * store, mirroring one iteration of the desktop's `scanPlugins` disk loop.
   * Used by the CLI host (`cli/src/plugin/host.ts`), which discovers
   * `~/.cognia/plugins/<id>` in Node — the desktop's Tauri `plugin_scan_directory`
   * path doesn't run there. Idempotent: re-registering an existing id refreshes
   * its discovery projection without re-installing. Signature enforcement is left
   * to `loadPlugin` (the CLI disables it by policy for in-tree-style plugins).
   */
  async registerDiskPlugin(manifest: PluginManifest, dir: string): Promise<void> {
    const store = usePluginStore.getState()

    const validation = validatePluginManifest(manifest, {
      governanceMode: this.pluginPointGovernanceMode,
    })
    if (!validation.valid) {
      throw new Error(`Invalid plugin manifest: ${(validation.errors || []).join(", ")}`)
    }

    const compatibility = this.applyCompatibilityPolicy(manifest, `disk:${manifest.id}`)
    const capabilityContractDiagnostics = this.extractCapabilityContractDiagnostics(
      validation.diagnostics || []
    )
    const runtimeDiagnostics = this.collectRuntimeProfileDiagnostics(manifest)

    const existing = store.plugins[manifest.id]
    const projection = this.buildDiscoveryProjection(
      manifest,
      dir,
      "local",
      [...capabilityContractDiagnostics, ...compatibility.diagnostics, ...runtimeDiagnostics],
      this.collectObservedSources(existing)
    )

    store.discoverPlugin(manifest, projection.source, dir, {
      installRootKind: projection.installRootKind,
      compatibilityDiagnostics: projection.compatibilityDiagnostics,
      descriptor: projection.descriptor,
    })

    if (!existing) {
      await store.installPlugin(manifest.id)
    }

    this.registerPluginPermissions(manifest.id, manifest.permissions || [])
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
    const type = options?.type || "local"

    const txn: InstallTransactionState = {
      pluginId: null,
      pluginPath: null,
      manifest: null,
      stepsCompleted: {
        backendInstall: false,
        storeDiscovery: false,
        storeInstall: false,
        permissionRegistration: false,
      },
    }

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
      return await this.registerBackendInstall(result, type, txn)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.performInstallRollback(txn, reason).catch((rollbackErr) => {
        loggers.manager.error(
          `[plugin:${txn.pluginId || "(unknown)"}] install rollback itself failed`,
          rollbackErr
        )
      })
      throw new Error(`Failed to install plugin: ${reason}`)
    }
  }

  /**
   * Register a plugin that a Tauri backend command has already unpacked to
   * disk (`plugin_install`, `plugin_install_from_github`, …). Runs manifest
   * validation, compatibility + signature checks, store discovery/install,
   * verification recording, and permission registration — the shared tail
   * every backend install path needs so the in-memory store stays the
   * single UI-facing authority. Throws on any failure; the caller owns the
   * surrounding try/catch + `performInstallRollback`.
   */
  private async registerBackendInstall(
    result: {
      manifest: PluginManifest
      path: string
      source?: PluginSource
      installRootKind?: PluginInstallRootKind
    },
    type: "local" | "git" | "marketplace",
    txn: InstallTransactionState
  ): Promise<Plugin> {
    const store = usePluginStore.getState()
    txn.pluginId = result.manifest.id
    txn.pluginPath = result.path
    txn.manifest = result.manifest
    txn.stepsCompleted.backendInstall = true

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
    txn.stepsCompleted.storeDiscovery = true

    await store.installPlugin(result.manifest.id)
    txn.stepsCompleted.storeInstall = true

    this.recordPluginVerification(result.manifest.id, {
      status: "installed",
      action: "install",
      stage: "installation",
      successful: true,
      resolvedVersion: result.manifest.version,
    })

    try {
      this.registerPluginPermissions(result.manifest.id, result.manifest.permissions || [])
      txn.stepsCompleted.permissionRegistration = true
    } catch (error) {
      // Permission registration is normally infallible (in-memory map +
      // Dexie write); surface it explicitly so a misconfigured permission
      // table doesn't silently leave the plugin half-armed.
      throw new Error(
        `Permission registration failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (result.manifest.type === "wasm") {
      await this.preloadWasmComponent(result.manifest, result.path)
    }

    return store.plugins[result.manifest.id]
  }

  /**
   * Install a build-free plugin straight from a public GitHub repo. The
   * Rust `plugin_install_from_github` command downloads the repo tarball,
   * validates the manifest + entry artifacts, and unpacks it; we then run
   * the shared `registerBackendInstall` tail and persist the README /
   * LICENSE / source metadata onto the Dexie row for the detail UI.
   *
   * Tauri-only — the caller (GitHub install dialog) gates on
   * `canUseTauriInvoke()`.
   */
  async installPluginFromGithub(repo: string, gitRef?: string, subdir?: string): Promise<Plugin> {
    const txn: InstallTransactionState = {
      pluginId: null,
      pluginPath: null,
      manifest: null,
      stepsCompleted: {
        backendInstall: false,
        storeDiscovery: false,
        storeInstall: false,
        permissionRegistration: false,
      },
    }

    try {
      const result = await invoke<{
        manifest: PluginManifest
        path: string
        source?: PluginSource
        installRootKind?: PluginInstallRootKind
        readme?: string | null
        licenseText?: string | null
        repo: string
        gitRef: string
      }>("plugin_install_from_github", { repo, gitRef, subdir })

      const plugin = await this.registerBackendInstall(
        {
          manifest: result.manifest,
          path: result.path,
          source: result.source ?? ("git" as PluginSource),
          installRootKind: result.installRootKind,
        },
        "git",
        txn
      )

      // Persist README / LICENSE text + the resolved source URL so the
      // detail views can render them offline. Non-fatal: the install itself
      // already succeeded, so a metadata-write hiccup must not fail it.
      try {
        const sourceUrl = `https://github.com/${result.repo}${
          result.gitRef ? `/tree/${result.gitRef}` : ""
        }`
        await updatePlugin(result.manifest.id, {
          readme: result.readme ?? undefined,
          licenseText: result.licenseText ?? undefined,
          sourceUrl,
        })
      } catch (error) {
        loggers.manager.warn(
          `[plugin:${result.manifest.id}] failed to persist GitHub source metadata`,
          { error: error instanceof Error ? error.message : String(error) }
        )
      }

      return plugin
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.performInstallRollback(txn, reason).catch((rollbackErr) => {
        loggers.manager.error(
          `[plugin:${txn.pluginId || "(unknown)"}] install rollback itself failed`,
          rollbackErr
        )
      })
      throw new Error(`Failed to install plugin: ${reason}`)
    }
  }

  /**
   * Undo whichever steps of `installPlugin` completed before a later
   * step threw. Best-effort and idempotent — individual cleanup
   * failures are logged but don't prevent the remaining steps from
   * running, because the goal is to leave the system as close to its
   * pre-install state as possible even when the host is partly
   * misbehaving.
   *
   * Dispatches a `plugin:error` event so the UI sees a single toast
   * for the failure instead of having to inspect the catch site.
   */
  private async performInstallRollback(
    txn: InstallTransactionState,
    reason: string
  ): Promise<void> {
    const store = usePluginStore.getState()
    const pluginId = txn.pluginId
    const pluginName = txn.manifest?.name

    if (txn.stepsCompleted.permissionRegistration && pluginId) {
      try {
        await this.revokePluginPermissions(pluginId, txn.manifest?.permissions || [])
        getPermissionGuard().unregisterPlugin(pluginId)
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] rollback: revoke permissions failed`, err)
      }
    }

    if (pluginId && txn.manifest?.type === "wasm") {
      try {
        clearWasmCapabilityGrant(pluginId)
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] rollback: clear WASM grant failed`, err)
      }
    }

    if (
      (txn.stepsCompleted.storeDiscovery || txn.stepsCompleted.storeInstall) &&
      pluginId &&
      store.plugins[pluginId]
    ) {
      try {
        await store.uninstallPlugin(pluginId, {
          skipFileRemoval: true,
          viaManager: false,
        })
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] rollback: store cleanup failed`, err)
      }
    }

    if (txn.stepsCompleted.backendInstall && pluginId && txn.pluginPath) {
      try {
        await invoke("plugin_uninstall", {
          pluginId,
          pluginPath: txn.pluginPath,
        })
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] rollback: backend uninstall failed`, err)
        dispatchPluginError({
          pluginId,
          pluginName,
          stage: "install-rollback",
          message: err instanceof Error ? err.message : String(err),
          severity: "error",
          recoverable: false,
        })
      }
    }

    if (pluginId) {
      dispatchPluginError({
        pluginId,
        pluginName,
        stage: "install",
        message: reason,
        severity: "error",
        recoverable: true,
      })
    }
  }

  /**
   * Public install-rollback hook for callers that succeeded at
   * `manager.installPlugin` but then failed at a later step (e.g.
   * `runMarketplaceInstall` persisting plugin config). Idempotent —
   * safe to call even if the plugin already isn't there. The intended
   * caller is `lib/plugin/marketplace/install-flow.ts`.
   */
  async rollbackInstallation(pluginId: string, reason: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin) {
      // Nothing to roll back. Still fire the error so the UI knows.
      dispatchPluginError({
        pluginId,
        stage: "install",
        message: reason,
        severity: "error",
        recoverable: true,
      })
      return
    }
    await this.performInstallRollback(
      {
        pluginId,
        pluginPath: plugin.path,
        manifest: plugin.manifest,
        stepsCompleted: {
          backendInstall: true,
          storeDiscovery: true,
          storeInstall: true,
          permissionRegistration: true,
        },
      },
      reason
    )
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
      // same error in a more actionable place if it persists. Promote to
      // the user-facing error bus as a warning so the toast nudges the
      // user toward checking the diagnostics rather than failing silently.
      dispatchPluginError({
        pluginId: manifest.id,
        pluginName: manifest.name,
        stage: "wasm-preload",
        message,
        severity: "warning",
        recoverable: true,
      })
    }
  }

  /**
   * Publish a plugin-lifecycle event on the global message bus so plugins
   * subscribed via `ctx.events.bus` actually receive them. The bus was wired
   * into the plugin context long ago, but the host never emitted any
   * `SystemEvents` — this closes that gap. Best-effort: a bus failure must
   * never block a lifecycle transition.
   */
  private emitLifecycleEvent(
    eventType: (typeof SystemEvents)[keyof typeof SystemEvents],
    pluginId: string,
    extra?: Record<string, unknown>
  ): void {
    try {
      getMessageBus().emitFromSystem(eventType, { pluginId, ...extra })
    } catch (error) {
      loggers.manager.warn(`[manager] failed to emit ${eventType} for ${pluginId}:`, error)
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

      // Built-in plugins are statically bundled into the renderer (path
      // `builtin://<id>`, no on-disk signature.json) and trusted by
      // construction. The scan path (`scanBrowserBuiltins`) never verifies
      // them, so the enable path must exempt them too — otherwise the
      // default-on `requireSignatures` policy rejects every built-in with
      // "Signature required but not found".
      if (
        plugin.source !== "builtin" &&
        !(await this.verifyPluginSignature(plugin.path, pluginId))
      ) {
        throw new Error(`Signature verification failed for plugin ${pluginId}`)
      }

      this.registerPluginPermissions(pluginId, plugin.manifest.permissions || [])

      // Seed declarative-config defaults into the persisted row BEFORE building
      // the context, so the plugin's activate() sees `ctx.configuration.get()`
      // values without waiting for the user to open the settings form. Skipped
      // (no write) when nothing changes — `seedPluginConfigDefaults` returns the
      // same reference. Best-effort: a seeding failure must not block the load.
      try {
        const seeded = seedPluginConfigDefaults(plugin.manifest, plugin.config)
        if (seeded !== plugin.config) {
          plugin.config = seeded
          store.setPluginConfig?.(pluginId, seeded)
          void setPluginConfig(pluginId, seeded)
        }
      } catch (error) {
        loggers.manager.warn(`[plugin:${pluginId}] config default seeding failed (ignored):`, error)
      }

      // Load the plugin module — wrapped in the resilience layer so a transient
      // load failure (fetch/IPC) retries with backoff, while permanent errors
      // (bad export / unknown type / signature) fail fast. Validation,
      // compatibility, and signature checks above are intentionally OUTSIDE the
      // retry boundary. Wrapping `loader.load` (not the loader internals)
      // preserves the loader's module cache + in-flight dedupe: a failed attempt
      // clears `loadingPromises`, so a retry is a genuinely fresh load.
      const loadBreaker = getOrCreateBreaker(loadBreakerKey(pluginId), {
        failureThreshold: LOAD_RESILIENCE.breaker.failureThreshold,
        cooldownMs: LOAD_RESILIENCE.breaker.cooldownMs,
        successThreshold: LOAD_RESILIENCE.breaker.successThreshold,
      })
      recordLoadAttempt(pluginId)
      const definition = await runResilient(() => this.loader.load(plugin), {
        timeoutMs: LOAD_RESILIENCE.timeoutMs,
        maxRetries: LOAD_RESILIENCE.maxRetries,
        retryable: true,
        breaker: loadBreaker,
        label: loadBreakerKey(pluginId),
        isRetryable: isRetryableLoadError,
        // attempt 1 is the first try; 2+ are retries.
        onAttempt: (attempt) => {
          if (attempt > 1) recordLoadRetry(pluginId)
        },
      })
      recordLoadSuccess(pluginId, Date.now())
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

      // Only python/hybrid plugins carry a Python module — wasm (and
      // vscode-extension) types have their own runtimes and must not be
      // routed through the Python host.
      if (plugin.manifest.type === "python" || plugin.manifest.type === "hybrid") {
        await this.loadPythonPlugin(pluginId)
      }

      // WASM plugins declare their agent tools in the manifest (the WIT
      // contract has no tool-listing export) and implement a single
      // `tool-execute` dispatcher. Project those declarations into runnable
      // tools so the agent can actually call them — without this they were
      // declared but unreachable.
      if (plugin.manifest.type === "wasm") {
        this.registerWasmTools(pluginId)
      }

      // Update store status
      await store.loadPlugin(pluginId, { viaManager: false })
      await this.syncBackendStatus(pluginId, "loaded")
      await this.hooksManager.dispatchOnLoad(pluginId)
      // Fire onInstall (first load after install) / onUpdate (version changed)
      // exactly once per transition. Persisted on the Dexie row so it survives
      // restarts. Failures here must never fail the load — wrap log-only.
      await this.fireInstallOrUpdateHooks(pluginId, plugin.manifest.version)
      // Register the plugin with the inter-plugin IPC manager so its permission
      // map + method registry exist, then announce the load on the event bus.
      getPluginIPC().registerPlugin(pluginId, plugin.manifest.permissions ?? [])
      this.emitLifecycleEvent(SystemEvents.PLUGIN_LOADED, pluginId)
      this.recordPluginVerification(pluginId, {
        status: "loaded",
        action: "load",
        stage: "activation",
        successful: true,
      })
    } catch (error) {
      recordLoadFailure(pluginId, error, Date.now())
      store.setPluginError(pluginId, String(error))
      // Surface the failure on the plugin message bus alongside the four sibling
      // lifecycle events (LOADED/ENABLED/DISABLED/UNLOADED). PII red-line: carry
      // only the bounded error CLASS name (Error / TypeError / …), never
      // error.message — subscribers get a typed signal, not user/prompt text.
      this.emitLifecycleEvent(SystemEvents.PLUGIN_ERROR, pluginId, {
        error: error instanceof Error ? error.name : "Error",
      })
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
    // Dedupe concurrent enables of the same plugin onto one in-flight promise.
    const inflight = this.enableInFlight.get(pluginId)
    if (inflight) return inflight
    const run = this.enablePluginInner(pluginId, reason)
    this.enableInFlight.set(pluginId, run)
    try {
      await run
    } finally {
      this.enableInFlight.delete(pluginId)
    }
  }

  private async enablePluginInner(pluginId: string, reason: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    if (plugin.status === "enabled") {
      return
    }

    // Required-dependency gate (load-order, ADR-0017/0032 parity): reject a
    // missing / disabled / version-mismatched / cyclic required dependency
    // before doing any load work. Runs outside the try below so the typed
    // `PluginDependencyError` surfaces to callers instead of being wrapped.
    this.assertRequiredDependenciesSatisfied(pluginId)

    // Auto-enable required dependencies first so this plugin can rely on them
    // at activate() time. The gate above already rejected missing / cyclic
    // deps, so this recursion is bounded and only descends into satisfiable,
    // not-yet-enabled dependencies (each call early-returns once enabled).
    for (const depId of Object.keys(plugin.manifest.dependencies ?? {})) {
      const dep = store.plugins[depId]
      if (dep && dep.status !== "enabled") {
        await this.enablePlugin(depId, "dependency")
      }
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

      // Mirror the now-active plugin's declared permissions into the Rust
      // ledger so the host-side gates honour them (best-effort, async).
      void this.mirrorDeclaredPermissionsToLedger(pluginId, plugin.manifest.permissions || [])

      // Push the declared shell-command allowlist so the host's deny-by-default
      // shell:execute gate knows which programs this plugin may run.
      void this.syncShellAllowlistToHost(pluginId, plugin.manifest.shellCommands || [])

      // Push the declared network egress allowlist (if any) so the host clamps
      // this plugin's fetch/download/upload to its allowedDomains.
      if (plugin.manifest.networkAccess?.allowedDomains) {
        void this.syncNetworkAllowlistToHost(pluginId, plugin.manifest.networkAccess.allowedDomains)
      }

      // Register plugin contributions
      await this.registerPluginContributions(pluginId)

      // Notify the plugin it is now enabled. A throw here propagates into the
      // catch below, which rolls back the contributions just registered — the
      // plugin reports enable failure rather than silently half-enabling.
      await this.hooksManager.dispatchOnEnable(pluginId)

      // Clear any stale resilience breakers from a prior lifecycle so the
      // freshly-enabled plugin starts with closed circuits.
      resetPluginBreakers(pluginId)
      await this.syncBackendStatus(pluginId, "enabled")
      this.emitLifecycleEvent(SystemEvents.PLUGIN_ENABLED, pluginId)
      // Start the idle sweep if this plugin opted in and the sweep isn't running
      // yet (covers plugins enabled after initialize()). Idempotent.
      if (plugin.manifest.idleSuspend === true) {
        this.startIdleSweep()
      }
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
      // Notify the plugin it is about to be disabled BEFORE we tear anything
      // down, so its handler can still flush state through its live APIs. A
      // throw must not abort the teardown — log it and continue (the plugin
      // doesn't get to veto disable).
      await this.safeDispatchLifecycleHook(pluginId, "onDisable")

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
      // Drop any "always allow this session" consent grants so disabling a
      // plugin actually revokes them — otherwise a dangerous-permission grant
      // (e.g. shell:execute) silently outlives disable and is inherited on
      // re-enable within the same app session.
      getPluginConsentBroker().clearSessionGrantsForPlugin(pluginId)
      // Drop the plugin's resilience circuit breakers so a re-enable starts
      // from a clean (closed) state rather than inheriting a tripped breaker.
      resetPluginBreakers(pluginId)
      await this.syncBackendStatus(pluginId, "disabled")
      this.emitLifecycleEvent(SystemEvents.PLUGIN_DISABLED, pluginId)
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
      // Notify the plugin its module is being unloaded. Fired here — before any
      // teardown — because this is the only point where the plugin's hooks are
      // still registered on every unload path (the enabled→unload path below
      // unregisters them inside disablePlugin). Log-only: unload cannot be vetoed.
      await this.safeDispatchLifecycleHook(pluginId, "onUnload")

      // Disable first if enabled
      if (plugin.status === "enabled") {
        await this.disablePlugin(pluginId, "unload")
      } else {
        await this.deactivatePluginRuntime(pluginId, { unloadModule: true })
        await this.unregisterPluginContributions(pluginId)
      }

      // Terminal isolation cleanup — runs on EVERY unload path so a plugin
      // returning to "installed" never leaks permission-guard registration,
      // i18n bundles, or WASM capability grants. `disablePlugin` already drops
      // i18n + revokes grants on the enabled→unload path; these calls are
      // idempotent and additionally cover the loaded→unload / disabled→unload
      // paths (and clear guard tiers + denials, which previously only happened
      // on uninstall).
      getPermissionGuard().unregisterPlugin(pluginId)
      getPluginIPC().unregisterPlugin(pluginId)
      unregisterPluginI18n(pluginId)
      clearWasmCapabilityGrant(pluginId)
      getPluginConsentBroker().clearSessionGrantsForPlugin(pluginId)

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
      this.emitLifecycleEvent(SystemEvents.PLUGIN_UNLOADED, pluginId)
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
      // Last-chance notification BEFORE teardown + file removal, while the
      // plugin's hooks are still registered (unloadPlugin below unregisters
      // them). A never-activated ("installed"-only) plugin has no live handler,
      // so this is a no-op for it. Log-only: uninstall cannot be vetoed.
      await this.safeDispatchLifecycleHook(pluginId, "onUninstall")

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

      // Purge the plugin's secrets (uninstall is terminal — unlike disable,
      // which keeps them for re-enable). Best-effort: never block uninstall.
      try {
        await clearPluginSecrets(pluginId)
      } catch (error) {
        loggers.manager.warn(
          `[plugin:${pluginId}] secret purge on uninstall failed (ignored):`,
          error
        )
      }

      await this.revokePluginPermissions(pluginId, plugin.manifest.permissions || [])
      getPermissionGuard().unregisterPlugin(pluginId)
      if (plugin.manifest.type === "wasm") {
        clearWasmCapabilityGrant(pluginId)
      }
      getPluginConsentBroker().clearSessionGrantsForPlugin(pluginId)
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

  /**
   * Fire a no-veto lifecycle hook used on teardown / host-driven paths. A
   * throwing plugin handler must never abort host cleanup, so the error is
   * logged + recorded as a silent failure and swallowed.
   */
  private async safeDispatchLifecycleHook(
    pluginId: string,
    hook: "onDisable" | "onUnload" | "onUninstall" | "onSuspend" | "onResume"
  ): Promise<void> {
    try {
      switch (hook) {
        case "onDisable":
          await this.hooksManager.dispatchOnDisable(pluginId)
          break
        case "onUnload":
          await this.hooksManager.dispatchOnUnload(pluginId)
          break
        case "onUninstall":
          await this.hooksManager.dispatchOnUninstall(pluginId)
          break
        case "onSuspend":
          await this.hooksManager.dispatchOnSuspend(pluginId)
          break
        case "onResume":
          await this.hooksManager.dispatchOnResume(pluginId)
          break
      }
    } catch (error) {
      loggers.manager.warn(`[plugin:${pluginId}] ${hook} hook threw (ignored):`, error)
      recordSilentFailure(
        pluginId,
        { site: `manager.${hook}`, message: `${hook} lifecycle hook threw`, expected: false },
        error
      )
    }
  }

  /**
   * After a successful load, fire `onInstall` (first load ever) or `onUpdate`
   * (manifest version changed since the last activated version) exactly once,
   * tracking state on the Dexie row so it survives restarts. Plugins without a
   * persisted row (cannot track) are skipped to avoid re-firing every launch.
   * Never throws — a misbehaving handler must not fail the load.
   */
  private async fireInstallOrUpdateHooks(pluginId: string, currentVersion: string): Promise<void> {
    try {
      const row = await getPlugin(pluginId)
      if (!row) return
      if (row.installHookFiredAt == null) {
        await this.hooksManager.dispatchOnInstall(pluginId)
        await updatePlugin(pluginId, {
          installHookFiredAt: Date.now(),
          lastActivatedVersion: currentVersion,
        })
        return
      }
      const lastVersion = row.lastActivatedVersion
      if (lastVersion && lastVersion !== currentVersion) {
        await this.hooksManager.dispatchOnUpdate(pluginId, {
          fromVersion: lastVersion,
          toVersion: currentVersion,
        })
      }
      if (lastVersion !== currentVersion) {
        await updatePlugin(pluginId, { lastActivatedVersion: currentVersion })
      }
    } catch (error) {
      loggers.manager.warn(
        `[plugin:${pluginId}] install/update hook dispatch failed (ignored):`,
        error
      )
    }
  }

  /**
   * Idle-suspend an enabled plugin: tear down its contributions + runtime to
   * reclaim resources while preserving the user's enabled intent (the store
   * `enabled` flag stays true; status becomes "suspended"; permissions + i18n
   * stay registered so resume is cheap). Fires `onSuspend`. No-op unless the
   * plugin is currently enabled. Resume happens on the next activation event.
   */
  async suspendPlugin(pluginId: string, reason: string = "idle"): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin || plugin.status !== "enabled") {
      return
    }
    try {
      // Fire while hooks are still registered, before any teardown.
      await this.safeDispatchLifecycleHook(pluginId, "onSuspend")
      await this.unregisterPluginContributions(pluginId)
      await this.deactivatePluginRuntime(pluginId, { unloadModule: true })
      this.hooksManager.unregisterHooks(pluginId)
      this.contexts.delete(pluginId)
      store.setPluginStatus?.(pluginId, "suspended")
      // The backend ledger has no "suspended" state — treat it as inactive.
      await this.syncBackendStatus(pluginId, "disabled")
      this.recordPluginVerification(pluginId, {
        status: "suspended",
        action: "suspend",
        stage: "cleanup",
        successful: true,
        metadata: { reason },
      })
      loggers.manager.debug(`[plugin:${pluginId}] suspended (${reason})`)
    } catch (error) {
      store.setPluginError(pluginId, String(error))
      loggers.manager.error(`[plugin:${pluginId}] suspend failed (${reason})`, error)
      throw error
    }
  }

  /**
   * Reactivate a suspended plugin: re-load its module and re-register its
   * contributions, mirroring the enable activation path, then fire `onResume`.
   * Permissions + i18n were never torn down on suspend, so they are still live.
   * No-op unless the plugin is currently suspended.
   */
  async resumePlugin(pluginId: string, reason: string = "activation"): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin || plugin.status !== "suspended") {
      return
    }
    try {
      await this.loadPlugin(pluginId)
      await this.registerPluginContributions(pluginId)
      store.setPluginStatus?.(pluginId, "enabled")
      await this.syncBackendStatus(pluginId, "enabled")
      await this.safeDispatchLifecycleHook(pluginId, "onResume")
      this.recordPluginVerification(pluginId, {
        status: "enabled",
        action: "resume",
        stage: "activation",
        successful: true,
        metadata: { reason },
      })
      loggers.manager.debug(`[plugin:${pluginId}] resumed (${reason})`)
    } catch (error) {
      try {
        await this.unregisterPluginContributions(pluginId)
      } catch {
        /* idempotent rollback */
      }
      store.setPluginError(pluginId, String(error))
      loggers.manager.error(`[plugin:${pluginId}] resume failed (${reason})`, error)
      throw error
    }
  }

  /**
   * Suspend every enabled plugin that opted in (`manifest.idleSuspend === true`)
   * and has been idle past the threshold. Pure-policy decision is delegated to
   * `lib/plugin/core/idle-policy.ts`; this method performs the suspends. Returns
   * the ids it suspended. Safe to call on an interval or scheduler tick.
   */
  async suspendIdlePlugins(nowMs: number = Date.now()): Promise<string[]> {
    const store = usePluginStore.getState()
    const suspended: string[] = []
    for (const plugin of Object.values(store.plugins)) {
      if (plugin.status !== "enabled") continue
      if (plugin.manifest.idleSuspend !== true) continue
      if (!isPluginSuspendEligible({ lastUsedAt: plugin.lastUsedAt, nowMs })) continue
      const id = plugin.manifest.id
      try {
        await this.suspendPlugin(id, "idle")
        suspended.push(id)
      } catch (error) {
        loggers.manager.warn(`[plugin:${id}] idle suspend failed (ignored):`, error)
      }
    }
    return suspended
  }

  /**
   * Start the periodic idle sweep, but only when at least one plugin opted into
   * `idleSuspend` (no timer otherwise). Idempotent. The timer is `unref`'d so it
   * never keeps the Node/Tauri process or a test runner alive.
   */
  startIdleSweep(): void {
    if (this.idleSweepTimer) return
    const anyOptIn = Object.values(usePluginStore.getState().plugins).some(
      (p) => p.manifest.idleSuspend === true
    )
    if (!anyOptIn || typeof setInterval !== "function") return
    this.idleSweepTimer = setInterval(() => {
      void this.suspendIdlePlugins()
    }, IDLE_SWEEP_INTERVAL_MS)
    ;(this.idleSweepTimer as { unref?: () => void }).unref?.()
  }

  /** Stop the periodic idle sweep (lifecycle teardown / tests). Idempotent. */
  stopIdleSweep(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = null
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

  /**
   * Push silent-tier declared permissions to the Rust ledger via
   * `plugin_permission_grant`, so the host-side gates (Python exec, WASM caps,
   * the native API gateway) see them. Called on ENABLE — declared permissions
   * become host grants only when the plugin is actually active, not at mere
   * discovery/scan time. Dangerous (confirm-tier) permissions are NOT
   * pre-granted host-side — they require interactive consent, which writes the
   * ledger with `grantedBy: "user"` on approval. Idempotent (the Rust command
   * de-dupes on re-enable). No-op in web mode.
   */
  private async mirrorDeclaredPermissionsToLedger(
    pluginId: string,
    permissions: PluginPermission[]
  ): Promise<void> {
    if (!canUseTauriInvoke()) return
    const guard = getPermissionGuard()
    for (const permission of permissions) {
      if (guard.getTier(pluginId, permission) !== "silent") continue
      try {
        await grantPluginPermission(pluginId, permission, "manifest")
      } catch (error) {
        recordSilentFailure(
          pluginId,
          {
            site: "manager.registerPluginPermissions.mirror",
            message: `Could not mirror declared permission "${permission}" to the host ledger.`,
            expected: !canUseTauriInvoke(),
          },
          error
        )
      }
    }
  }

  /**
   * Push a plugin's declared `manifest.shellCommands` to the Rust host so the
   * deny-by-default `shell:execute` gate can enforce the allowlist. Called on
   * ENABLE alongside the permission mirror. Best-effort; no-op in web mode
   * (where there is no shell backend at all).
   */
  private async syncShellAllowlistToHost(pluginId: string, commands: string[]): Promise<void> {
    if (!canUseTauriInvoke()) return
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin_set_shell_allowlist", { pluginId, commands })
    } catch (error) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.syncShellAllowlistToHost",
          message: "Could not push the shell-command allowlist to the host.",
          expected: !canUseTauriInvoke(),
        },
        error
      )
    }
  }

  /**
   * Push a plugin's declared `manifest.networkAccess.allowedDomains` to the
   * Rust host so its `network:*` egress gate clamps to those domains. Called on
   * ENABLE only when the plugin declared an allowlist (otherwise egress stays
   * unrestricted). Best-effort; no-op in web mode.
   */
  private async syncNetworkAllowlistToHost(pluginId: string, domains: string[]): Promise<void> {
    if (!canUseTauriInvoke()) return
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("plugin_set_network_allowlist", { pluginId, domains })
    } catch (error) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.syncNetworkAllowlistToHost",
          message: "Could not push the network egress allowlist to the host.",
          expected: !canUseTauriInvoke(),
        },
        error
      )
    }
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

    const viewEvents = rawEvents
      .filter((event) => event.startsWith("onView:"))
      .map((event) => event.slice("onView:".length))
      .filter(Boolean)

    // VS Code-style `onUri`: the plugin activates when a deep-link addressed to
    // it arrives. Accept the bare `onUri` and the `onUri:*` wildcard form.
    const uriActivation = rawEvents.some((event) => event === "onUri" || event.startsWith("onUri:"))

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
      viewEvents,
      uriActivation,
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

    if (event.startsWith("onTool:")) {
      const tool = event.slice("onTool:".length)
      return spec.toolEvents.some((pattern) => this.matchesActivation(pattern, tool))
    }

    if (event.startsWith("onView:")) {
      const view = event.slice("onView:".length)
      return spec.viewEvents.some((pattern) => this.matchesActivation(pattern, view))
    }

    if (event.startsWith("onUri:")) {
      // The router fires `onUri:<pluginId>`; only the addressed plugin that
      // declared `onUri` activates.
      const targetPluginId = event.slice("onUri:".length)
      return spec.uriActivation && targetPluginId === manifest.id
    }

    // Unknown runtime event prefix — never activate (previously this fell
    // through to an `onTool:` slice, mis-matching non-tool events).
    return false
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

      const pluginId = plugin.manifest.id
      // Activation circuit breaker: a plugin that throws on every matching
      // event would otherwise be re-attempted (and toast-spammed) on every
      // tool call / command forever. After repeated failures the breaker opens
      // and we skip re-running its activation until the cooldown half-opens it
      // (automatic recovery if the plugin was fixed/reloaded). Gate lives ONLY
      // here, so a manual user-initiated enablePlugin is never breaker-suppressed.
      const breaker = getOrCreateBreaker(activationBreakerKey(pluginId), {
        failureThreshold: LOAD_RESILIENCE.breaker.failureThreshold,
        cooldownMs: LOAD_RESILIENCE.breaker.cooldownMs,
        successThreshold: LOAD_RESILIENCE.breaker.successThreshold,
      })
      if (!breaker.canPass()) {
        loggers.manager.debug(
          `[plugin:${pluginId}] activation suppressed for "${event}" (circuit open)`
        )
        continue
      }

      this.activationInFlight.add(pluginId)
      try {
        // A suspended plugin is resumed (fires onResume, reuses its preserved
        // permissions/i18n) rather than re-enabled, so it sees a transparent
        // wake — not a fresh enable.
        if (plugin.status === "suspended") {
          await this.resumePlugin(pluginId, `activation:${event}`)
        } else {
          await this.enablePlugin(pluginId, `activation:${event}`)
        }
        breaker.recordSuccess()
      } catch (error) {
        // No longer swallowed: surface the failure everywhere the user/auditor
        // can see it, and feed the breaker so chronic failures self-suppress.
        breaker.recordFailure()
        const message = error instanceof Error ? error.message : String(error)
        recordActivationFailure(pluginId, event, error, Date.now())
        usePluginStore.getState().setPluginError(pluginId, message)
        dispatchPluginError({
          pluginId,
          pluginName: plugin.manifest.name || pluginId,
          stage: "activation",
          message,
          severity: "error",
          recoverable: true,
        })
        recordSilentFailure(
          pluginId,
          {
            site: "manager.handleActivationEvent",
            message: `activation failed for "${event}"`,
            expected: false,
          },
          error
        )
        loggers.manager.warn(`[plugin:${pluginId}] activation failed for event "${event}":`, error)
      } finally {
        this.activationInFlight.delete(pluginId)
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
      // `plugin_set_status` writes the status ledger; `plugin_set_state`
      // (the previously-invoked command) only persists opaque runtime_state and
      // ignored the status entirely, so this sync was a silent no-op.
      await invoke("plugin_set_status", { pluginId, status })
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
      // The Rust command returns PermissionGrant objects; tolerate the legacy
      // string form too so revoke enumerates every granted permission.
      const granted = await invoke<Array<string | { permission: string }>>(
        "plugin_permission_list",
        { pluginId }
      )
      for (const entry of granted) {
        const permission = typeof entry === "string" ? entry : entry?.permission
        if (permission) permissionSet.add(permission)
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
        await revokePluginPermission(pluginId, permission)
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

    if (plugin && (plugin.manifest.type === "python" || plugin.manifest.type === "hybrid")) {
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

    // Drop the plugin's live inter-plugin messaging so a deactivated plugin
    // stops receiving IPC/events and a re-enable/resume doesn't accumulate
    // duplicate subscriptions. This is the non-destructive clear (subscriptions
    // + exposed methods + event-bus listeners) shared by disable / unload /
    // suspend — it deliberately leaves the IPC registration + permissions in
    // place. Full unload additionally calls `getPluginIPC().unregisterPlugin`
    // to drop registration/permissions/breakers (see `unloadPlugin`).
    getPluginIPC().unsubscribe(pluginId)
    getPluginIPC().unexpose(pluginId)
    getMessageBus().offAll(pluginId)

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
        // Refresh the idle-suspend clock on command invocation (mirrors the
        // tool-dispatch refresh in agent-integration.ts) so command-driven
        // plugins aren't suspended between uses.
        usePluginStore.getState().updateLastUsedAt(pluginId)
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

    // Theme packs — register the applyable bundles into the theme-pack
    // registry. The bridge method exists but was never called from enable
    // (ADR-0029 wiring gap); packs become discoverable via `listThemePacks()`.
    if (plugin.manifest.themePacks?.length) {
      this.ensureThemesBridge().registerPluginThemePacks(
        pluginId,
        plugin.manifest.name,
        plugin.manifest
      )
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

    // Async module-bridge capabilities (ai/ocr/workspace/message-renderer/
    // connectors/fonts/wallpapers). Each bridge dynamic-imports a lazy
    // factory module or reads the plugin's loaded exports, so this is an
    // awaited loop. Field-gated; per-descriptor try/catch keeps one bad
    // bridge from blocking the rest (each bridge also isolates per-entry
    // failures internally). This is the wiring these bridges always lacked.
    const moduleBridgeCtx = {
      pluginId,
      manifest: plugin.manifest,
      installRoot: plugin.path ?? "",
      importer: (entry: string) => this.loader.importEntry(entry),
      resolveAsset: await createPluginAssetResolver(),
      moduleExports: this.loader.getModuleExports(pluginId) ?? {},
    }
    for (const cap of MODULE_BRIDGE_CAPABILITY_KEYS) {
      const descriptor = MODULE_BRIDGE_CAPABILITIES[cap]
      const entries = plugin.manifest[descriptor.manifestField] as
        | ReadonlyArray<unknown>
        | undefined
      if (!entries?.length) continue
      try {
        await descriptor.register(moduleBridgeCtx)
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] failed to register ${cap} bridge:`, err)
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

    // VS Code `contributes.languages[]` projected onto the manifest
    // (`manifest.vscodeLanguages`). Registered through languages-bridge so the
    // ids surface in Monaco + cognia's filename → language detection. Bespoke
    // (not in the overlay/module bridge maps) because it has no capability key
    // and the renderer-side Monaco sync (vscode-loader) consumes the registry.
    if (plugin.manifest.vscodeLanguages?.length) {
      try {
        const { registerLanguagesForPlugin } = await import("@/lib/plugin/bridge/languages-bridge")
        registerLanguagesForPlugin(pluginId, plugin.manifest.vscodeLanguages)
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] failed to register VS Code languages:`, err)
      }
    }

    // Declarative CLI wrapper tools (`manifest.cliTools`) — materialized
    // into ordinary registry tools whose execute() runs the safety pipeline
    // in `lib/plugin/cli-tools/execute-cli-tool.ts` (consent → binary
    // trust → injection-proof argv → audit). Registered through the same
    // registry + store as runtime tools, so both the in-process and the
    // sidecar dispatch paths pick them up, and the disable-side
    // `plugin.tools` cleanup loop unregisters them for free.
    if (plugin.manifest.cliTools?.length) {
      const requiresBinaries = plugin.manifest.requires?.binaries ?? []
      const publisherFingerprint = plugin.manifest.author?.publicKey
      for (const def of plugin.manifest.cliTools) {
        const cliTool: PluginTool = {
          name: `${pluginId}:${def.name}`,
          pluginId,
          definition: {
            name: def.name,
            description: def.description,
            parametersSchema: def.parameters,
          },
          execute: async (toolArgs: Record<string, unknown>, _context: PluginToolContext) => {
            const { executeCliTool } = await import("@/lib/plugin/cli-tools/execute-cli-tool")
            return executeCliTool(pluginId, def, toolArgs, {
              pluginPath: plugin.path ?? "",
              requiresBinaries,
              publisherFingerprint,
            })
          },
        }
        this.registry.registerTool(pluginId, cliTool)
        store.registerPluginTool(pluginId, cliTool)
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

  /**
   * Import a module relative to a plugin's install root using the loader's
   * proven 3-strategy resolver (Tauri asset-protocol → fetch+eval → script
   * tag). Public so non-manager hosts — e.g. the `configComponent` renderer
   * in the settings panel — can resolve a plugin's lazy entry the same way
   * the module-bridge loop does, instead of a bare `import()` that mishandles
   * Tauri asset paths.
   */
  importPluginEntry(entry: string): Promise<Record<string, unknown>> {
    return this.loader.importEntry(entry)
  }

  private async unregisterPluginContributions(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) return

    this.a2uiBridge?.unregisterPluginComponents(pluginId)
    this.a2uiBridge?.unregisterPluginTemplates(pluginId)
    this.themesBridge?.unregisterPluginThemes(pluginId)
    this.themesBridge?.unregisterPluginThemePacks(pluginId)
    // GC any `CustomTheme` rows the plugin created via `ctx.theme.registerCustomTheme`.
    // The manifest-themes path above handles in-memory plugin themes; this
    // line handles the persistent Dexie-backed rows. Both are required to
    // avoid orphan entries lingering after disable.
    clearCustomThemesForPluginContext(pluginId)
    clearPluginExtensions(pluginId)
    // Drop the plugin's imperatively-registered deep-link handler (C2).
    unregisterUriHandlersByPlugin(pluginId)
    // Async module-bridge capabilities — drop every contribution. Includes
    // message renderers, which the standalone `purgeMessagePartRenderersForPlugin`
    // call previously handled (the bridge unregister calls the same
    // `clearMessagePartRenderersForPlugin`, so this is behaviour-identical),
    // plus the 6 bridges whose disable cleanup was never wired before.
    for (const cap of MODULE_BRIDGE_CAPABILITY_KEYS) {
      await MODULE_BRIDGE_CAPABILITIES[cap].unregister(pluginId)
    }
    // Drop the cached `manifest.configComponent` module so a re-enable (or a
    // hot-reload during dev) re-imports the component instead of serving a
    // stale closure. The settings host falls back to the schema form until
    // the plugin re-registers.
    invalidateConfigComponentForPlugin(pluginId)

    // Drop VS Code language contributions; the Monaco sync (vscode-loader)
    // subscribes to the registry and disposes the corresponding monaco
    // registration when this emits an `unregister` event.
    if (plugin.manifest.vscodeLanguages?.length) {
      try {
        const { unregisterLanguagesByPlugin } = await import("@/lib/plugin/bridge/languages-bridge")
        unregisterLanguagesByPlugin(pluginId)
      } catch {
        // Bridge import can fail in extremely early teardown — best effort.
      }
    }

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
    // Workflow node executors + plugin triggers are a bespoke (non-overlay)
    // capability registered through `ctx.workflow.registerNode/registerTrigger`.
    // Tear them down here so a disabled plugin's node kinds disappear from the
    // editor + runtime. Previously this was never called from the disable flow,
    // leaking executors (a disabled plugin's code kept running on its kinds).
    await teardownPluginWorkflowRegistrations(pluginId)
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

    // Shortcut cleanup — unbinds every chord the plugin registered via
    // `ctx.shortcuts.register(...)` or a quick-action `accelerator`. The
    // bridge unbinds the OS rail + removes wrapper commands in one pass.
    try {
      const { unbindAllPluginShortcuts } =
        await import("@/lib/plugin/shortcuts/plugin-shortcut-bridge")
      unbindAllPluginShortcuts(pluginId)
    } catch {
      // optional dep — tests without the bridge wired
    }

    // Context-menu cleanup — drops every renderer-side item the plugin
    // registered via `ctx.contextMenu.register(...)`.
    try {
      const { unregisterContextMenuItemsByPlugin } =
        await import("@/lib/plugin/context-menu/registry")
      unregisterContextMenuItemsByPlugin(pluginId)
    } catch {
      // optional dep — tests without the registry wired
    }

    // Guardrail cleanup (Package B) — drop every guardrail the plugin
    // registered via `ctx.agent.guardrails.register(...)`.
    try {
      const { unregisterGuardrailsByPlugin } =
        await import("@/lib/plugin/registries/guardrail-registry")
      unregisterGuardrailsByPlugin(pluginId)
    } catch {
      // optional dep — tests without the registry wired
    }

    // Context-provider cleanup (Package E) — drop every provider the plugin
    // registered via `ctx.agent.context.registerProvider(...)`.
    try {
      const { unregisterContextProvidersByPlugin } =
        await import("@/lib/plugin/registries/context-provider-registry")
      unregisterContextProvidersByPlugin(pluginId)
    } catch {
      // optional dep — tests without the registry wired
    }

    // Command-safety cleanup — drop every command rule the plugin contributed
    // via `ctx.terminal.registerCommandSafetyRule(...)`. Idempotent no-op for
    // plugins that never registered any.
    try {
      const { unregisterPluginCommandRules } =
        await import("@/lib/plugin/registries/command-safety-registry")
      unregisterPluginCommandRules(pluginId)
    } catch {
      // optional dep — safe to ignore in environments without it wired
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
    if (!this.config.enablePython) {
      throw new PythonRuntimeDisabledError(pluginId)
    }

    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin || plugin.manifest.type === "frontend") {
      throw new Error(`Plugin ${pluginId} is not a Python plugin`)
    }

    try {
      // Host-level settings are user state on the Dexie row; absent in
      // tests/web mode is fine (backend defaults apply).
      const hostSettings = await getPythonHostSettings(pluginId).catch(() => undefined)

      // ADR-0028 Phase 3 — default the OS-sandbox flag from the global toggle
      // when the plugin hasn't chosen one. Stays `null` (backend defaults) when
      // neither per-plugin settings nor the global sandbox are set, so the
      // common no-config path is unchanged.
      let sandboxDefault = false
      try {
        const { useSettingsStore } = await import("@/stores/settings")
        sandboxDefault = useSettingsStore.getState().settings?.sandboxDefaultEnabled ?? false
      } catch {
        // Settings store unavailable (web/test) — leave the backend default.
      }
      const effectiveHostSettings: PythonHostSettings | null =
        hostSettings || sandboxDefault
          ? { ...(hostSettings ?? {}), sandboxed: hostSettings?.sandboxed ?? sandboxDefault }
          : null

      // Load Python plugin via the subprocess host. The reply surfaces the
      // plugin's declared @hook handlers for TS-side dispatch.
      const loadResult = await invoke<PythonLoadResult | null>("plugin_python_load", {
        pluginId,
        pluginPath: plugin.path,
        mainModule: plugin.manifest.pythonMain,
        dependencies: plugin.manifest.pythonDependencies,
        config: plugin.config ?? null,
        hostSettings: effectiveHostSettings,
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

      // Register python @hook handlers into the hooks system so host-side
      // dispatch reaches the interpreter.
      this.registerPythonHooks(pluginId, loadResult?.hooks ?? [])
    } catch (error) {
      store.setPluginError(pluginId, String(error))
      throw error
    }
  }

  /**
   * Register a WASM plugin's declared `manifest.tools` as runnable tools whose
   * `execute` routes through the guest's `tool-execute` export. Mirrors the
   * Python tool registration but sources the definitions declaratively (the WIT
   * contract exposes no tool-listing export). Idempotent: the registry de-dupes
   * on tool name, and the store replaces any same-named entry.
   */
  private registerWasmTools(pluginId: string): void {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin) return
    for (const tool of buildWasmToolDefinitions(plugin.manifest)) {
      this.registry.registerTool(pluginId, tool)
      store.registerPluginTool(pluginId, tool)
    }
  }

  /**
   * Bridge python `@hook` declarations into the JS hooks system: each
   * declared (event, name) pair becomes a `PluginHooks` entry whose
   * implementation RPCs `plugin_python_call_hook`. For hybrid plugins the
   * JS-side hooks win on name collision (python fills the gaps) — the JS
   * module is the richer runtime and already registered at activation.
   */
  private registerPythonHooks(pluginId: string, declarations: PythonHookDeclaration[]): void {
    if (declarations.length === 0) {
      return
    }
    const pythonHooks: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    for (const { event, name } of declarations) {
      if (typeof event !== "string" || event.length === 0 || typeof name !== "string") {
        continue
      }
      pythonHooks[event] = async (...args: unknown[]) =>
        invoke("plugin_python_call_hook", {
          pluginId,
          event,
          name,
          // call_hook carries one payload value; multi-arg hook signatures
          // pack their args as an array.
          payload: args.length <= 1 ? (args[0] ?? null) : args,
        })
    }
    if (Object.keys(pythonHooks).length === 0) {
      return
    }
    this.validateHookDeclarations(pluginId, pythonHooks as PluginHooks)

    const store = usePluginStore.getState()
    const existing = (store.plugins[pluginId]?.hooks ?? {}) as PluginHooks
    const merged = { ...pythonHooks, ...existing } as PluginHooks
    store.registerPluginHooks(pluginId, merged)
    this.hooksManager.registerHooks(pluginId, merged)
  }

  /**
   * Invoke one python `@hook` handler directly (used by hook dispatch and
   * tests; regular dispatch flows through the hooks system registration).
   */
  async callPythonHook<T>(
    pluginId: string,
    event: string,
    name: string,
    payload: unknown
  ): Promise<T> {
    return invoke<T>("plugin_python_call_hook", { pluginId, event, name, payload: payload ?? null })
  }

  /**
   * Deliver a plugin's persisted config to its live python host
   * (`on_config_updated`). A demoted host picks it up at respawn.
   */
  async pushPythonConfig(pluginId: string, config: Record<string, unknown>): Promise<void> {
    await invoke("plugin_python_push_config", { pluginId, config })
  }

  /**
   * Create the plugin's venv (if missing) and pip-install its declared
   * dependencies, streaming progress into the log buffer. Callers MUST
   * obtain explicit user consent first (network + disk side effects).
   */
  async installPythonDeps(pluginId: string, dependencies: string[]): Promise<void> {
    await invoke("plugin_python_install_deps", { pluginId, dependencies })
  }

  /** Host-level python settings (persisted on the Dexie plugins row). */
  async getPythonHostSettings(pluginId: string): Promise<PythonHostSettings | undefined> {
    return getPythonHostSettings(pluginId)
  }

  /**
   * Persist host-level python settings. Applied on the next (re)load of the
   * plugin's host — callers wanting them live immediately reload the plugin.
   */
  async setPythonHostSettings(pluginId: string, settings: PythonHostSettings): Promise<void> {
    await setPythonHostSettings(pluginId, settings)
  }

  /**
   * Config-change fan-out: dispatch the JS `onConfigChange` hook and push
   * the new config into a python/hybrid plugin's host. Call after
   * persisting via `setPluginConfig`.
   */
  async notifyPluginConfigChanged(
    pluginId: string,
    config: Record<string, unknown>
  ): Promise<void> {
    this.hooksManager.dispatchOnConfigChange(pluginId, config)
    // Fan out to imperative `ctx.configuration.onChange` subscribers (this is
    // the single choke for ALL config changes — settings form or ctx.update).
    emitPluginConfigChange(pluginId, config)
    const plugin = usePluginStore.getState().plugins[pluginId]
    const type = plugin?.manifest.type
    if (type === "python" || type === "hybrid") {
      try {
        await this.pushPythonConfig(pluginId, config)
      } catch (error) {
        // Not loaded / web mode — config still lands via import at next load.
        loggers.manager.warn(`[manager] python config push failed for ${pluginId}:`, String(error))
      }
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
