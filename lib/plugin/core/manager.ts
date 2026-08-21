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
  Plugin,
  PluginInstallRootKind,
  PluginManifest,
  PluginSource,
  PluginContext,
  PluginHooks,
  PluginCommand,
  PluginPermission,
  PluginActivationEvent,
  PluginManifestCommandDef,
  PluginManifestDexieBlock,
  PluginTool,
  PluginToolContext,
  PluginRuntimeProfile,
  PluginStatus,
  PluginVerificationAction,
  PluginVerificationDiagnostic,
  PluginVerificationSnapshot,
  PluginVerificationStage,
  PythonHookDeclaration,
  PythonHostSettings,
  PythonLoadResult,
  PluginChildLifecycleAPI,
  PluginOptionalServiceListener,
} from "@/types/plugin"
import { PluginLoader } from "@/lib/plugin/core/loader"
import {
  PluginServiceRegistry,
  pluginServiceRegistry,
  type PluginServiceEvaluation,
  type PluginServiceRecord,
} from "@/lib/plugin/core/service-registry"
import { PluginRegistry } from "@/lib/plugin/core/registry"
import {
  createFullPluginContext,
  createWorkflowAPI,
  teardownPluginWorkflowRegistrations,
  type FullPluginContext,
} from "@/lib/plugin/core/context"
import { buildExtensionDescriptor } from "@/lib/plugin/core/descriptor"
import { createPluginA2UIBridge, type PluginA2UIBridge } from "@/lib/plugin/bridge/a2ui-bridge"
import { PluginThemesBridge } from "@/lib/plugin/bridge/themes-bridge"
import { PluginLifecycleHooks, getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { isPluginSuspendEligible } from "@/lib/plugin/core/idle-policy"
import { seedPluginConfigDefaults } from "@/lib/plugin/core/config-defaults"
import {
  isInherentlyTrustedFrontendSource,
  readPolicy,
  writePolicy,
} from "@/lib/plugin/core/plugins-policy-storage"
import { emitPluginConfigChange } from "@/lib/plugin/api/config-api"
import { clearPluginSecrets } from "@/lib/plugin/api/secrets-api"
import { createWorkspaceAPI } from "@/lib/plugin/api/workspace-api"

/** How often the idle sweep runs (only active when a plugin opts into idleSuspend). */
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** Upper bound for a plugin's `activate()` (W6.1). */
const ACTIVATE_TIMEOUT_MS = 30_000

/**
 * Upper bound for a lifecycle hook (`onSuspend` / `onResume` / `onDisable` /
 * `onUnload` / `onUninstall`). Without it a hook that never resolves wedges the
 * caller: a hung `onSuspend` in particular would stall the sequential idle
 * sweep and leave the plugin stuck `enabled` with no teardown. Same order as
 * `ACTIVATE_TIMEOUT_MS` — a lifecycle hook that runs longer is a bug.
 */
const LIFECYCLE_HOOK_TIMEOUT_MS = 30_000
const MANUAL_ENABLE_ONLY_BUILTINS = new Set(["github-delivery"])
import { getMessageBus, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { getPluginIPC } from "@/lib/plugin/messaging/ipc"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import {
  applyPluginTables,
  removePluginTables,
  restorePluginTables,
} from "@/lib/plugin/dexie/bridge"
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
  compareAndSetPluginLifecycle,
  upsertPlugin,
  getPlugin,
  setPluginEnabled,
  setPluginConfig,
  getPythonHostSettings,
  setPythonHostSettings,
} from "@/lib/db/plugins"
import { appendPythonEvent, type PythonPluginEvent } from "@/lib/plugin/python/log-buffer"
import {
  bindPythonRuntimeGeneration,
  unbindPythonRuntimeGeneration,
} from "@/lib/plugin/python/runtime-generation"
import { clearPluginExtensions } from "@/lib/plugin/api/extension-api"
import { loadPluginStyles, removePluginStyles } from "@/lib/plugin/styles/plugin-stylesheet"
import { unregisterUriHandlersByPlugin } from "@/lib/plugin/uri/uri-handler-registry"
import {
  evaluatePluginCompatibility,
  type CompatibilityDiagnostic,
  type CompatibilityRuntime,
} from "@/lib/plugin/core/compatibility"
import { withTimeout } from "@cognia/primitives"
import { loggers } from "@/lib/plugin/core/logger"
import { createPluginVerificationSnapshot } from "@/lib/plugin/core/verification"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import {
  advancePluginActivationProgress,
  beginPluginActivationProgress,
  cancelPluginActivationProgress,
  completePluginActivationProgress,
  failPluginActivationProgress,
} from "@/stores/plugin-runtime/plugin-activation-progress-store"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { grantPluginPermission, revokePluginPermission } from "./transport"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import {
  applyWasmCapabilityGrant,
  clearWasmCapabilityGrant,
  reconcileWasmGrantLedgerWithManifest,
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
import {
  getBrowserBuiltinRegistry,
  getBrowserBuiltinRegistryEntry,
} from "./browser-builtin-registry"
import { buildWasmNodeDefs, buildWasmToolDefinitions, callWasmExport } from "./wasm-loader"
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
import { refreshAllPackWarnings } from "@/lib/plugin/registries/character-pack-registry"
import { assertPluginManifestParity } from "./manifest-parity"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { registerExtensionsForPlugin } from "@/lib/plugin/bridge/extension-bridge"
import { clearCustomThemesForPluginContext } from "@/lib/plugin/api/theme-api"
import {
  clearTemplatesForPluginContext,
  registerLegacyPluginTemplateCompatibility,
  registerPluginTemplatePackages,
} from "@/lib/plugin/api/templates-api"
import { getTemplateRuntime } from "@/lib/templates/runtime"
import {
  dispatchPluginError,
  PLUGIN_ENABLE_FAILED_EVENT,
  type PluginEnableFailedEventDetail,
} from "@/lib/plugin/error-bus"
import { PluginDisposableScope } from "./disposable-scope"
import {
  InMemoryPluginLifecycleStateAdapter,
  PluginLifecycleRevisionError,
  createPersistentPluginLifecycleStateAdapter,
  type PluginActualState,
  type PluginDirtyDiagnostic,
  type PluginIntent,
  type PluginLifecyclePatch,
  type PluginLifecycleRecord,
  type PluginLifecycleStateAdapter,
} from "./lifecycle-state"
import {
  PluginLifecycleCoordinator,
  pluginLifecycleCoordinator,
  type PluginActivationLease,
  type PluginGraphReservation,
  type PluginLifecycleCoordinatorSnapshot,
} from "./lifecycle-coordinator"

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
  /** Host-neutral native lifecycle transport for Node-target plugins. */
  nodeHostInvoker?: import("../launcher/launchPluginJs").PluginJsHostInvoker
  /** Host-neutral native event subscription transport for Node-target plugins. */
  nodeHostSubscriber?: <T>(
    event: string,
    handler: (payload: T) => void
  ) => Promise<() => void> | (() => void)
  /**
   * Max plugins enabled concurrently within a single dependency layer at
   * startup restore. Bounds the thundering-herd of module loads against the
   * sidecar. Default 4. Tests pin it to 1 for deterministic ordering.
   */
  maxLoadConcurrency?: number
  activationTimeoutMs?: number
  pendingRegistrationGraceMs?: number
  /** Host-specific durable lifecycle control-plane storage. */
  lifecycleStateAdapter?: PluginLifecycleStateAdapter
  /** Shared within one host realm; injectable for isolated tests/dev hosts. */
  lifecycleCoordinator?: PluginLifecycleCoordinator
  managerId?: string
  /** Stage-gated lifecycle features; omitted features keep legacy behavior. */
  lifecycleFeatures?: {
    ledgerV2?: boolean
    runtimeServices?: boolean
    scopedRealms?: boolean
  }
  serviceRegistry?: PluginServiceRegistry
}

/** Default concurrency for layered startup restore. */
const DEFAULT_MAX_LOAD_CONCURRENCY = 4
let pluginManagerSequence = 0
const PLUGIN_HOST_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/**
 * Runtimes whose resources cannot outlive the host realm that created them.
 *
 * `frontend` is renderer closures. `native` is a `ctx.webview` / `ctx.window` /
 * `ctx.worker` handle, which the shell destroys along with the webview that
 * opened it. Neither has a generation-aware probe, so both are retired on a
 * host-epoch change instead — the same argument, and the same trade-off, in
 * both cases.
 *
 * `native` used to be excluded from that rule while also being excluded from
 * the isolated-runtime probe list, which left it with NO recovery path at all:
 * `missingRuntimeProbe` was unconditionally true for it, so a plugin that once
 * failed teardown holding a window handle stayed `dirty` across every restart
 * and refused to activate forever — and the Recover button in the plugin
 * detail header could not clear it either.
 */
function isHostScopedRuntime(runtime: PluginDirtyDiagnostic["runtime"]): boolean {
  return runtime === "frontend" || runtime === "native"
}

interface DiscoveredPlugin {
  manifest: PluginManifest
  path: string
  source: PluginSource
  descriptor?: ExtensionDescriptor
}

/**
 * Wire shape of one entry from `plugin_get_all` / `plugin_runtime_snapshot`,
 * mirroring the Rust `PluginRuntimeSnapshot`
 * (crates/cognia-plugin-runtime/src/lib.rs).
 *
 * The struct carries no `serde(rename_all)`, so the fields stay **snake_case**
 * on the wire, and the two `Option` fields have no `skip_serializing_if`, so
 * they are always present (as `null`). `status` is a free-form `String` on the
 * Rust side — validate it with `isPluginStatus` before handing it to a typed
 * store setter. Deliberately minimal: TS owns all the rich metadata, so there
 * is no manifest, path, or source here to discover a plugin from.
 */
interface PluginRuntimeSnapshot {
  plugin_id: string
  version: string
  status: string
  last_error: string | null
  loaded_at: string | null
  install_path: string
}

/**
 * Every `PluginStatus`, as a keyed record rather than an array.
 *
 * The record shape is the point: `Record<PluginStatus, true>` makes a member
 * added to the union a compile error here, whereas `readonly PluginStatus[]`
 * only asks that the entries *be* statuses and says nothing about covering
 * them. Under the array, a new status would have narrowed to `false` in
 * `isPluginStatus` and `reconcileWithRuntimeLedger` would have silently skipped
 * every plugin the native runtime reported in it — a stale status in the store
 * with no error anywhere.
 */
const PLUGIN_STATUSES: Record<PluginStatus, true> = {
  discovered: true,
  installed: true,
  loading: true,
  loaded: true,
  enabling: true,
  enabled: true,
  disabling: true,
  disabled: true,
  suspended: true,
  unloading: true,
  error: true,
  updating: true,
}

/** Narrow the runtime ledger's free-form status string to the typed union. */
function isPluginStatus(value: unknown): value is PluginStatus {
  return typeof value === "string" && Object.hasOwn(PLUGIN_STATUSES, value)
}

type PluginActivationRuntimeEvent =
  "startup" | `onCommand:${string}` | `onTool:${string}` | `onView:${string}` | `onUri:${string}`

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

interface OptionalServiceSubscription {
  pluginId: string
  serviceId: string
  generation: number
  listener: PluginOptionalServiceListener
  child?: PluginDisposableScope
  refreshSequence: number
  refreshQueue: Promise<void>
}

/**
 * Mutable progress record passed through `installPlugin`. Each step the
 * pipeline completes flips a boolean here; if a later step throws, the
 * catch block uses this record to undo only the work that actually
 * landed (no double-revoke, no remove-of-things-never-added).
 *
 * Kept narrow on purpose — install only needs to undo a handful of
 * side effects (`plugin_install` Tauri call, store row, permission
 * grants, WASM preload). Runtime teardown deliberately has no shallow
 * resurrection path: once teardown starts, old effects stay detached.
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
  generation: string
  sdk_version: string
  protocol_version: string
  contract_version: string
  runtime_id: string
  capabilities: string[]
  legacy_adapter: boolean
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

export class PluginDependencyInUseError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly blockedBy: readonly string[]
  ) {
    super(
      `Cannot stop plugin "${pluginId}": required by ${blockedBy
        .map((dependentId) => `"${dependentId}"`)
        .join(", ")}`
    )
    this.name = "PluginDependencyInUseError"
  }
}

export class PluginIntentDisabledError extends Error {
  constructor(public readonly pluginId: string) {
    super(`Plugin "${pluginId}" is explicitly disabled`)
    this.name = "PluginIntentDisabledError"
  }
}

export class PluginDirtyRuntimeError extends Error {
  constructor(public readonly pluginId: string) {
    super(`Plugin "${pluginId}" has unconfirmed runtime resources; recover it before activation`)
    this.name = "PluginDirtyRuntimeError"
  }
}

/**
 * Thrown when a `frontend`/`hybrid` plugin from a source that is not
 * inherently trusted (`local`/`marketplace`/`git`) is loaded before the user
 * has explicitly trusted it (ADR 0013 frontend trust boundary). These plugins
 * execute un-sandboxed JavaScript in the renderer realm, so the load is
 * refused outright rather than degraded. Typed so UI callers can point the
 * user at the trust toggle instead of showing a generic load failure.
 */
export class PluginFrontendTrustError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly source: PluginSource
  ) {
    super(
      `Cannot load plugin "${pluginId}": it runs un-sandboxed JavaScript in the renderer and comes from the untrusted source "${source}". Grant it explicit trust in the plugin's Permissions tab to load it.`
    )
    this.name = "PluginFrontendTrustError"
  }
}

/**
 * Hooks that intercept the user↔model conversation (prompts, tool calls,
 * tool results). Declaring ANY of these requires the high-risk
 * `hooks:chat-intercept` manifest permission — enforced in
 * `validateHookDeclarations`.
 */
export const CHAT_INTERCEPT_HOOKS = [
  "onUserPromptSubmit",
  "onPreToolUse",
  "onPostToolUse",
  "onMessageSend",
  "onMessageReceive",
] as const

// =============================================================================
// Plugin Manager Singleton + Factory (PR-E)
// =============================================================================

let pluginManagerInstance: PluginManager | null = null
let pluginManagerInitialization: Promise<PluginManager> | null = null

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
  if (pluginManagerInitialization) {
    return pluginManagerInitialization
  }
  if (pluginManagerInstance?.isInitialized()) {
    return pluginManagerInstance
  }

  const manager = pluginManagerInstance ?? createPluginManager(config)
  pluginManagerInstance = manager
  pluginManagerInitialization = manager.initialize().then(() => manager)
  try {
    return await pluginManagerInitialization
  } catch (error) {
    if (pluginManagerInstance === manager) pluginManagerInstance = null
    throw error
  } finally {
    pluginManagerInitialization = null
  }
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
  pluginManagerInstance?.stopIdleSweep()
  pluginManagerInstance = null
  pluginManagerInitialization = null
}

/**
 * Tear down the module-level manager (W6.5): stops the periodic idle sweep
 * (previously never wired into any dispose path, leaking the interval across
 * app teardown / HMR) and drops the instance so the next
 * `initializePluginManager()` starts fresh.
 */
export function disposePluginManager(): void {
  pluginManagerInstance?.stopIdleSweep()
  pluginManagerInstance = null
  pluginManagerInitialization = null
}

/**
 * Produce a structured-clone-safe copy of a plugin manifest for persistence
 * into the Dexie `plugins` table. Some manifests carry live runtime objects
 * whose members are functions (e.g. a `sharedMemoryAdapters[]` adapter's
 * `write`/`read`/`delete`). IndexedDB's structured-clone algorithm throws
 * `DataCloneError` on functions, which would abort the whole discovery-row
 * write. A JSON round-trip drops every function-valued (and otherwise
 * non-serializable) property while preserving the serializable metadata the
 * discovery UI actually reads. Falls back to the original object only if the
 * manifest is somehow not JSON-encodable, letting the caller's try/catch log it.
 */
export function toClonableManifest(manifest: PluginManifest): PluginManifest {
  try {
    return JSON.parse(JSON.stringify(manifest)) as PluginManifest
  } catch {
    return manifest
  }
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
  private contexts: Map<string, FullPluginContext> = new Map()
  private disposableScopes: Map<string, PluginDisposableScope> = new Map()
  private readonly runtimeCleanupFailures = new Map<
    string,
    { runtime: PluginDirtyDiagnostic["runtime"]; error: unknown; runtimeGeneration?: string }
  >()
  private readonly activationLeases = new Map<string, PluginActivationLease>()
  private readonly pythonRuntimeGenerations = new Map<string, string>()
  private readonly pendingPythonEvents = new Map<string, PythonPluginEvent[]>()
  private readonly lifecycleState: PluginLifecycleStateAdapter
  private readonly lifecycleCoordinator: PluginLifecycleCoordinator
  private readonly managerId: string
  private readonly serviceRegistry: PluginServiceRegistry
  private readonly optionalServiceRefreshes = new Set<string>()
  private readonly pendingOptionalServiceConsumers = new Map<string, string[]>()
  private readonly optionalServiceSubscriptions = new Map<
    string,
    Map<string, Set<OptionalServiceSubscription>>
  >()
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

  /**
   * Per-plugin lifecycle serialization (W6.4). Enable/disable/unload/
   * uninstall for the SAME plugin chain onto one queue so transitions can't
   * interleave (e.g. an enable racing a disable and re-registering half the
   * contributions the disable just tore down). Different plugins stay fully
   * concurrent.
   */
  private lifecycleQueues: Map<string, Promise<unknown>> = new Map()

  private withLifecycleLock<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleQueues.get(pluginId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.lifecycleQueues.set(pluginId, tail)
    void tail.then(() => {
      if (this.lifecycleQueues.get(pluginId) === tail) {
        this.lifecycleQueues.delete(pluginId)
      }
    })
    return run
  }
  private warnedActivationEvents: Set<string> = new Set()
  private activationSpecCache = new WeakMap<PluginManifest, ParsedActivationSpec>()
  private activationPatternCache = new Map<string, RegExp>()
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null
  /** Guards against overlapping idle sweeps — one slow suspend must not let the
   * next interval tick start a second concurrent sweep on the same plugins. */
  private idleSweepRunning = false
  private initialized = false
  private compatibilityMode: "warn" | "block"
  private pluginPointGovernanceMode: PluginPointGovernanceMode
  private compatibilityRuntime: CompatibilityRuntime
  private runtimeProfile: PluginRuntimeProfile
  /** `plugin:python` Tauri event unlisten — set once by subscribePythonEvents. */
  private pythonEventsUnlisten: (() => void) | null = null

  constructor(config: PluginManagerConfig) {
    this.config = config
    this.managerId = config.managerId ?? `plugin-manager-${++pluginManagerSequence}`
    this.serviceRegistry =
      config.serviceRegistry ??
      (process.env.NODE_ENV === "test" ? new PluginServiceRegistry() : pluginServiceRegistry)
    this.lifecycleCoordinator =
      config.lifecycleCoordinator ??
      (process.env.NODE_ENV === "test"
        ? new PluginLifecycleCoordinator()
        : pluginLifecycleCoordinator)
    this.lifecycleState =
      config.lifecycleStateAdapter ??
      (process.env.NODE_ENV === "test"
        ? new InMemoryPluginLifecycleStateAdapter()
        : createPersistentPluginLifecycleStateAdapter({
            readRow: getPlugin,
            writeLifecycle: (pluginId, lifecycle) => updatePlugin(pluginId, { lifecycle }),
            compareAndWriteLifecycle: compareAndSetPluginLifecycle,
          }))
    this.loader = new PluginLoader({
      frontendImporter: config.frontendImporter,
      nodeHostInvoker: config.nodeHostInvoker,
    })
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

  private canInvokeNativeHost(): boolean {
    return Boolean(this.config.nodeHostInvoker) || canUseTauriInvoke()
  }

  private async invokeNativeHost<T = unknown>(
    command: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    if (this.config.nodeHostInvoker) {
      return this.config.nodeHostInvoker<T>(command, args)
    }
    return invoke<T>(command, args)
  }

  private requirePythonGeneration(pluginId: string): string {
    const generation = this.pythonRuntimeGenerations.get(pluginId)
    if (!generation) {
      throw new Error(`Python runtime generation is unavailable for ${pluginId}`)
    }
    return generation
  }

  private ingestPythonEvent(event: PythonPluginEvent): void {
    if (event.generation === "installation") {
      appendPythonEvent(event)
      return
    }
    const current = this.pythonRuntimeGenerations.get(event.pluginId)
    if (current) {
      if (event.generation === current) appendPythonEvent(event)
      return
    }
    if (!event.generation) return
    const pending = this.pendingPythonEvents.get(event.pluginId) ?? []
    pending.push(event)
    if (pending.length > 100) pending.splice(0, pending.length - 100)
    this.pendingPythonEvents.set(event.pluginId, pending)
  }

  private bindPythonGeneration(pluginId: string, generation: string): void {
    this.pythonRuntimeGenerations.set(pluginId, generation)
    bindPythonRuntimeGeneration(pluginId, generation)
    const pending = this.pendingPythonEvents.get(pluginId) ?? []
    this.pendingPythonEvents.delete(pluginId)
    for (const event of pending) {
      if (event.generation === generation) appendPythonEvent(event)
    }
  }

  getPluginDisposableScope(pluginId: string): PluginDisposableScope {
    const existing = this.disposableScopes.get(pluginId)
    if (existing) return existing
    const lease = this.activationLeases.get(pluginId)
    const scope = new PluginDisposableScope(pluginId, lease?.generation ?? 0, {
      pendingGraceMs: this.config.pendingRegistrationGraceMs,
    })
    this.disposableScopes.set(pluginId, scope)
    return scope
  }

  isPluginLedgerV2Enabled(): boolean {
    return this.config.lifecycleFeatures?.ledgerV2 !== false
  }

  createPluginServicesAPI(pluginId?: string): import("@/types/plugin").PluginServicesAPI {
    return {
      isAvailable: (serviceId) => this.serviceRegistry.isAvailable(serviceId),
      getProvider: (serviceId) => {
        const provider = this.serviceRegistry.getProvider(serviceId)
        return provider
          ? {
              pluginId: provider.providerPluginId,
              version: provider.version,
              generation: provider.generation,
            }
          : undefined
      },
      onOptionalServiceChange: (serviceId, listener) => {
        if (!pluginId) {
          throw new Error("Optional service subscriptions require an activated plugin context")
        }
        const plugin = usePluginStore.getState().plugins[pluginId]
        if (!plugin?.manifest.optionalServices?.[serviceId]) {
          throw new Error(`Plugin ${pluginId} does not declare optional service ${serviceId}`)
        }
        const lease = this.activationLeases.get(pluginId)
        if (!lease || !this.lifecycleCoordinator.isCurrent(lease)) {
          throw new Error(`Plugin ${pluginId} has no active lifecycle generation`)
        }
        const root = this.getPluginDisposableScope(pluginId)
        if (root.signal.aborted) {
          throw new Error(`Plugin ${pluginId} lifecycle is already stopping`)
        }
        const subscription: OptionalServiceSubscription = {
          pluginId,
          serviceId,
          generation: lease.generation,
          listener,
          refreshSequence: 0,
          refreshQueue: Promise.resolve(),
        }
        const byService = this.optionalServiceSubscriptions.get(pluginId) ?? new Map()
        const subscriptions = byService.get(serviceId) ?? new Set()
        subscriptions.add(subscription)
        byService.set(serviceId, subscriptions)
        this.optionalServiceSubscriptions.set(pluginId, byService)
        void this.refreshOptionalServiceSubscription(subscription)
        return root.track(async () => {
          subscriptions.delete(subscription)
          if (subscriptions.size === 0) byService.delete(serviceId)
          if (byService.size === 0) this.optionalServiceSubscriptions.delete(pluginId)
          await subscription.refreshQueue
          await subscription.child?.dispose()
        }, `ctx.services.onOptionalServiceChange:${serviceId}`)
      },
    }
  }

  getPluginServiceSnapshot(): PluginServiceRecord[] {
    return this.serviceRegistry.snapshot()
  }

  subscribePluginServices(
    listener: (snapshot: readonly PluginServiceRecord[]) => void
  ): () => void {
    return this.serviceRegistry.subscribe(listener)
  }

  private runtimeServicesEnabled(): boolean {
    return this.config.lifecycleFeatures?.runtimeServices === true
  }

  private scopedRealmsEnabled(): boolean {
    return this.config.lifecycleFeatures?.scopedRealms === true
  }

  private evaluatePluginServices(plugin: Plugin): PluginServiceEvaluation {
    return this.serviceRegistry.evaluate(
      plugin.manifest.requiresServices,
      plugin.manifest.optionalServices
    )
  }

  private requiredServiceCycle(pluginId: string): string[] | undefined {
    const manifests = Object.values(usePluginStore.getState().plugins).map((plugin) => ({
      id: plugin.manifest.id,
      providesServices: plugin.manifest.providesServices,
      requiresServices: plugin.manifest.requiresServices,
      optionalServices: plugin.manifest.optionalServices,
    }))
    return this.serviceRegistry
      .findRequiredCycles(manifests)
      .find((cycle) => cycle.includes(pluginId))
  }

  private async publishPluginServices(plugin: Plugin): Promise<void> {
    const generation = this.activationLeases.get(plugin.manifest.id)?.generation
    if (generation === undefined) return
    this.assertProvidedServiceContributionsCommitted(plugin)
    this.serviceRegistry.publishProvider(plugin.manifest.id, generation)
    this.publishLifecycleSnapshot(
      plugin.manifest.id,
      await this.lifecycleState.read(plugin.manifest.id)
    )
    await this.resumeWaitingServiceConsumers()
  }

  private async resumeWaitingServiceConsumers(): Promise<void> {
    const plugins = Object.values(usePluginStore.getState().plugins)
    for (const plugin of plugins) {
      const lifecycle = await this.getPluginLifecycleState(plugin.manifest.id)
      if (lifecycle.actual !== "waiting" || lifecycle.intent === "disabled") continue
      if (this.evaluatePluginServices(plugin).required.length > 0) continue
      await this.withLifecycleLock(plugin.manifest.id, () =>
        this.enablePluginInner(plugin.manifest.id, "service-available")
      )
    }
  }

  private async quiesceServiceConsumers(providerPluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const manifests = Object.values(store.plugins).map((plugin) => plugin.manifest)
    const consumerIds = this.serviceRegistry.consumersOf(providerPluginId, manifests)
    const optionalConsumerIds = this.serviceRegistry
      .optionalConsumersOf(providerPluginId, manifests)
      .filter((pluginId) => !consumerIds.includes(pluginId))
    this.pendingOptionalServiceConsumers.set(providerPluginId, optionalConsumerIds)
    this.serviceRegistry.markProviderDraining(
      providerPluginId,
      this.activationLeases.get(providerPluginId)?.generation
    )
    try {
      for (const consumerId of consumerIds) {
        const lifecycle = await this.getPluginLifecycleState(consumerId)
        if (lifecycle.intent === "disabled") continue
        await this.withLifecycleLock(consumerId, async () => {
          await this.disablePluginInner(consumerId, "service-draining")
          const stopped = await this.getPluginLifecycleState(consumerId)
          if (stopped.actual === "dirty") throw new PluginDirtyRuntimeError(consumerId)
          await this.setActualState(consumerId, "waiting", { lastError: undefined })
        })
      }
    } catch (error) {
      this.pendingOptionalServiceConsumers.delete(providerPluginId)
      const generation = this.activationLeases.get(providerPluginId)?.generation
      if (generation !== undefined) {
        this.serviceRegistry.publishProvider(providerPluginId, generation)
        await this.resumeWaitingServiceConsumers()
      }
      throw error
    }
  }

  private async flushOptionalServiceConsumers(providerPluginId: string): Promise<void> {
    const consumerIds = this.pendingOptionalServiceConsumers.get(providerPluginId) ?? []
    this.pendingOptionalServiceConsumers.delete(providerPluginId)
    if (this.scopedRealmsEnabled()) {
      await this.refreshScopedOptionalServiceConsumers(providerPluginId, consumerIds)
      return
    }
    for (const consumerId of consumerIds) {
      const lifecycle = await this.getPluginLifecycleState(consumerId)
      if (lifecycle.intent === "disabled" || lifecycle.actual !== "active") continue
      await this.withLifecycleLock(consumerId, async () => {
        await this.disablePluginInner(consumerId, "optional-service-draining")
        await this.enablePluginInner(consumerId, "optional-service-changed")
      })
      await this.flushOptionalServiceConsumers(consumerId)
    }
  }

  private async refreshOptionalServiceConsumers(providerPluginId: string): Promise<void> {
    if (this.optionalServiceRefreshes.has(providerPluginId)) return
    this.optionalServiceRefreshes.add(providerPluginId)
    try {
      const store = usePluginStore.getState()
      const manifests = Object.values(store.plugins).map((plugin) => plugin.manifest)
      const consumerIds = this.serviceRegistry.optionalConsumersOf(providerPluginId, manifests)
      if (this.scopedRealmsEnabled()) {
        await this.refreshScopedOptionalServiceConsumers(providerPluginId, consumerIds)
        return
      }
      for (const consumerId of consumerIds) {
        if (consumerId === providerPluginId) continue
        const lifecycle = await this.getPluginLifecycleState(consumerId)
        if (lifecycle.intent === "disabled" || lifecycle.actual !== "active") continue
        await this.withLifecycleLock(consumerId, async () => {
          await this.disablePluginInner(consumerId, "optional-service-available")
          await this.enablePluginInner(consumerId, "optional-service-changed")
        })
      }
    } finally {
      this.optionalServiceRefreshes.delete(providerPluginId)
    }
  }

  private async refreshScopedOptionalServiceConsumers(
    providerPluginId: string,
    consumerIds: readonly string[]
  ): Promise<void> {
    const provider = usePluginStore.getState().plugins[providerPluginId]
    const providedServices = new Set(Object.keys(provider?.manifest.providesServices ?? {}))
    for (const consumerId of consumerIds) {
      const subscriptions = this.optionalServiceSubscriptions.get(consumerId)
      if (!subscriptions) continue
      for (const [serviceId, listeners] of subscriptions) {
        if (!providedServices.has(serviceId)) continue
        for (const subscription of [...listeners]) {
          await this.refreshOptionalServiceSubscription(subscription)
        }
      }
    }
  }

  private async refreshOptionalServiceSubscription(
    subscription: OptionalServiceSubscription
  ): Promise<void> {
    const refresh = subscription.refreshQueue.then(() =>
      this.refreshOptionalServiceSubscriptionInner(subscription)
    )
    subscription.refreshQueue = refresh.catch(() => undefined)
    await refresh
  }

  private async refreshOptionalServiceSubscriptionInner(
    subscription: OptionalServiceSubscription
  ): Promise<void> {
    const lease = this.activationLeases.get(subscription.pluginId)
    if (
      !lease ||
      lease.generation !== subscription.generation ||
      !this.lifecycleCoordinator.isCurrent(lease)
    ) {
      return
    }
    if (subscription.child) {
      await subscription.child.dispose()
      if (subscription.child.hasUnresolvedResources()) {
        await this.setActualState(subscription.pluginId, "dirty", {
          dirty: this.buildDirtyDiagnostic(
            subscription.pluginId,
            `Optional service scope ${subscription.serviceId} cleanup was not confirmed`
          ),
        })
        return
      }
    }
    const root = this.disposableScopes.get(subscription.pluginId)
    if (!root || root.signal.aborted) return
    subscription.refreshSequence += 1
    const child = root.createChildScope(
      `optional:${subscription.serviceId}:${subscription.refreshSequence}`
    )
    subscription.child = child
    const provider = this.serviceRegistry.getProvider(subscription.serviceId)
    const lifecycle: PluginChildLifecycleAPI = {
      token: child.token,
      signal: child.signal,
      onDispose: (dispose, label) => {
        child.track(dispose, label ?? `ctx.services.optional:${subscription.serviceId}:onDispose`)
      },
    }
    try {
      const dispose = await child.trackPendingWork(
        Promise.resolve().then(() =>
          subscription.listener({
            serviceId: subscription.serviceId,
            provider: provider
              ? {
                  pluginId: provider.providerPluginId,
                  version: provider.version,
                  generation: provider.generation,
                }
              : undefined,
            lifecycle,
          })
        ),
        `ctx.services.optional:${subscription.serviceId}:listener-pending`
      )
      if (typeof dispose === "function") {
        child.track(dispose, `ctx.services.optional:${subscription.serviceId}:listener`)
      }
    } catch (error) {
      recordSilentFailure(
        subscription.pluginId,
        {
          site: "manager.optionalServiceChange",
          message: `Optional service listener failed for ${subscription.serviceId}.`,
          expected: false,
        },
        error
      )
      await child.dispose()
    }
  }

  private ensureActivationLease(pluginId: string): PluginActivationLease {
    const current = this.activationLeases.get(pluginId)
    if (current && this.lifecycleCoordinator.isCurrent(current)) return current
    const lease = this.lifecycleCoordinator.acquire(this.managerId, pluginId)
    this.activationLeases.set(pluginId, lease)
    return lease
  }

  private releaseActivationLease(pluginId: string): void {
    const lease = this.activationLeases.get(pluginId)
    if (!lease) return
    this.lifecycleCoordinator.release(lease)
    this.activationLeases.delete(pluginId)
  }

  private ownsCurrentGeneration(pluginId: string): boolean {
    const lease = this.activationLeases.get(pluginId)
    return !lease || this.lifecycleCoordinator.isCurrent(lease)
  }

  async getPluginLifecycleState(pluginId: string): Promise<PluginLifecycleRecord> {
    return this.lifecycleState.read(pluginId)
  }

  async getPluginLifecycleSnapshot(
    pluginId: string
  ): Promise<PluginLifecycleCoordinatorSnapshot | undefined> {
    const lifecycle = await this.lifecycleState.read(pluginId)
    this.publishLifecycleSnapshot(pluginId, lifecycle)
    return this.lifecycleCoordinator.getSnapshot(pluginId)
  }

  subscribePluginLifecycleSnapshots(
    listener: (snapshot: readonly PluginLifecycleCoordinatorSnapshot[]) => void
  ): () => void {
    return this.lifecycleCoordinator.subscribe(listener)
  }

  getPluginLifecycleSnapshots(): PluginLifecycleCoordinatorSnapshot[] {
    return this.lifecycleCoordinator.snapshot()
  }

  reservePluginRuntimeGraph(pluginId: string): PluginGraphReservation {
    return this.lifecycleCoordinator.reserveProviderDrain(this.managerId, pluginId)
  }

  releasePluginRuntimeGraph(reservation: PluginGraphReservation): boolean {
    return this.lifecycleCoordinator.releaseProviderDrain(reservation)
  }

  async reloadPlugin(pluginId: string, reason = "hot-reload"): Promise<void> {
    const reservation = this.reservePluginRuntimeGraph(pluginId)
    try {
      const lifecycle = await this.lifecycleState.read(pluginId)
      if (lifecycle.actual === "dirty") {
        throw new Error(`Plugin ${pluginId} has unresolved runtime resources`)
      }
      const plugin = usePluginStore.getState().plugins[pluginId]
      if (!plugin) throw new Error(`Plugin not found: ${pluginId}`)
      const shouldReactivate = plugin.status === "enabled" || plugin.status === "suspended"
      if (shouldReactivate) {
        await this.disablePlugin(pluginId, `${reason}-quiesce`)
      }
      await this.unloadPlugin(pluginId)
      if (shouldReactivate && (await this.lifecycleState.read(pluginId)).intent !== "disabled") {
        await this.enablePlugin(pluginId, reason)
      }
    } finally {
      this.releasePluginRuntimeGraph(reservation)
    }
  }

  private publishLifecycleSnapshot(pluginId: string, lifecycle: PluginLifecycleRecord): void {
    const plugin = usePluginStore.getState().plugins[pluginId]
    const manifest = plugin?.manifest
    const lease = this.activationLeases.get(pluginId)
    const generation = lifecycle.generation ?? lease?.generation ?? 0
    const scope = this.disposableScopes.get(pluginId)
    const providedRecords = this.serviceRegistry
      .snapshot()
      .filter(
        (record) =>
          record.providerPluginId === pluginId &&
          (generation === 0 || record.generation === generation)
      )
    const requiredServices = Object.keys(manifest?.requiresServices ?? {})
    const currentProviders = requiredServices.flatMap((serviceId) => {
      const provider = this.serviceRegistry.getProvider(serviceId)
      return provider ? [`${serviceId}:${provider.providerPluginId}@${provider.generation}`] : []
    })
    this.lifecycleCoordinator.updateSnapshot({
      managerId: this.managerId,
      pluginId,
      generation,
      intent: lifecycle.intent,
      actual: lifecycle.actual,
      stateSince: lifecycle.updatedAt,
      requiredServices,
      providedServices: providedRecords.map(
        (record) => `${record.serviceId}@${record.version}:${record.status}`
      ),
      currentProviders,
      effects: scope?.getDiagnostics() ?? { active: 0, pending: 0, failed: 0, labels: [] },
      ...(lifecycle.dirty ? { dirty: lifecycle.dirty } : {}),
      ...(lifecycle.lastError ? { lastError: lifecycle.lastError } : {}),
      ...(lifecycle.actual === "activating" ||
      lifecycle.actual === "stopping" ||
      lifecycle.actual === "waiting"
        ? { pendingTransition: lifecycle.actual }
        : {}),
      ...(manifest?.version ? { packageRevision: manifest.version } : {}),
      ...(plugin?.source ? { source: plugin.source } : {}),
      configRevision: lifecycle.revision,
    })
  }

  private async updatePluginLifecycleState(
    pluginId: string,
    patch: PluginLifecyclePatch
  ): Promise<PluginLifecycleRecord> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.lifecycleState.read(pluginId)
      try {
        const updated = await this.lifecycleState.write(pluginId, current.revision, patch)
        this.publishLifecycleSnapshot(pluginId, updated)
        return updated
      } catch (error) {
        if (!(error instanceof PluginLifecycleRevisionError) || attempt === 2) throw error
      }
    }
    throw new PluginLifecycleRevisionError(pluginId)
  }

  private async setActualState(
    pluginId: string,
    actual: PluginActualState,
    patch: Omit<PluginLifecyclePatch, "actual"> = {}
  ): Promise<PluginLifecycleRecord> {
    return this.updatePluginLifecycleState(pluginId, { ...patch, actual })
  }

  private buildDirtyDiagnostic(pluginId: string, fallbackMessage: string): PluginDirtyDiagnostic {
    const loaderDirty = this.loader.getDirtyTeardown(pluginId)
    const runtimeFailure = this.runtimeCleanupFailures.get(pluginId)
    const labels = this.disposableScopes.get(pluginId)?.getUnresolvedLabels()
    const ownsNativeHandle = labels?.some((label) =>
      /^(ctx\.)?(webview|window|worker)(\.|$)/.test(label)
    )
    const manifestType =
      loaderDirty?.manifestType ?? usePluginStore.getState().plugins[pluginId]?.manifest.type
    const runtime: PluginDirtyDiagnostic["runtime"] =
      runtimeFailure?.runtime ??
      (ownsNativeHandle
        ? "native"
        : manifestType === "vscode-extension"
          ? "vscode"
          : manifestType === "python" || manifestType === "hybrid"
            ? "python"
            : manifestType === "wasm"
              ? "wasm"
              : "frontend")
    const runtimeGeneration =
      loaderDirty?.runtimeGeneration ??
      runtimeFailure?.runtimeGeneration ??
      this.pythonRuntimeGenerations.get(pluginId)
    return {
      runtime,
      reason: loaderDirty?.reason ?? (runtimeFailure ? "error" : "unconfirmed"),
      at: Date.now(),
      message: String(loaderDirty?.message ?? runtimeFailure?.error ?? fallbackMessage).slice(
        0,
        512
      ),
      hostEpoch: PLUGIN_HOST_EPOCH,
      ...(runtimeGeneration ? { runtimeGeneration } : {}),
      labels,
    }
  }

  private assertProvidedServiceContributionsCommitted(plugin: Plugin): void {
    if (!("workspace.backend" in (plugin.manifest.providesServices ?? {}))) return
    const expected = (plugin.manifest.workspaceBackends ?? []).map(
      (backend) => `${plugin.manifest.id}:${backend.id}`
    )
    if (expected.length === 0) {
      throw new Error(
        `Service workspace.backend requires a workspaceBackends contribution for ${plugin.manifest.id}`
      )
    }
    const registered = new Set(createWorkspaceAPI(plugin.manifest.id).listRegistered())
    const missing = expected.filter((backendId) => !registered.has(backendId))
    if (missing.length > 0) {
      throw new Error(
        `Service workspace.backend contribution commit failed for ${plugin.manifest.id}: ${missing.join(", ")}`
      )
    }
  }

  private runtimeKindForPlugin(plugin: Plugin): PluginDirtyDiagnostic["runtime"] {
    if (plugin.manifest.type === "vscode-extension") return "vscode"
    if (plugin.manifest.type === "python" || plugin.manifest.type === "hybrid") return "python"
    if (plugin.manifest.type === "wasm") return "wasm"
    if (
      plugin.manifest.engines?.node ||
      plugin.manifest.runtimeCompatibility?.tauri?.entrypoint === "node"
    ) {
      return "node"
    }
    return "frontend"
  }

  private hasUnresolvedActivationResources(pluginId: string): boolean {
    return Boolean(
      this.disposableScopes.get(pluginId)?.hasUnresolvedResources() ||
      this.loader.getDirtyTeardown(pluginId) ||
      this.runtimeCleanupFailures.has(pluginId)
    )
  }

  private async confirmIsolatedRuntimeAbsent(
    pluginId: string,
    dirty: PluginDirtyDiagnostic
  ): Promise<boolean> {
    const generation = dirty.runtimeGeneration
    if (!generation) return false
    if (dirty.runtime === "node") {
      const running = await this.invokeNativeHost<boolean>("plugin_js_status", {
        pluginId,
        generation,
      })
      if (running) {
        await this.invokeNativeHost("plugin_stop_js", { pluginId, generation })
      }
      return !(await this.invokeNativeHost<boolean>("plugin_js_status", {
        pluginId,
        generation,
      }))
    }
    if (dirty.runtime === "python") {
      const info = await this.invokeNativeHost<unknown>("plugin_python_get_info", {
        pluginId,
        generation,
      })
      if (info !== null && info !== undefined) {
        await this.invokeNativeHost("plugin_python_unload", { pluginId, generation })
      }
      return true
    }
    if (dirty.runtime === "wasm") {
      await this.invokeNativeHost("plugin_wasm_unload", { pluginId, generation })
      return true
    }
    if (dirty.runtime === "vscode") {
      await this.invokeNativeHost("plugin_unload_vscode", { pluginId, generation })
      return true
    }
    return false
  }

  async setPluginIntent(pluginId: string, intent: PluginIntent, reason = "manual"): Promise<void> {
    await this.updatePluginLifecycleState(pluginId, { intent })
    await setPluginEnabled(pluginId, intent === "enabled").catch(() => undefined)
    if (intent === "disabled") {
      await this.disablePlugin(pluginId, reason)
    } else if (intent === "enabled") {
      await this.enablePlugin(pluginId, reason)
    }
  }

  async recoverPluginRuntime(pluginId: string): Promise<boolean> {
    return this.withLifecycleLock(pluginId, () => this.recoverPluginRuntimeInner(pluginId))
  }

  /**
   * Retire dirt this host process did not create.
   *
   * Called from the activation guards, which already hold the lifecycle lock
   * (it is a serial queue, not a reentrant one, so they cannot call
   * `recoverPluginRuntime`). Deliberately narrow: dirt recorded by the CURRENT
   * epoch describes resources that really may still be live, and only the user
   * clears that. Dirt carried over from a dead epoch is bookkeeping, and
   * refusing to activate on it strands the plugin permanently.
   */
  private async tryRetireStaleDirtyRuntime(
    pluginId: string,
    lifecycle: PluginLifecycleRecord
  ): Promise<boolean> {
    const epoch = lifecycle.dirty?.hostEpoch
    if (!epoch || epoch === PLUGIN_HOST_EPOCH) return false
    try {
      return await this.recoverPluginRuntimeInner(pluginId)
    } catch (error) {
      loggers.manager.warn(
        `[manager] stale runtime recovery failed for ${pluginId}:`,
        String(error)
      )
      return false
    }
  }

  private async recoverPluginRuntimeInner(pluginId: string): Promise<boolean> {
    {
      const lifecycle = await this.getPluginLifecycleState(pluginId)
      if (lifecycle.actual !== "dirty") return true

      // A different host epoch retires host-scoped resources after the
      // registries rebuild. Isolated runtimes (node/python/wasm/vscode) can
      // genuinely outlive the realm, so they bypass this shortcut and require
      // the generation-aware probe below.
      if (
        lifecycle.dirty &&
        isHostScopedRuntime(lifecycle.dirty.runtime) &&
        lifecycle.dirty.hostEpoch &&
        lifecycle.dirty.hostEpoch !== PLUGIN_HOST_EPOCH
      ) {
        this.disposableScopes.delete(pluginId)
        this.loader.clearDirtyTeardown(pluginId)
        this.runtimeCleanupFailures.delete(pluginId)
        await this.setActualState(pluginId, "inactive", {
          dirty: undefined,
          lastError: undefined,
        })
        this.releaseActivationLease(pluginId)
        return true
      }

      const scope = this.disposableScopes.get(pluginId)
      const report = await scope?.dispose()
      const runtimeFailure = this.runtimeCleanupFailures.get(pluginId)
      if (runtimeFailure?.runtime === "python") {
        try {
          await this.unloadPythonPlugin(pluginId)
          this.runtimeCleanupFailures.delete(pluginId)
        } catch (error) {
          const runtimeGeneration =
            runtimeFailure.runtimeGeneration ?? lifecycle.dirty?.runtimeGeneration
          this.runtimeCleanupFailures.set(pluginId, {
            runtime: "python",
            error,
            ...(runtimeGeneration ? { runtimeGeneration } : {}),
          })
        }
      }
      if (this.loader.getDirtyTeardown(pluginId)) {
        await this.loader.recoverDirtyTeardown(pluginId)
      }
      const loaderDirty = this.loader.getDirtyTeardown(pluginId)
      let isolatedRuntimeAbsent = false
      if (
        lifecycle.dirty &&
        ["node", "python", "wasm", "vscode"].includes(lifecycle.dirty.runtime)
      ) {
        try {
          isolatedRuntimeAbsent = await this.confirmIsolatedRuntimeAbsent(pluginId, lifecycle.dirty)
          if (isolatedRuntimeAbsent) this.runtimeCleanupFailures.delete(pluginId)
        } catch (error) {
          this.runtimeCleanupFailures.set(pluginId, {
            runtime: lifecycle.dirty.runtime,
            error,
            ...(lifecycle.dirty.runtimeGeneration
              ? { runtimeGeneration: lifecycle.dirty.runtimeGeneration }
              : {}),
          })
        }
      }
      // An isolated-runtime record with NO `runtimeGeneration` names nothing
      // that can be probed — `confirmIsolatedRuntimeAbsent` returns false on
      // the missing generation before it asks the host anything. Demanding a
      // probe for it therefore guarantees permanent dirt instead of preventing
      // a leak: there is no handle to reclaim, and the process that could have
      // held one is gone (the epoch moved). Records that DO carry a generation
      // still have to pass the probe.
      const unprobeableStaleRecord = Boolean(
        lifecycle.dirty &&
        !lifecycle.dirty.runtimeGeneration &&
        lifecycle.dirty.hostEpoch &&
        lifecycle.dirty.hostEpoch !== PLUGIN_HOST_EPOCH
      )
      const missingRuntimeProbe = Boolean(
        lifecycle.dirty &&
        (lifecycle.dirty.hostEpoch === PLUGIN_HOST_EPOCH ||
          !isHostScopedRuntime(lifecycle.dirty.runtime)) &&
        !unprobeableStaleRecord &&
        !scope &&
        !loaderDirty &&
        !isolatedRuntimeAbsent &&
        !this.runtimeCleanupFailures.has(pluginId)
      )
      const unresolved = Boolean(
        loaderDirty ||
        missingRuntimeProbe ||
        this.runtimeCleanupFailures.has(pluginId) ||
        report?.failures.length ||
        scope?.hasUnresolvedResources()
      )
      if (unresolved) {
        await this.setActualState(pluginId, "dirty", {
          dirty: {
            runtime: lifecycle.dirty?.runtime ?? "frontend",
            reason: loaderDirty?.reason ?? (report?.failures.length ? "error" : "unconfirmed"),
            at: Date.now(),
            message: String(
              loaderDirty?.message ??
                this.runtimeCleanupFailures.get(pluginId)?.error ??
                report?.failures[0]?.error ??
                (missingRuntimeProbe
                  ? "No generation-aware runtime probe is available"
                  : "Runtime cleanup unconfirmed")
            ).slice(0, 512),
            hostEpoch: PLUGIN_HOST_EPOCH,
            labels: scope?.getUnresolvedLabels(),
          },
        })
        return false
      }

      this.disposableScopes.delete(pluginId)
      await this.setActualState(pluginId, "inactive", {
        dirty: undefined,
        lastError: undefined,
      })
      this.releaseActivationLease(pluginId)
      return true
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
    // The Tauri (desktop) profile trusts every built-in. Other profiles gate
    // against their declared surface, with compatibility fallbacks for older
    // manifests that predate mobile/headless metadata.
    if (this.runtimeProfile === "tauri") {
      return []
    }
    const surface = this.runtimeProfile

    const compat = manifest.runtimeCompatibility
    let compatibility = compat?.[surface]
    let fallbackSurface: "browser" | "tauri" | undefined

    // Mobile is a browser-class runtime. Headless frontend modules without a
    // dedicated target inherit browser compatibility, while native/Node
    // plugins inherit Tauri compatibility because their existing Rust/Node
    // host contract is the one cognia-server exposes.
    if (!compatibility && surface === "mobile") {
      fallbackSurface = "browser"
      compatibility = compat?.browser
    } else if (!compatibility && surface === "headless") {
      const nativeOrNodeTarget =
        manifest.type !== "frontend" ||
        Boolean(
          manifest.engines?.node || manifest.runtimeCompatibility?.tauri?.entrypoint === "node"
        )
      fallbackSurface = nativeOrNodeTarget ? "tauri" : "browser"
      compatibility = compat?.[fallbackSurface]
    }
    const fallbackNote = fallbackSurface ? ` (inherited from ${fallbackSurface} compatibility)` : ""

    if (!compatibility) {
      return [
        {
          code: `runtime.${surface}.unsupported`,
          severity: "error",
          message: `Plugin ${manifest.id} does not declare ${surface} runtime compatibility.`,
          hint: `Add ${surface} runtime compatibility metadata before enabling this plugin in ${surface} mode.`,
        },
      ]
    }

    if (compatibility.availability === "supported") {
      return []
    }

    if (compatibility.availability === "degraded") {
      return [
        {
          code: `runtime.${surface}.degraded`,
          severity: "warning",
          message:
            compatibility.reason ||
            `Plugin ${manifest.id} is only partially supported in ${surface} runtime${fallbackNote}.`,
          hint: compatibility.entrypoint
            ? `${surface} bundle entrypoint: ${compatibility.entrypoint}`
            : undefined,
        },
      ]
    }

    return [
      {
        code: `runtime.${surface}.unsupported`,
        severity: "error",
        message:
          compatibility.reason ||
          `Plugin ${manifest.id} is blocked in ${surface} runtime${fallbackNote}.`,
        hint: compatibility.entrypoint
          ? `Declared ${surface} entrypoint: ${compatibility.entrypoint}`
          : undefined,
      },
    ]
  }

  /**
   * True when the active runtime profile *blocks* this plugin (an
   * error-severity runtime diagnostic), e.g. a desktop-native built-in
   * (`computer-use`, `playwright-mcp`, …) under the `browser` profile — which
   * is also what the Capacitor mobile shell boots as (it is non-Tauri).
   *
   * Such a plugin stays discovered and visible in `/plugins` (flagged
   * incompatible), but MUST be excluded from automatic startup enable /
   * activation: auto-enabling it would throw in `loadPlugin` and fire one
   * failure toast per plugin, which on mobile/web manifested as a flood of
   * toasts at boot. A manual, user-initiated `enablePlugin` is unaffected and
   * still surfaces the diagnostic on demand. Returns `false` on the `tauri`
   * profile (`collectRuntimeProfileDiagnostics` is browser-only), so desktop
   * auto-enable behaviour is untouched.
   */
  private isBlockedByRuntimeProfile(manifest: PluginManifest): boolean {
    return this.collectRuntimeProfileDiagnostics(manifest).some(
      (diagnostic) => diagnostic.severity === "error"
    )
  }

  /**
   * Startup activation must preflight the complete required-dependency chain,
   * not only the candidate itself. Otherwise a headless-compatible frontend
   * plugin can enter the restore set and recursively enable a native-only
   * dependency, turning a declared host limitation into a noisy load failure.
   * Manual enable remains unchanged and still returns the actionable error.
   */
  private isAutomaticActivationBlocked(
    plugin: Plugin,
    pluginsById: ReadonlyMap<string, Plugin>,
    visiting: Set<string> = new Set()
  ): boolean {
    if (
      this.isBlockedByRuntimeProfile(plugin.manifest) ||
      this.applyCompatibilityPolicy(plugin.manifest, "enable").blocked ||
      this.isRetiredBuiltin(plugin) ||
      this.requiresExplicitFrontendTrust(plugin) ||
      MANUAL_ENABLE_ONLY_BUILTINS.has(plugin.manifest.id)
    ) {
      return true
    }

    if (visiting.has(plugin.manifest.id)) return false
    visiting.add(plugin.manifest.id)
    try {
      return Object.keys(plugin.manifest.dependencies ?? {}).some((dependencyId) => {
        const dependency = pluginsById.get(dependencyId)
        return dependency
          ? this.isAutomaticActivationBlocked(dependency, pluginsById, visiting)
          : false
      })
    } finally {
      visiting.delete(plugin.manifest.id)
    }
  }

  private isRetiredBuiltin(plugin: Plugin): boolean {
    return (
      plugin.path?.startsWith("builtin://") === true &&
      getBrowserBuiltinRegistryEntry(plugin.manifest.id) === undefined
    )
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

    // Retire dirty records only after the host epoch/probe rules confirm the
    // previous generation no longer owns effects. This must happen before
    // restore/startup activation, otherwise a persisted dirty row becomes a
    // permanent activation block with no production recovery caller.
    for (const pluginId of Object.keys(usePluginStore.getState().plugins)) {
      const lifecycle = await this.lifecycleState.read(pluginId)
      if (lifecycle.actual !== "dirty") continue
      try {
        await this.recoverPluginRuntime(pluginId)
      } catch (error) {
        loggers.manager.warn(`[manager] runtime recovery failed for ${pluginId}:`, String(error))
      }
    }

    // Re-declare persisted plugin Dexie tables into the live schema BEFORE any
    // activation. `new CogniaDB(...)` resets to the static core schema each
    // launch, so the namespaced stores recorded in pluginDexieMeta are absent
    // from db.tables until re-declared — without this, applyPluginTables takes
    // its idempotent early-return and the plugin's activate() throws
    // "Table <id>:<name> does not exist" (e.g. demo-delivery:resources).
    await this.restorePluginDexieTables()

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
      await this.invokeNativeHost("plugin_python_initialize", {
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
      if (this.config.nodeHostSubscriber) {
        this.pythonEventsUnlisten = await this.config.nodeHostSubscriber<PythonPluginEvent>(
          "plugin:python",
          (event) => this.ingestPythonEvent(event)
        )
        return
      }
      const { listen } = await import("@tauri-apps/api/event")
      this.pythonEventsUnlisten = await listen<PythonPluginEvent>("plugin:python", (event) => {
        this.ingestPythonEvent(event.payload)
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

  private getRequiredDependentIds(providerId: string): string[] {
    const store = usePluginStore.getState()
    return Object.values(store.plugins)
      .filter(
        (candidate) =>
          candidate.manifest.id !== providerId &&
          Object.prototype.hasOwnProperty.call(candidate.manifest.dependencies ?? {}, providerId)
      )
      .map((candidate) => candidate.manifest.id)
      .sort()
  }

  private async getRuntimeBlockingDependentIds(providerId: string): Promise<string[]> {
    const store = usePluginStore.getState()
    const blockingActualStates = new Set<PluginActualState>([
      "activating",
      "active",
      "waiting",
      "stopping",
    ])
    const blocked: string[] = []
    for (const dependentId of this.getRequiredDependentIds(providerId)) {
      const dependent = store.plugins[dependentId]
      if (!dependent) continue
      const lifecycle = await this.getPluginLifecycleState(dependentId)
      if (
        lifecycle.intent === "enabled" ||
        blockingActualStates.has(lifecycle.actual) ||
        ["loading", "loaded", "enabling", "enabled", "disabling", "suspended"].includes(
          dependent.status
        )
      ) {
        blocked.push(dependentId)
      }
    }
    return blocked
  }

  private assertDependencyProvidersAccepting(plugin: Plugin): void {
    this.lifecycleCoordinator.assertProvidersAccepting(
      Object.keys(plugin.manifest.dependencies ?? {})
    )
  }

  /**
   * Re-declare every persisted plugin Dexie table into the live schema before
   * activation. Delegates to `restorePluginTables`, sourcing the authoritative
   * schema strings from each scanned plugin's `manifest.dexie` block (the
   * pluginDexieMeta rows store only table names). Best-effort: a failure here
   * must not abort manager init — the per-plugin enable path still re-applies
   * tables (now hardened to detect missing stores) as a fallback.
   */
  private async restorePluginDexieTables(): Promise<void> {
    const store = usePluginStore.getState()
    const manifestDexie = new Map<string, PluginManifestDexieBlock>()
    for (const [id, plugin] of Object.entries(store.plugins)) {
      const dexie = plugin.manifest?.dexie
      if (dexie) manifestDexie.set(id, dexie)
    }
    if (manifestDexie.size === 0) return

    try {
      const restored = await restorePluginTables(
        () => getDb() as unknown as import("dexie").default,
        manifestDexie
      )
      if (restored.length > 0) {
        loggers.manager.info(
          `[manager] restored ${restored.length} plugin Dexie table(s) at launch:`,
          restored
        )
      }
    } catch (error) {
      loggers.manager.warn("[manager] restorePluginDexieTables failed:", String(error))
    }
  }

  private async restorePluginStates(): Promise<void> {
    const store = usePluginStore.getState()
    const plugins = Object.values(store.plugins)
    const pluginsById = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]))
    const intents = new Map(
      await Promise.all(
        plugins.map(
          async (plugin) =>
            [
              plugin.manifest.id,
              (await this.getPluginLifecycleState(plugin.manifest.id)).intent,
            ] as const
        )
      )
    )

    const candidateIds = new Set(
      plugins
        .filter(
          (plugin) =>
            plugin.status === "installed" &&
            intents.get(plugin.manifest.id) !== "disabled" &&
            (this.config.autoEnable || this.shouldActivateOnStartup(plugin.manifest)) &&
            // Preflight both the plugin and every required dependency. A
            // compatible parent with a host-blocked dependency must remain
            // installed/visible instead of being reported as a load failure.
            !this.isAutomaticActivationBlocked(plugin, pluginsById)
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
    // Browser AND mobile discover built-ins from the static registry; only the
    // Tauri shell additionally scans the on-disk plugin directory below.
    if (this.runtimeProfile !== "tauri") {
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

        await this.persistDiscoveredPluginRow(manifest, projection.source, path)

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

  /**
   * Mirror a freshly-discovered plugin into the Dexie `plugins` table — the
   * single source of truth the /plugins Library (`usePlugins` → `listPlugins`)
   * and the marketplace "Built-in" section (`useBuiltinPluginEntries` →
   * `listPluginsBySource("builtin")`) both read.
   *
   * `store.discoverPlugin` / `store.installPlugin` only mutate the in-memory
   * Zustand store (localStorage-persisted); without this write, built-in and
   * marketplace plugins are discovered into the runtime but never reach the
   * Dexie-backed UI surfaces, so both render empty.
   *
   * `upsertPlugin` preserves the existing row's status / enabled / config when
   * those aren't supplied, so re-discovery on every launch is idempotent and
   * never clobbers the user's enable state. Non-fatal: a Dexie hiccup must not
   * abort discovery, so failures are logged and swallowed.
   */
  private async persistDiscoveredPluginRow(
    manifest: PluginManifest,
    source: PluginSource,
    path: string
  ): Promise<void> {
    // Some manifests carry LIVE runtime objects with function members — e.g.
    // agent-team-examples' `sharedMemoryAdapters[].write/read/…`. IndexedDB's
    // structured-clone algorithm rejects functions with DataCloneError, so the
    // whole row fails to persist and the plugin never reaches the Dexie-backed
    // UI. Strip to a clone-safe projection first. The live manifest (functions
    // intact) is rebuilt fresh from the module on every discovery and is what
    // enable-time registration reads; the persisted row is metadata-only.
    const serializableManifest = toClonableManifest(manifest)
    try {
      const normalizeGithubDelivery =
        source === "builtin" && serializableManifest.id === "github-delivery"
      const existing = normalizeGithubDelivery
        ? await getPlugin(serializableManifest.id)
        : undefined
      await upsertPlugin({
        id: serializableManifest.id,
        name: serializableManifest.name,
        version: serializableManifest.version,
        type: (serializableManifest.type as string) || "frontend",
        source,
        path,
        manifest: serializableManifest as unknown as Record<string, unknown>,
        capabilities: Array.isArray(serializableManifest.capabilities)
          ? [...serializableManifest.capabilities]
          : [],
        ...(normalizeGithubDelivery
          ? {
              status: existing?.status === "disabled" ? "disabled" : "installed",
              enabled: false,
            }
          : {}),
      })
    } catch (error) {
      loggers.manager.warn(`[plugin:${manifest.id}] failed to persist discovery row to Dexie`, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
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
      } else if (
        manifest.id === "github-delivery" &&
        existing.status !== "disabled" &&
        existing.status !== "installed"
      ) {
        store.setPluginStatus(manifest.id, "installed")
      }

      await this.persistDiscoveredPluginRow(manifest, "builtin", entry.path)

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

    await this.persistDiscoveredPluginRow(manifest, projection.source, dir)

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

    await this.persistDiscoveredPluginRow(result.manifest, projection.source, result.path)

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
  async installPluginFromGithub(
    repo: string,
    gitRef?: string,
    subdir?: string,
    generatedFiles: Record<string, string> = {}
  ): Promise<Plugin> {
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
      }>("plugin_install_from_github", { repo, gitRef, subdir, generatedFiles })

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
        await clearWasmCapabilityGrant(pluginId)
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
      await applyWasmCapabilityGrant(grantDecision)
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
      const grantReconciliation = await reconcileWasmGrantLedgerWithManifest(
        manifest.id,
        manifest.wasm?.fs?.preopens ?? []
      )
      const manifestForLoad: PluginManifest = {
        ...manifest,
        wasm: manifest.wasm
          ? {
              ...manifest.wasm,
              fs: {
                ...(manifest.wasm.fs ?? {}),
                preopens: grantReconciliation.allowedPreopens,
              },
            }
          : manifest.wasm,
      }
      await invoke("plugin_wasm_load", {
        pluginId: manifest.id,
        manifestJson: JSON.stringify(manifestForLoad),
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
    return this.withLifecycleLock(pluginId, () => this.loadPluginInner(pluginId))
  }

  private async loadPluginInner(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    const lifecycle = await this.getPluginLifecycleState(pluginId)
    if (lifecycle.intent === "disabled") throw new PluginIntentDisabledError(pluginId)
    if (
      lifecycle.actual === "dirty" &&
      !(await this.tryRetireStaleDirtyRuntime(pluginId, lifecycle))
    )
      throw new PluginDirtyRuntimeError(pluginId)

    if (this.runtimeServicesEnabled()) {
      const cycle = this.requiredServiceCycle(pluginId)
      if (cycle) {
        await this.setActualState(pluginId, "waiting", {
          lastError: JSON.stringify({ kind: "required-service-cycle", plugins: cycle }).slice(
            0,
            512
          ),
        })
        return
      }
      const evaluation = this.evaluatePluginServices(plugin)
      if (evaluation.required.length > 0) {
        await this.setActualState(pluginId, "waiting", {
          lastError: JSON.stringify(evaluation.required).slice(0, 512),
        })
        return
      }
    }

    if (
      this.loader.isLoaded(pluginId) &&
      (plugin.status === "loaded" || plugin.status === "enabled")
    ) {
      return
    }

    let activationGeneration: number | undefined
    try {
      const lease = this.ensureActivationLease(pluginId)
      activationGeneration = lease.generation
      await this.setActualState(pluginId, "activating", { generation: lease.generation })
      if (this.runtimeServicesEnabled()) {
        this.serviceRegistry.beginProvider(
          pluginId,
          lease.generation,
          plugin.manifest.providesServices
        )
      }

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

      // Frontend trust boundary (ADR 0013): renderer-JS plugins from an
      // untrusted source need an explicit per-plugin user grant before any of
      // their code is imported or evaluated. Kept outside the retry boundary
      // below — refusal is a policy decision, not a transient failure.
      if (this.requiresExplicitFrontendTrust(plugin)) {
        throw new PluginFrontendTrustError(pluginId, plugin.source)
      }

      this.registerPluginPermissions(pluginId, plugin.manifest.permissions || [])

      // Native guests and frontend plugins can call host APIs from activate().
      // Synchronize their silent-tier grants and declarative capability
      // allowlists BEFORE loader.load() runs activation; doing this later in
      // enablePlugin leaves WASM's retained Store permanently permissionless
      // and races Python/frontend activation against their host gates.
      await this.mirrorDeclaredPermissionsToLedger(pluginId, plugin.manifest.permissions || [])
      await this.syncShellAllowlistToHost(pluginId, plugin.manifest.shellCommands || [])
      if (plugin.manifest.networkAccess?.allowedDomains || plugin.manifest.networkAccess?.rules) {
        const rules = plugin.manifest.networkAccess.rules ?? []
        await this.syncNetworkAllowlistToHost(
          pluginId,
          plugin.manifest.networkAccess.allowedDomains ?? rules.map((rule) => rule.domain),
          rules
        )
      }

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
      if (plugin.source !== "builtin") {
        assertPluginManifestParity(plugin.manifest, definition.manifest)
      }
      definition.activation = this.parseActivationSpec(plugin.manifest)

      // Check if debug mode is enabled for this plugin
      const enableDebug =
        plugin.config?.debug === true ||
        (process.env.NODE_ENV === "development" && plugin.config?.devMode === true)

      // Create plugin context with optional debug instrumentation
      const context = createFullPluginContext(plugin, this, { enableDebug })
      this.contexts.set(pluginId, context)

      const i18nLocales = plugin.manifest.i18n?.locales
      if (i18nLocales) {
        const prefixed: Partial<Record<string, Record<string, string>>> = {}
        for (const [locale, dict] of Object.entries(i18nLocales)) {
          if (!dict) continue
          prefixed[locale] = Object.fromEntries(
            Object.entries(dict).map(([key, value]) => [`plugin.${pluginId}.${key}`, value])
          )
        }
        registerPluginI18n({ pluginId, messages: prefixed })
      }

      // Declarative UI becomes visible before activate(), so its stylesheet
      // must be present before any bridge publishes a renderable contribution.
      const stylesRoot = plugin.path?.startsWith("builtin://")
        ? plugin.path
        : plugin.descriptor?.installRoot.path
      if (plugin.manifest.styles && stylesRoot) {
        await loadPluginStyles({
          pluginId,
          pluginRoot: stylesRoot,
          stylesEntry: plugin.manifest.styles,
          bundledCss: getBrowserBuiltinRegistryEntry(pluginId)?.bundledStyles,
        })
      }

      if (plugin.manifest.extensions?.length) {
        const result = await registerExtensionsForPlugin(plugin.manifest, plugin.path ?? "", {
          importer: (entry) => this.loader.importEntry(entry, pluginId, plugin.path),
          hasPermission: (permission) =>
            context.permissions.hasPermission(permission as PluginPermission),
        })
        if (result.errors.length > 0) {
          for (const extensionError of result.errors) {
            recordPluginPointDiagnostic(pluginId, {
              code: "plugin.silent-failure",
              severity: "error",
              pointKind: "ui-slot",
              pointId: extensionError.point,
              message: extensionError.message,
              hint: "Check the declarative extension entry path and named export.",
            })
          }
          loggers.manager.warn(
            `[plugin:${pluginId}] ${result.errors.length} declarative extension(s) failed; ${result.registered} registered.`
          )
        }
      }

      // Activate the plugin. Bounded (W6.1): a hanging activate() would
      // otherwise wedge this plugin's lifecycle queue and any dependent
      // lazy activation forever.
      let hooks: PluginHooks | undefined
      if (typeof definition.activate === "function") {
        const activation = this.getPluginDisposableScope(pluginId).trackPendingWork(
          Promise.resolve(definition.activate(context)),
          "plugin.activate"
        )
        hooks =
          (await withTimeout(
            activation,
            this.config.activationTimeoutMs ?? ACTIVATE_TIMEOUT_MS,
            `plugin.activate:${pluginId}`
          )) || undefined
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
      await this.setActualState(pluginId, "active", {
        generation: lease.generation,
        dirty: undefined,
        lastError: undefined,
      })
    } catch (error) {
      if (this.runtimeServicesEnabled()) {
        this.serviceRegistry.removeProvider(pluginId, activationGeneration)
      }
      clearPluginExtensions(pluginId)
      unregisterPluginI18n(pluginId)
      removePluginStyles(pluginId)
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
      await this.cleanupFailedActivation(pluginId, error)
      throw error
    }
  }

  async enablePlugin(
    pluginId: string,
    reason: string = "manual",
    options: { activationParentId?: string } = {}
  ): Promise<void> {
    // Dedupe concurrent enables of the same plugin onto one in-flight promise.
    const inflight = this.enableInFlight.get(pluginId)
    if (inflight) return inflight
    // W6.4: the enable also serializes against disable/unload/uninstall.
    //
    // The progress failure is recorded HERE, in the outer catch, rather than in
    // a `finally` on the inner try. `enablePluginInner`'s own catch runs the
    // whole rollback — unregisterPluginContributions, setPluginError,
    // PLUGIN_ENABLE_FAILED_EVENT — before rethrowing, so by the time we see the
    // error every rollback side effect has already happened and the entry has
    // stayed `running` at the failing phase for the UI to read. A `finally` on
    // the inner try would fire BEFORE the rethrow and invert that ordering.
    const run = this.withLifecycleLock(pluginId, async () => {
      try {
        return await this.enablePluginInner(pluginId, reason, options)
      } catch (error) {
        failPluginActivationProgress(pluginId, error)
        throw error
      }
    })
    this.enableInFlight.set(pluginId, run)
    try {
      await run
    } finally {
      this.enableInFlight.delete(pluginId)
    }
    if (this.runtimeServicesEnabled()) {
      await this.refreshOptionalServiceConsumers(pluginId)
    }
  }

  private async enablePluginInner(
    pluginId: string,
    reason: string,
    options: { activationParentId?: string } = {}
  ): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    const lifecycle = await this.getPluginLifecycleState(pluginId)
    if (lifecycle.intent === "disabled") throw new PluginIntentDisabledError(pluginId)
    // Dirt inherited from a dead host epoch describes resources that cannot
    // exist any more; retiring it here is what keeps one failed teardown from
    // permanently bricking the plugin on every subsequent launch.
    if (
      lifecycle.actual === "dirty" &&
      !(await this.tryRetireStaleDirtyRuntime(pluginId, lifecycle))
    )
      throw new PluginDirtyRuntimeError(pluginId)

    if (plugin.status === "enabled") {
      return
    }

    // Phase 1/7 — preflight. Placed after the already-enabled guard so a no-op
    // enable never creates an entry (and never flashes a bar in the UI).
    beginPluginActivationProgress(pluginId, {
      reason,
      parentPluginId: options.activationParentId,
    })

    // Reject an incompatible runtime before dependency activation or Dexie
    // schema registration. `loadPlugin` repeats these guards at its direct-call
    // boundary, but enablePlugin performs schema work before calling it.
    const compatibility = this.applyCompatibilityPolicy(plugin.manifest, "enable")
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

    // Required-dependency gate (load-order, ADR-0017/0032 parity): reject a
    // missing / disabled / version-mismatched / cyclic required dependency
    // before doing any load work. Runs outside the try below so the typed
    // `PluginDependencyError` surfaces to callers instead of being wrapped.
    // Phase 2/7 — dependencies. Covers the required-dep gate AND the recursion
    // below; the parent stays parked here for the whole loop, which is exactly
    // the required behaviour and falls out of the call graph rather than any
    // bookkeeping.
    advancePluginActivationProgress(pluginId, "dependencies")
    this.assertDependencyProvidersAccepting(plugin)
    this.assertRequiredDependenciesSatisfied(pluginId)

    // Auto-enable required dependencies first so this plugin can rely on them
    // at activate() time. The gate above already rejected missing / cyclic
    // deps, so this recursion is bounded and only descends into satisfiable,
    // not-yet-enabled dependencies (each call early-returns once enabled).
    for (const depId of Object.keys(plugin.manifest.dependencies ?? {})) {
      const dep = store.plugins[depId]
      if (dep && dep.status !== "enabled") {
        // Each dependency gets its OWN progress entry keyed by depId, running
        // 0/7 → 7/7 independently while this plugin sits at `dependencies`.
        await this.enablePlugin(depId, "dependency", { activationParentId: pluginId })
      }
    }

    try {
      // Phase 3/7 — schema. Deliberately unconditional: it covers the error
      // healing below AND `applyPluginTables`, and it must advance even when
      // the manifest declares no `dexie` block. Moving this inside an
      // `if (plugin.manifest.dexie)` is the one edit that breaks the
      // "skipped optional work still advances" contract.
      advancePluginActivationProgress(pluginId, "schema")

      // Recover an errored plugin in-session. Left in `error` status it
      // dead-ends every retry on the store's status guards ("cannot be enabled
      // from status: error" / "cannot be loaded from status: error"), so the
      // activation breaker's retry can never actually re-run the plugin and the
      // failure re-dispatches on every activation event. Heal it back to a
      // loadable resting state — unloading any partially-loaded runtime first so
      // the reload starts clean — letting this attempt re-run load + activate
      // from scratch. Mirrors the v1->v2 persist migration that heals the same
      // dead-end across restarts (see normalizePersistedPluginStatus).
      if (plugin.status === "error") {
        if (this.loader.isLoaded(pluginId)) {
          await this.loader.unload(pluginId).catch((unloadError) => {
            loggers.manager.warn(
              `[plugin:${pluginId}] unload before error recovery failed:`,
              unloadError
            )
          })
        }
        store.setPluginError(pluginId, null)
        store.setPluginStatus?.(pluginId, "installed")
      }

      // Apply any declared Dexie tables BEFORE loadPlugin. loadPlugin runs the
      // plugin's activate() (see loadPlugin → definition.activate), and
      // activate() typically touches ctx.dexie right away (e.g. a delivery
      // counts its tables to surface mis-declared schemas). If the namespaced
      // stores aren't in the live schema yet, that first db.table() throws
      // "Table <id>:<name> does not exist" and enable fails. Worse, it fails
      // permanently: the pluginDexieMeta row that restorePluginDexieTables
      // relies on at boot is only written by applyPluginTables, which never runs
      // if loadPlugin already threw — so the tables are never restored on any
      // later boot either. Applying tables first breaks that deadlock.
      if (plugin.manifest.dexie) {
        await applyPluginTables(
          () => getDb() as unknown as import("dexie").default,
          pluginId,
          plugin.manifest.dexie
        )
      }

      // Load next when not currently active in runtime. Re-read the live
      // status so the just-applied error recovery (or any concurrent enable) is
      // reflected here rather than the stale captured snapshot.
      // Phase 4/7 — runtime. The long one: loadPlugin does signature
      // verification, the resilient module load, and the 30 s activate()
      // timeout. This is where the 10–45 s of a cold start actually goes.
      advancePluginActivationProgress(pluginId, "runtime")
      const currentStatus = store.plugins[pluginId]?.status ?? plugin.status
      if (
        currentStatus === "installed" ||
        currentStatus === "disabled" ||
        !this.loader.isLoaded(pluginId)
      ) {
        await this.loadPluginInner(pluginId)
      }

      if (
        this.runtimeServicesEnabled() &&
        (await this.getPluginLifecycleState(pluginId)).actual === "waiting"
      ) {
        cancelPluginActivationProgress(pluginId, "waiting-for-service")
        return
      }

      // Revalidate after activation: a provider may have started draining
      // while this plugin was loading. The provider-side reservation sees our
      // activating state, so one side deterministically wins without a
      // multi-plugin lock.
      this.assertDependencyProvidersAccepting(plugin)

      // Enable the plugin
      await store.enablePlugin(pluginId, { viaManager: false })

      // Phase 5/7 — contributions.
      advancePluginActivationProgress(pluginId, "contributions")
      // Register plugin contributions
      await this.registerPluginContributions(pluginId)

      // Phase 6/7 — hooks.
      advancePluginActivationProgress(pluginId, "hooks")
      // Notify the plugin it is now enabled. A throw here propagates into the
      // catch below, which rolls back the contributions just registered — the
      // plugin reports enable failure rather than silently half-enabling.
      await this.hooksManager.dispatchOnEnable(pluginId)

      if (this.runtimeServicesEnabled()) {
        await this.publishPluginServices(plugin)
      }

      // Phase 7/7 — commit.
      advancePluginActivationProgress(pluginId, "commit")
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
      // 7/7 — every phase entered and the transaction committed.
      completePluginActivationProgress(pluginId)
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
      if (this.runtimeServicesEnabled()) {
        this.serviceRegistry.removeProvider(
          pluginId,
          this.activationLeases.get(pluginId)?.generation
        )
      }
      await this.deactivatePluginRuntime(pluginId, { unloadModule: true }).catch((cleanupError) => {
        this.runtimeCleanupFailures.set(pluginId, {
          runtime: this.runtimeKindForPlugin(plugin),
          error: cleanupError,
        })
      })
      this.contexts.delete(pluginId)
      this.hooksManager.unregisterHooks(pluginId)
      store.setPluginError(pluginId, String(error))
      store.setPluginStatus?.(pluginId, "error")
      const dirty = this.hasUnresolvedActivationResources(pluginId)
      await this.setActualState(pluginId, dirty ? "dirty" : "error", {
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        ...(dirty
          ? { dirty: this.buildDirtyDiagnostic(pluginId, "Enable rollback was not confirmed") }
          : { dirty: undefined }),
      })
      if (!dirty) this.releaseActivationLease(pluginId)
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
    try {
      await this.withLifecycleLock(pluginId, () => this.disablePluginInner(pluginId, reason))
    } finally {
      await this.flushOptionalServiceConsumers(pluginId)
    }
  }

  private async disablePluginInner(pluginId: string, reason: string = "manual"): Promise<void> {
    // A terminal op queued behind a failed or superseded enable leaves an
    // entry `running` forever otherwise. `withLifecycleLock` serializes these
    // against enable, so this never races a live advance.
    cancelPluginActivationProgress(pluginId, "disable")
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    if (plugin.status === "suspended") {
      store.setPluginStatus?.(pluginId, "disabled")
      await this.syncBackendStatus(pluginId, "disabled")
      await this.setActualState(pluginId, "inactive", { dirty: undefined, lastError: undefined })
      this.releaseActivationLease(pluginId)
      return
    }

    if (plugin.status !== "enabled") {
      return
    }

    const reservation = this.lifecycleCoordinator.reserveProviderDrain(this.managerId, pluginId)
    try {
      const blockedBy = await this.getRuntimeBlockingDependentIds(pluginId)
      if (blockedBy.length > 0) throw new PluginDependencyInUseError(pluginId, blockedBy)

      // Service quiesce is a pre-teardown gate. If a consumer cannot prove a
      // clean stop, it restores this provider's availability and rejects before
      // the provider runtime or contributions are touched.
      if (this.runtimeServicesEnabled()) {
        await this.quiesceServiceConsumers(pluginId)
      }

      try {
        await this.setActualState(pluginId, "stopping")
        // Notify the plugin it is about to be disabled BEFORE we tear anything
        // down, so its handler can still flush state through its live APIs. A
        // throw must not abort the teardown — log it and continue (the plugin
        // doesn't get to veto disable).
        await this.safeDispatchLifecycleHook(pluginId, "onDisable")

        // Fully deactivate runtime resources for deterministic cleanup.
        await this.deactivatePluginRuntime(pluginId, { unloadModule: true })
        if (this.runtimeServicesEnabled()) {
          this.serviceRegistry.removeProvider(
            pluginId,
            this.activationLeases.get(pluginId)?.generation
          )
        }

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
        if (this.hasUnresolvedActivationResources(pluginId)) {
          await this.setActualState(pluginId, "dirty", {
            dirty: this.buildDirtyDiagnostic(pluginId, "Disable cleanup was not confirmed"),
          })
        } else {
          await this.setActualState(pluginId, "inactive", {
            dirty: undefined,
            lastError: undefined,
          })
          this.releaseActivationLease(pluginId)
        }
        loggers.manager.debug(`[plugin:${pluginId}] disabled (${reason})`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.contexts.delete(pluginId)
        this.hooksManager.unregisterHooks(pluginId)
        store.setPluginStatus?.(pluginId, "error")
        store.setPluginError(pluginId, message)
        const dirty = Boolean(
          this.disposableScopes.get(pluginId)?.hasUnresolvedResources() ||
          this.loader.getDirtyTeardown(pluginId) ||
          this.runtimeCleanupFailures.has(pluginId)
        )
        await this.setActualState(pluginId, dirty ? "dirty" : "error", {
          lastError: message.slice(0, 512),
          ...(dirty
            ? {
                dirty: this.buildDirtyDiagnostic(pluginId, message),
              }
            : { dirty: undefined }),
        })
        if (!dirty) this.releaseActivationLease(pluginId)
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
    } finally {
      this.lifecycleCoordinator.releaseProviderDrain(reservation)
    }
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    // A terminal op queued behind a failed or superseded enable leaves an
    // entry `running` forever otherwise. `withLifecycleLock` serializes these
    // against enable, so this never races a live advance.
    cancelPluginActivationProgress(pluginId, "unload")
    try {
      await this.withLifecycleLock(pluginId, () => this.unloadPluginInner(pluginId))
    } finally {
      await this.flushOptionalServiceConsumers(pluginId)
    }
  }

  private async unloadPluginInner(pluginId: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      return
    }

    const reservation = this.lifecycleCoordinator.reserveProviderDrain(this.managerId, pluginId)
    try {
      const blockedBy = await this.getRuntimeBlockingDependentIds(pluginId)
      if (blockedBy.length > 0) throw new PluginDependencyInUseError(pluginId, blockedBy)

      try {
        // Notify the plugin its module is being unloaded. Fired here — before any
        // teardown — because this is the only point where the plugin's hooks are
        // still registered on every unload path (the enabled→unload path below
        // unregisters them inside disablePlugin). Log-only: unload cannot be vetoed.
        await this.safeDispatchLifecycleHook(pluginId, "onUnload")

        // Disable first if enabled
        if (plugin.status === "enabled") {
          // Inner variant — we already hold this plugin's lifecycle lock (W6.4).
          await this.disablePluginInner(pluginId, "unload")
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
        await clearWasmCapabilityGrant(pluginId)
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
        if (this.hasUnresolvedActivationResources(pluginId)) {
          await this.setActualState(pluginId, "dirty", {
            dirty: this.buildDirtyDiagnostic(pluginId, "Unload cleanup was not confirmed"),
          })
        } else {
          await this.setActualState(pluginId, "inactive", {
            dirty: undefined,
            lastError: undefined,
          })
          this.releaseActivationLease(pluginId)
        }
      } catch (error) {
        const lifecycle = await this.getPluginLifecycleState(pluginId)
        if (store.plugins[pluginId]?.status === "enabled" && lifecycle.actual === "active") {
          // A dependency/service drain gate failed before provider teardown.
          // Preserve the still-live generation; the caller can retry after the
          // blocking consumer is cleanly stopped.
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        await this.deactivatePluginRuntime(pluginId, { unloadModule: true }).catch(() => undefined)
        await this.unregisterPluginContributions(pluginId).catch(() => undefined)
        this.contexts.delete(pluginId)
        this.hooksManager.unregisterHooks(pluginId)
        store.setPluginError(pluginId, message)
        store.setPluginStatus?.(pluginId, "error")
        const dirty = Boolean(
          this.disposableScopes.get(pluginId)?.hasUnresolvedResources() ||
          this.loader.getDirtyTeardown(pluginId) ||
          this.runtimeCleanupFailures.has(pluginId)
        )
        await this.setActualState(pluginId, dirty ? "dirty" : "error", {
          lastError: message.slice(0, 512),
          ...(dirty
            ? {
                dirty: this.buildDirtyDiagnostic(pluginId, message),
              }
            : { dirty: undefined }),
        })
        if (!dirty) this.releaseActivationLease(pluginId)
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
    } finally {
      this.lifecycleCoordinator.releaseProviderDrain(reservation)
    }
  }

  async uninstallPlugin(pluginId: string, options?: { purgeData?: boolean }): Promise<void> {
    // A terminal op queued behind a failed or superseded enable leaves an
    // entry `running` forever otherwise. `withLifecycleLock` serializes these
    // against enable, so this never races a live advance.
    cancelPluginActivationProgress(pluginId, "uninstall")
    try {
      await this.withLifecycleLock(pluginId, () => this.uninstallPluginInner(pluginId, options))
    } finally {
      await this.flushOptionalServiceConsumers(pluginId)
    }
  }

  private async uninstallPluginInner(
    pluginId: string,
    options?: { purgeData?: boolean }
  ): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    const reservation = this.lifecycleCoordinator.reserveProviderDrain(this.managerId, pluginId)
    try {
      const blockedBy = this.getRequiredDependentIds(pluginId)
      if (blockedBy.length > 0) throw new PluginDependencyInUseError(pluginId, blockedBy)

      try {
        // Last-chance notification BEFORE teardown + file removal, while the
        // plugin's hooks are still registered (unloadPlugin below unregisters
        // them). A never-activated ("installed"-only) plugin has no live handler,
        // so this is a no-op for it. Log-only: uninstall cannot be vetoed.
        await this.safeDispatchLifecycleHook(pluginId, "onUninstall")

        // Unload first
        if (["loaded", "enabled", "disabled"].includes(plugin.status)) {
          // Inner variant — we already hold this plugin's lifecycle lock (W6.4).
          await this.unloadPluginInner(pluginId)
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
          () => getDb() as unknown as import("dexie").default,
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
          await clearWasmCapabilityGrant(pluginId)
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
        if (this.hasUnresolvedActivationResources(pluginId)) {
          await this.setActualState(pluginId, "dirty", {
            dirty: this.buildDirtyDiagnostic(pluginId, "Uninstall cleanup was not confirmed"),
          })
        } else {
          await this.setActualState(pluginId, "inactive", {
            dirty: undefined,
            lastError: undefined,
          })
          this.releaseActivationLease(pluginId)
        }
      } catch (error) {
        const lifecycle = await this.getPluginLifecycleState(pluginId)
        if (store.plugins[pluginId]?.status === "enabled" && lifecycle.actual === "active") {
          // unloadPluginInner rejected at a pre-teardown drain gate. Uninstall
          // must not convert that live provider into an error or remove files.
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        await this.deactivatePluginRuntime(pluginId, { unloadModule: true }).catch(() => undefined)
        await this.unregisterPluginContributions(pluginId).catch(() => undefined)
        this.contexts.delete(pluginId)
        this.hooksManager.unregisterHooks(pluginId)
        store.setPluginError(pluginId, message)
        store.setPluginStatus?.(pluginId, "error")
        const dirty = Boolean(
          this.disposableScopes.get(pluginId)?.hasUnresolvedResources() ||
          this.loader.getDirtyTeardown(pluginId) ||
          this.runtimeCleanupFailures.has(pluginId)
        )
        await this.setActualState(pluginId, dirty ? "dirty" : "error", {
          lastError: message.slice(0, 512),
          ...(dirty
            ? {
                dirty: this.buildDirtyDiagnostic(pluginId, message),
              }
            : { dirty: undefined }),
        })
        if (!dirty) this.releaseActivationLease(pluginId)
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
    } finally {
      this.lifecycleCoordinator.releaseProviderDrain(reservation)
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
      // Bound every hook: a hook that never resolves must not wedge the caller
      // (a hung `onSuspend` would otherwise stall the sequential idle sweep and
      // strand the plugin `enabled`). withTimeout rejects → the catch below
      // records a silent failure and the lifecycle transition continues.
      const dispatch = (): Promise<void> => {
        switch (hook) {
          case "onDisable":
            return this.hooksManager.dispatchOnDisable(pluginId)
          case "onUnload":
            return this.hooksManager.dispatchOnUnload(pluginId)
          case "onUninstall":
            return this.hooksManager.dispatchOnUninstall(pluginId)
          case "onSuspend":
            return this.hooksManager.dispatchOnSuspend(pluginId)
          case "onResume":
            return this.hooksManager.dispatchOnResume(pluginId)
        }
      }
      await withTimeout(dispatch(), LIFECYCLE_HOOK_TIMEOUT_MS, `plugin.${hook}:${pluginId}`)
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
    // Serialize with every other lifecycle transition (enable/disable/unload
    // and resume) so the status check-and-act is atomic — otherwise a suspend
    // can interleave with an in-flight tool call or a concurrent resume.
    try {
      await this.withLifecycleLock(pluginId, () => this.suspendPluginInner(pluginId, reason))
    } finally {
      await this.flushOptionalServiceConsumers(pluginId)
    }
  }

  private async suspendPluginInner(pluginId: string, reason: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin || plugin.status !== "enabled") {
      return
    }
    try {
      if (this.runtimeServicesEnabled()) {
        await this.quiesceServiceConsumers(pluginId)
      }
      // Fire while hooks are still registered, before any teardown.
      await this.safeDispatchLifecycleHook(pluginId, "onSuspend")
      await this.unregisterPluginContributions(pluginId)
      await this.deactivatePluginRuntime(pluginId, { unloadModule: true })
      if (this.runtimeServicesEnabled()) {
        this.serviceRegistry.removeProvider(
          pluginId,
          this.activationLeases.get(pluginId)?.generation
        )
      }
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
      await this.setActualState(pluginId, "inactive", { dirty: undefined, lastError: undefined })
      this.releaseActivationLease(pluginId)
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
    // Serialize with every other lifecycle transition. This is the fix for the
    // double-wake race: two concurrent activation triggers both used to observe
    // `status === "suspended"` before either flipped to `enabled`, double-
    // loading the module. Under the lock the second call sees `enabled` and
    // no-ops.
    await this.withLifecycleLock(pluginId, () => this.resumePluginInner(pluginId, reason))
    if (this.runtimeServicesEnabled()) {
      await this.refreshOptionalServiceConsumers(pluginId)
    }
  }

  private async resumePluginInner(pluginId: string, reason: string): Promise<void> {
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]
    if (!plugin || plugin.status !== "suspended") {
      return
    }
    const lifecycle = await this.lifecycleState.read(pluginId)
    if (lifecycle.intent === "disabled") return
    try {
      await this.loadPluginInner(pluginId)
      await this.registerPluginContributions(pluginId)
      if (this.runtimeServicesEnabled()) {
        await this.publishPluginServices(plugin)
      }
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
      if (this.idleSweepRunning) return
      this.idleSweepRunning = true
      void this.suspendIdlePlugins().finally(() => {
        this.idleSweepRunning = false
      })
    }, IDLE_SWEEP_INTERVAL_MS)
    ;(this.idleSweepTimer as { unref?: () => void }).unref?.()
  }

  /**
   * Refresh the idle-suspend clock for a plugin (records "used now"). Called by
   * the tool-invocation seam on every dispatch so a plugin driven purely by
   * agent tools isn't idle-suspended mid-use — the slash-command handler does
   * the same on command invocation. No-op for an unknown plugin.
   */
  recordPluginToolUse(pluginId: string): void {
    usePluginStore.getState().updateLastUsedAt(pluginId)
  }

  /** Stop the periodic idle sweep (lifecycle teardown / tests). Idempotent. */
  stopIdleSweep(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = null
    }
  }

  /**
   * Whether the user has explicitly trusted this plugin's renderer-JS
   * execution (frontend trust boundary). Only consulted for
   * `frontend`/`hybrid` plugins from a non-inherently-trusted source.
   */
  isFrontendTrusted(pluginId: string): boolean {
    return readPolicy().trustedFrontendPlugins.includes(pluginId)
  }

  /**
   * Grant or revoke the user's renderer-JS trust for one plugin.
   *
   * Revocation takes effect immediately: a plugin whose un-sandboxed JS is
   * already running in the renderer is disabled (or unloaded when it was
   * loaded but never enabled) — otherwise flipping the switch off would only
   * matter on the next load while the untrusted code keeps running.
   */
  async setFrontendTrust(pluginId: string, next: boolean): Promise<void> {
    const policy = readPolicy()
    const trusted = policy.trustedFrontendPlugins.filter((id) => id !== pluginId)
    if (next) trusted.push(pluginId)
    writePolicy({ ...policy, trustedFrontendPlugins: trusted })
    if (next) return

    const plugin = usePluginStore.getState().plugins[pluginId]
    if (!plugin || !this.requiresExplicitFrontendTrust(plugin)) return
    if (plugin.status === "enabled") {
      await this.disablePlugin(pluginId, "frontend-trust-revoked")
    } else if (this.loader.isLoaded(pluginId)) {
      await this.unloadPlugin(pluginId)
    }
  }

  /**
   * Whether the frontend trust boundary (ADR 0013) blocks this plugin from
   * loading right now: renderer-JS type, non-inherently-trusted source, and
   * no explicit user grant.
   */
  private requiresExplicitFrontendTrust(plugin: Plugin): boolean {
    return (
      (plugin.manifest.type === "frontend" || plugin.manifest.type === "hybrid") &&
      !isInherentlyTrustedFrontendSource(plugin.source) &&
      !this.isFrontendTrusted(plugin.manifest.id)
    )
  }

  private async verifyPluginSignature(pluginPath: string, pluginId: string): Promise<boolean> {
    try {
      const verifier = getPluginSignatureVerifier()
      const config = verifier.getConfig()

      // Skip verification entirely when the policy neither requires signatures
      // nor forbids untrusted plugins. NOTE: the default policy is
      // requireSignatures:true (ADR 0016 P0-3), so this short-circuit only
      // applies once the user has explicitly relaxed the policy in Settings.
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
    if (!this.canInvokeNativeHost()) return
    const guard = getPermissionGuard()
    for (const permission of permissions) {
      if (guard.getTier(pluginId, permission) !== "silent") continue
      try {
        if (this.config.nodeHostInvoker) {
          await this.invokeNativeHost("plugin_permission_grant", {
            pluginId,
            permission,
            grantedBy: "manifest",
            expiresAt: null,
          })
        } else {
          await grantPluginPermission(pluginId, permission, "manifest")
        }
      } catch (error) {
        // NOT a runtime-cleanup failure. `runtimeCleanupFailures` means "the
        // previous generation's runtime effects could not be confirmed gone",
        // and it feeds `hasUnresolvedActivationResources` — so recording a
        // failed ledger RPC here classified the next activation failure as
        // `dirty` rather than `error`, stamped `runtime: "node"` on it (the
        // headless brain sets `nodeHostInvoker`), and left no
        // `runtimeGeneration`. `confirmIsolatedRuntimeAbsent` needs a
        // generation to probe, so that record was unrecoverable by
        // construction: every first-party plugin declaring a permission
        // refused to activate on every subsequent launch, and the Recover
        // button could not clear it either.
        //
        // Mirroring owns no runtime resources. It is an idempotent host RPC
        // that re-runs on the next enable, so a failure is reported and left
        // behind rather than escalated into runtime dirt.
        recordPluginPointDiagnostic(pluginId, {
          code: "plugin.permission.mirror-failed",
          severity: "warning",
          pointKind: "runtime",
          pointId: permission,
          message: `Declared permission "${permission}" was not mirrored to the host ledger; host-side gates fall back to the renderer guard until the next enable.`,
        })
        recordSilentFailure(
          pluginId,
          {
            site: "manager.registerPluginPermissions.mirror",
            message: `Could not mirror declared permission "${permission}" to the host ledger.`,
            expected: !this.canInvokeNativeHost(),
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
    if (!this.canInvokeNativeHost()) return
    try {
      await this.invokeNativeHost("plugin_set_shell_allowlist", { pluginId, commands })
    } catch (error) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.syncShellAllowlistToHost",
          message: "Could not push the shell-command allowlist to the host.",
          expected: !this.canInvokeNativeHost(),
        },
        error
      )
    }
  }

  /** Push the manifest's domain/method/path policy into the Rust host. */
  private async syncNetworkAllowlistToHost(
    pluginId: string,
    domains: string[],
    rules: NonNullable<PluginManifest["networkAccess"]>["rules"] = []
  ): Promise<void> {
    if (!this.canInvokeNativeHost()) return
    try {
      await this.invokeNativeHost("plugin_set_network_allowlist", { pluginId, domains, rules })
    } catch (error) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.syncNetworkAllowlistToHost",
          message: "Could not push the network egress allowlist to the host.",
          expected: !this.canInvokeNativeHost(),
        },
        error
      )
    }
  }

  private parseActivationSpec(manifest: PluginManifest): ParsedActivationSpec {
    const cached = this.activationSpecCache.get(manifest)
    if (cached) return cached
    const rawEvents = [
      ...(manifest.activationEvents || []),
      ...(manifest.extensions ?? []).map((extension) => `onView:${extension.point}` as const),
    ].filter((event): event is PluginActivationEvent => typeof event === "string")

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

    const parsed = {
      startup,
      commandEvents,
      toolEvents,
      viewEvents,
      uriActivation,
      rawEvents,
    }
    this.activationSpecCache.set(manifest, parsed)
    return parsed
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

    let compiled = this.activationPatternCache.get(normalizedPattern)
    if (!compiled) {
      const escaped = normalizedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const wildcardPattern = escaped.replace(/\\\*/g, ".*")
      compiled = new RegExp(`^${wildcardPattern}$`)
      this.activationPatternCache.set(normalizedPattern, compiled)
    }
    return compiled.test(normalizedValue)
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
    const pluginsById = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]))

    for (const plugin of plugins) {
      if (plugin.status === "enabled") {
        continue
      }

      // A suspended plugin is an already-enabled plugin whose runtime was
      // reclaimed to save memory — ANY activation event should transparently
      // wake it. The `shouldActivateForEvent` gate governs disabled→enabled
      // LAZY activation only; applying it to a suspended plugin would leave one
      // that declared just `startup` permanently unreachable via tools/views
      // after it idle-suspends.
      const isSuspended = plugin.status === "suspended"
      const lifecycle = await this.lifecycleState.read(plugin.manifest.id)
      if (lifecycle.intent === "disabled") {
        continue
      }
      if (!isSuspended && !this.shouldActivateForEvent(plugin.manifest, event)) {
        continue
      }

      // Preflight the complete required-dependency chain just like startup
      // restore. A compatible parent must not recursively activate a
      // host-blocked dependency on every matching event.
      if (this.isAutomaticActivationBlocked(plugin, pluginsById)) {
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

  /**
   * Reconcile the plugin store against the native runtime's status ledger.
   *
   * The ledger is deliberately narrow, so this pass is too. Rust returns
   * `PluginRuntimeSnapshot { plugin_id, version, status, last_error,
   * loaded_at, install_path }` (crates/cognia-plugin-runtime/src/lib.rs) —
   * there is no manifest and no source on it, so nothing can be *discovered*
   * from here. `scanPlugins()` owns discovery and every caller
   * (`initialize`, the rollback refresh, the updater refresh) runs it
   * immediately before this, so a ledger id the store has never seen is
   * skipped rather than materialized into a manifest-less ghost record.
   *
   * Two traps constrain what may be adopted:
   *
   * 1. The ledger is IN-MEMORY. `PluginRuntimeState::new` starts with an empty
   *    map and nothing seeds it from disk (pinned by the Rust
   *    `state_starts_empty` test), so on a genuine cold start this is a no-op.
   *    It only carries entries inside a live host process — after a renderer
   *    reload, and on the rollback/updater refresh paths.
   * 2. Because of that reload case, a live-claiming status must never be
   *    adopted. `restorePluginStates()` only enables plugins still marked
   *    `installed`, and `handleActivationEvent()` skips anything already
   *    marked `enabled` — so writing a stale `enabled` back into the store
   *    after a reload would strand the plugin in BOTH restore paths: rendered
   *    as enabled, never actually loaded into the fresh JS context. The JS
   *    runtime, not the native ledger, is the authority on whether a plugin
   *    instance exists here.
   *
   * What survives both constraints is `error`: a terminal, native-side
   * failure the store would otherwise render as a healthy `installed` plugin.
   * Adopting it cannot strand anything, because `enablePlugin()` gates on
   * intent/dirty/already-enabled and never on `error`, so the user can still
   * enable the plugin by hand. Every other ledger status either asserts
   * liveness (unsafe per trap 2) or restates the persisted lifecycle intent
   * that `restorePluginStates()` already reads directly — where a stale
   * ledger value could only wrongly suppress a legitimate restore.
   */
  async syncRuntimeState(): Promise<void> {
    const store = usePluginStore.getState()

    // Only the Tauri shell has a backend status ledger to sync from; browser
    // and mobile have no native invoke bridge.
    if (this.runtimeProfile !== "tauri" || !canUseTauriInvoke()) {
      return
    }

    try {
      // `plugin_get_all` is the list-shaped command (src-tauri/src/lib.rs
      // generate_handler!); it takes no arguments. Its per-plugin sibling
      // `plugin_runtime_snapshot` REQUIRES a `pluginId` and returns a single
      // record, so it can never serve this pass.
      const snapshots = await invoke<PluginRuntimeSnapshot[]>("plugin_get_all")
      if (!Array.isArray(snapshots)) {
        loggers.manager.warn("plugin_get_all returned a non-array payload; skipping runtime sync")
        return
      }

      for (const snapshot of snapshots) {
        // Wire shape is snake_case: the Rust struct carries no
        // `serde(rename_all)`, so these field names are load-bearing.
        const pluginId = snapshot?.plugin_id
        if (!pluginId) continue

        const existing = store.plugins[pluginId]
        if (!existing) {
          // No manifest on the ledger, so this cannot be discovered here.
          loggers.manager.debug(
            `[plugin:${pluginId}] present in the runtime ledger but not in the store; skipping`
          )
          continue
        }

        // `status` is a free-form String on the Rust side (`upsert_status`
        // preserves any value verbatim), so it must be validated before it
        // reaches a typed store setter.
        if (!isPluginStatus(snapshot.status)) {
          loggers.manager.warn(
            `[plugin:${pluginId}] unrecognized runtime status "${snapshot.status}"; ignoring`
          )
          continue
        }

        if (snapshot.status !== "error" || existing.status === "error") continue

        store.setPluginError(pluginId, snapshot.last_error || "Plugin runtime reported an error")
      }
    } catch (error) {
      // Non-fatal: the command is absent on hosts without the plugin runtime.
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
      await this.invokeNativeHost("plugin_set_status", { pluginId, status })
    } catch (error) {
      recordSilentFailure(
        pluginId,
        {
          site: "manager.syncBackendStatus",
          message: `Failed to sync plugin status to backend (${status}).`,
          expected: !this.canInvokeNativeHost(),
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
      // Swallow-and-record (W6.2): a throwing deactivate() must not abort the
      // teardown below, or the plugin leaks permissions/IPC/WASM grants.
      //
      // The context MUST be passed: `PluginDefinition.deactivate` takes an
      // optional `PluginContext`, and every first-party plugin that owns a
      // resource the host cannot reclaim — a `setInterval` clipboard poller,
      // an imperatively-registered slash command — guards its teardown with
      // `if (ctx?.pluginId)`. Calling this with no argument made all of those
      // guards fail closed, so the resources survived disable/suspend
      // (a clipboard read loop outliving a revoked `clipboard:read` grant).
      // `this.contexts.delete(pluginId)` runs AFTER this in every caller, so
      // the entry is still live here.
      try {
        await Promise.resolve(definition.deactivate(this.contexts.get(pluginId)))
      } catch (error) {
        const runtimeGeneration = this.loader.getRuntimeGeneration(pluginId)
        this.runtimeCleanupFailures.set(pluginId, {
          runtime: plugin ? this.runtimeKindForPlugin(plugin) : "frontend",
          error,
          ...(runtimeGeneration ? { runtimeGeneration } : {}),
        })
        recordSilentFailure(
          pluginId,
          {
            site: "manager.deactivatePluginRuntime.deactivate",
            message: "Plugin deactivate() threw; continuing teardown.",
            expected: false,
          },
          error
        )
      }
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
        // tool-dispatch refresh) so command-driven plugins aren't suspended
        // between uses.
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
          // The `name` is the token the user types (see
          // `lib/slash-commands/plugin-commands.ts:slashCommandToken`), so it
          // must be the bare alias. It previously read
          // `"<Name> (alias: <alias>)"`, which contains spaces and therefore
          // fell back to the `…#alias:<alias>` id — an untypeable string. The
          // alias feature was dead as shipped. The id keeps the `#alias:`
          // suffix purely for registry bookkeeping (dedup + unregister).
          name: alias,
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
    if (plugin.manifest.ide?.targets.includes("pro-ide")) {
      const { prepareManagedIdeProxy } = await import("@/lib/plugin/ide/proxy-manager")
      await prepareManagedIdeProxy(plugin)
    }

    // Note: Tool implementations are provided by the plugin's activate function
    // through the context.agent.registerTool API

    // Note: A2UI component implementations are provided by the plugin
    // and registered via context.a2ui.registerComponent API

    if (plugin.manifest.templatePackages?.length) {
      await registerPluginTemplatePackages(
        pluginId,
        plugin.manifest.templatePackages,
        getTemplateRuntime().catalog
      )
    }
    if (plugin.manifest.agentTeamTemplates?.length || plugin.manifest.workflowTemplates?.length) {
      await registerLegacyPluginTemplateCompatibility({
        pluginId,
        agentTeams: plugin.manifest.agentTeamTemplates,
        workflows: plugin.manifest.workflowTemplates,
        catalog: getTemplateRuntime().catalog,
      })
      recordPluginPointDiagnostic(pluginId, {
        code: "plugin.point.deprecated",
        severity: "warning",
        pointKind: "runtime",
        pointId: "template-compatibility",
        message:
          "agentTeamTemplates/workflowTemplates are deprecated; use templatePackages or ctx.templates.register().",
        hint: "Migrate the contribution through @cognia/plugin-sdk/templates.",
      })
    }

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
        ReadonlyArray<{ id: string }> | undefined
      if (!entries?.length) continue
      for (const entry of entries) {
        try {
          descriptor.registerEntry(entry, { pluginId, installRoot: plugin.path ?? "" })
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
      importer: (entry: string) => this.loader.importEntry(entry, pluginId, plugin.path),
      resolveAsset: await createPluginAssetResolver(pluginId),
      moduleExports: this.loader.getModuleExports(pluginId) ?? {},
      hasPermission: (permission: string) => context.permissions.hasPermission(permission as never),
    }
    for (const cap of MODULE_BRIDGE_CAPABILITY_KEYS) {
      const descriptor = MODULE_BRIDGE_CAPABILITIES[cap]
      const entries = plugin.manifest[descriptor.manifestField] as
        ReadonlyArray<unknown> | undefined
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
            servers: NonNullable<typeof plugin.manifest.lspServers>
          }) => Promise<unknown>
        }
        // NOTE: `manifest.vscodeExtension.publisherKeyFingerprint` is
        // deliberately NOT forwarded. It is a value the extension asserts
        // about itself; forwarding it once let a hostile `.vsix` name a
        // seeded `"placeholder:*"` fingerprint and earn a prompt-free spawn.
        // The policy resolves consent from its own `approvedBinaries` ledger
        // (v109) using only pluginId + path + the bytes on disk.
        await registerPluginLspServers({
          pluginId,
          pluginPath: plugin.path ?? "",
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

    // VS Code `contributes.grammars[]` (`manifest.vscodeGrammars`, W5.1) —
    // TextMate grammars read from the plugin dir and registered through
    // grammars-bridge; the shiki highlight seam consumes them.
    if (plugin.manifest.vscodeGrammars?.length) {
      try {
        const { registerGrammarsForPlugin } = await import("@/lib/plugin/bridge/grammars-bridge")
        const result = await registerGrammarsForPlugin(
          pluginId,
          plugin.manifest.vscodeGrammars,
          plugin.path ?? ""
        )
        if (result.errors.length > 0) {
          loggers.manager.warn(
            `[plugin:${pluginId}] ${result.errors.length} grammar contribution(s) failed: ${result.errors.join("; ")}`
          )
        }
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] failed to register VS Code grammars:`, err)
      }
    }

    // VS Code `contributes.iconThemes[]` (`manifest.vscodeIconThemes`, W5.1) —
    // registered through icons-bridge; the project file tree resolves icons.
    if (plugin.manifest.vscodeIconThemes?.length) {
      try {
        const { registerIconThemesForPlugin } = await import("@/lib/plugin/bridge/icons-bridge")
        const result = await registerIconThemesForPlugin(
          pluginId,
          plugin.manifest.vscodeIconThemes,
          plugin.path ?? ""
        )
        if (result.errors.length > 0) {
          loggers.manager.warn(
            `[plugin:${pluginId}] ${result.errors.length} icon theme contribution(s) failed: ${result.errors.join("; ")}`
          )
        }
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] failed to register VS Code icon themes:`, err)
      }
    }

    // VS Code `contributes.snippets[]` (`manifest.vscodeSnippets`, W5.1) —
    // registered through snippets-bridge; the Monaco completion source
    // (`lib/monaco/snippets.ts:listSnippetsForLanguage`) already reads it.
    if (plugin.manifest.vscodeSnippets?.length) {
      try {
        const { registerSnippetsForPlugin } = await import("@/lib/plugin/bridge/snippets-bridge")
        const result = await registerSnippetsForPlugin(
          pluginId,
          plugin.manifest.vscodeSnippets,
          plugin.path ?? ""
        )
        if (result.errors.length > 0) {
          loggers.manager.warn(
            `[plugin:${pluginId}] ${result.errors.length} snippet contribution(s) failed: ${result.errors.join("; ")}`
          )
        }
      } catch (err) {
        loggers.manager.warn(`[plugin:${pluginId}] failed to register VS Code snippets:`, err)
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
      // NOTE: `manifest.author.publicKey` is deliberately NOT forwarded — see
      // the LSP registration above. Same self-assertion flaw, same fix: the
      // CLI binary policy resolves consent from the `approvedBinaries` ledger.
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
  importPluginEntry(entry: string, pluginId?: string): Promise<Record<string, unknown>> {
    if (!pluginId) return this.loader.importEntry(entry)
    const plugin = usePluginStore.getState().plugins[pluginId]
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`)
    if (plugin.path?.startsWith("builtin://")) {
      const moduleExports = this.loader.getModuleExports(pluginId)
      if (moduleExports) return Promise.resolve(moduleExports)
    }
    return this.loader.importEntry(entry, pluginId, plugin.path)
  }

  private async unregisterPluginContributions(pluginId: string): Promise<void> {
    if (!this.ownsCurrentGeneration(pluginId)) {
      loggers.manager.warn(
        `[plugin:${pluginId}] ignored stale-generation cleanup from ${this.managerId}`
      )
      return
    }
    const store = usePluginStore.getState()
    const plugin = store.plugins[pluginId]

    const scope = this.disposableScopes.get(pluginId)
    if (scope) {
      const report = await scope.dispose()
      if (!scope.hasUnresolvedResources()) {
        this.disposableScopes.delete(pluginId)
      }
      if (report.failures.length > 0) {
        recordSilentFailure(
          pluginId,
          {
            site: "manager.unregisterPluginContributions.disposableScope",
            message: `Failed to dispose ${report.failures.length} plugin registration(s).`,
            expected: false,
          },
          report.failures[0].error
        )
      }
    }

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
    const templateRuntime = getTemplateRuntime()
    try {
      await templateRuntime.service.tombstoneCatalogSource(`plugin:${pluginId}`)
    } catch (error) {
      loggers.manager.warn(
        `[plugin:${pluginId}] failed to persist template source tombstones during teardown:`,
        error
      )
    }
    clearTemplatesForPluginContext(pluginId, templateRuntime.catalog)
    // Drop the `manifest.styles` sheet injected by registerPluginContributions.
    // Unconditional: cheaper than reading the manifest back, and a disabled
    // plugin leaving live CSS behind would keep restyling its old subtree.
    removePluginStyles(pluginId)
    clearPluginExtensions(pluginId)
    const { contextPanelRegistry } = await import("@/lib/context-workbench/panel-registry")
    contextPanelRegistry.unregisterPlugin(pluginId)
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
    // Drop runtime-registered AI providers (ctx.ai.registerProvider). The
    // module-bridge teardown above only covers the DECLARATIVE
    // ai-providers path; the imperative registrations were previously
    // reachable after disable (W4.3).
    try {
      const { clearCustomAIProvidersByPlugin } = await import("@/lib/plugin/api/ai-provider-api")
      clearCustomAIProvidersByPlugin(pluginId)
    } catch {
      // best effort — early-teardown import failures must not abort cleanup
    }

    // Drop runtime-registered importers — the same asymmetry as the AI
    // providers above, and the last two imperative registries with no bulk
    // cleanup. `ctx.import.registerChatImporter` left the plugin's importer
    // live inside `detectFormat` / `importChatExport`, and
    // `ctx.import.registerImporter` left it matching filenames in
    // `getCustomImporterOwnersForFile` — which is what authorizes chat
    // ATTACHMENT BYTES to an importer's owner. Both survived disable and
    // uninstall unless the plugin happened to call its own disposer.
    try {
      const { unregisterImportersByPlugin } = await import("@/lib/data/import-registry")
      unregisterImportersByPlugin(pluginId)
      const { clearCustomImportersByPlugin } = await import("@/lib/plugin/api/import-api")
      clearCustomImportersByPlugin(pluginId)
    } catch {
      // best effort — early-teardown import failures must not abort cleanup
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

    // Drop VS Code grammar / icon theme / snippet contributions (W5.1).
    if (plugin.manifest.vscodeGrammars?.length) {
      try {
        const { unregisterGrammarsByPlugin } = await import("@/lib/plugin/bridge/grammars-bridge")
        unregisterGrammarsByPlugin(pluginId)
      } catch {
        // best effort
      }
    }
    if (plugin.manifest.vscodeIconThemes?.length) {
      try {
        const { unregisterIconThemesByPlugin } = await import("@/lib/plugin/bridge/icons-bridge")
        unregisterIconThemesByPlugin(pluginId)
      } catch {
        // best effort
      }
    }
    if (plugin.manifest.vscodeSnippets?.length) {
      try {
        const { unregisterSnippetsByPlugin } = await import("@/lib/plugin/bridge/snippets-bridge")
        unregisterSnippetsByPlugin(pluginId)
      } catch {
        // best effort
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
    // Abort any in-flight background agents the plugin fired-and-forgot
    // (ctx.agent.run/runStreamed). Matches the "bulk cleanup is automatic"
    // contract in context.ts; previously cancelByPlugin had no caller and a
    // disabled plugin's agents kept running.
    try {
      const { getBackgroundAgentManager } = await import("@/lib/ai/agent/background-agent-manager")
      getBackgroundAgentManager().cancelByPlugin(pluginId)
    } catch {
      // Best-effort — disable must never fail on background-agent cleanup.
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
    refreshAllPackWarnings()
    // Every overlay capability this plugin contributed is now gone — re-run
    // the agent-team capability audit so any team/teammate that referenced a
    // dropped id surfaces a stale-capability warning. Fire-and-forget: the
    // disable flow must not block on the (async, Dexie-backed) sweep.
    try {
      const { refreshAllInstanceCapabilityWarnings } =
        await import("@/lib/ai/agent/team/capability-audit")
      void refreshAllInstanceCapabilityWarnings().catch((err) => {
        loggers.manager.warn(`[plugin:${pluginId}] capability-audit refresh failed:`, err)
      })
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

  private async cleanupFailedActivation(pluginId: string, cause: unknown): Promise<void> {
    let cleanupError: unknown
    try {
      await this.unregisterPluginContributions(pluginId)
    } catch (error) {
      cleanupError = error
    }
    try {
      await this.deactivatePluginRuntime(pluginId, { unloadModule: true })
    } catch (error) {
      cleanupError ??= error
    }

    this.hooksManager.unregisterHooks(pluginId)
    this.contexts.delete(pluginId)
    getPluginIPC().unsubscribe(pluginId)
    getPluginIPC().unexpose(pluginId)
    getPluginIPC().unregisterPlugin(pluginId)
    getMessageBus().offAll(pluginId)
    getPermissionGuard().unregisterPlugin(pluginId)
    getPluginConsentBroker().clearSessionGrantsForPlugin(pluginId)

    const scope = this.disposableScopes.get(pluginId)
    const runtimeDirty = this.loader.getDirtyTeardown(pluginId)
    const unresolved = Boolean(
      cleanupError ||
      scope?.hasUnresolvedResources() ||
      runtimeDirty ||
      this.runtimeCleanupFailures.has(pluginId)
    )
    if (unresolved) {
      const plugin = usePluginStore.getState().plugins[pluginId]
      const manifestType = runtimeDirty?.manifestType ?? plugin?.manifest.type ?? "frontend"
      const runtime: PluginDirtyDiagnostic["runtime"] =
        this.runtimeCleanupFailures.get(pluginId)?.runtime ??
        (manifestType === "vscode-extension"
          ? "vscode"
          : manifestType === "hybrid" || manifestType === "python"
            ? "python"
            : manifestType === "wasm"
              ? "wasm"
              : "frontend")
      await this.setActualState(pluginId, "dirty", {
        dirty: {
          ...this.buildDirtyDiagnostic(pluginId, String(cleanupError ?? cause)),
          runtime,
        },
        lastError: String(cause).slice(0, 512),
      })
      return
    }

    await this.setActualState(pluginId, "error", {
      lastError: String(cause).slice(0, 512),
      dirty: undefined,
    })
    this.releaseActivationLease(pluginId)
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
      const loadResult = await this.invokeNativeHost<PythonLoadResult | null>(
        "plugin_python_load",
        {
          pluginId,
          pluginPath: plugin.path,
          mainModule: plugin.manifest.pythonMain,
          dependencies: plugin.manifest.pythonDependencies,
          config: plugin.config ?? null,
          hostSettings: effectiveHostSettings,
        }
      )
      const pythonGeneration = loadResult?.generation
      if (!pythonGeneration) {
        throw new Error(`Python host did not return a runtime generation for ${pluginId}`)
      }
      this.bindPythonGeneration(pluginId, pythonGeneration)

      // Get registered tools from Python
      const pythonTools = await this.invokeNativeHost<
        Array<{
          name: string
          description: string
          parameters: Record<string, unknown>
        }>
      >("plugin_python_get_tools", { pluginId, generation: pythonGeneration })

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
            return this.invokeNativeHost("plugin_python_call_tool", {
              pluginId,
              generation: pythonGeneration,
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
      this.registerPythonHooks(pluginId, loadResult.hooks ?? [], pythonGeneration)
    } catch (error) {
      if (!this.pythonRuntimeGenerations.has(pluginId)) {
        this.pendingPythonEvents.delete(pluginId)
      }
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
    // Project the manifest's declared workflow nodes into executors that route
    // through the WASM `workflow-node-execute` export. Registered through the
    // SAME machinery as frontend plugins (kind-prefix + catalog + per-plugin
    // teardown via `teardownPluginWorkflowRegistrations`), so a disabled WASM
    // plugin's nodes disappear cleanly. Without this the Rust dispatch + guest
    // impl were unreachable (`No executor registered for <kind>`).
    const nodeDefs = buildWasmNodeDefs(plugin.manifest)
    if (nodeDefs.length > 0) {
      const workflowApi = createWorkflowAPI(pluginId)
      for (const def of nodeDefs) {
        try {
          workflowApi.registerNode(def)
        } catch (error) {
          loggers.manager.warn("WASM workflow node registration failed", {
            pluginId,
            kind: def.kind,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /**
   * Bridge python `@hook` declarations into the JS hooks system: each
   * declared (event, name) pair becomes a `PluginHooks` entry whose
   * implementation RPCs `plugin_python_call_hook`. For hybrid plugins the
   * JS-side hooks win on name collision (python fills the gaps) — the JS
   * module is the richer runtime and already registered at activation.
   */
  private registerPythonHooks(
    pluginId: string,
    declarations: PythonHookDeclaration[],
    generation: string
  ): void {
    if (declarations.length === 0) {
      return
    }
    const pythonHooks: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    for (const { event, name } of declarations) {
      if (typeof event !== "string" || event.length === 0 || typeof name !== "string") {
        continue
      }
      pythonHooks[event] = async (...args: unknown[]) =>
        this.invokeNativeHost("plugin_python_call_hook", {
          pluginId,
          generation,
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
    return this.invokeNativeHost<T>("plugin_python_call_hook", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
      event,
      name,
      payload: payload ?? null,
    })
  }

  /**
   * Deliver a plugin's persisted config to its live python host
   * (`on_config_updated`). A demoted host picks it up at respawn.
   */
  async pushPythonConfig(pluginId: string, config: Record<string, unknown>): Promise<void> {
    await this.invokeNativeHost("plugin_python_push_config", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
      config,
    })
  }

  /**
   * Create the plugin's venv (if missing) and pip-install its declared
   * dependencies, streaming progress into the log buffer. Callers MUST
   * obtain explicit user consent first (network + disk side effects).
   */
  async installPythonDeps(pluginId: string, dependencies: string[]): Promise<void> {
    await this.invokeNativeHost("plugin_python_install_deps", { pluginId, dependencies })
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
    return this.invokeNativeHost<T>("plugin_python_call", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
      functionName,
      args,
    })
  }

  async evalPython<T>(
    pluginId: string,
    code: string,
    locals?: Record<string, unknown>
  ): Promise<T> {
    return this.invokeNativeHost<T>("plugin_python_eval", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
      code,
      locals: locals ?? {},
    })
  }

  async importPythonModule(pluginId: string, moduleName: string): Promise<void> {
    await this.invokeNativeHost("plugin_python_import", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
      moduleName,
    })
  }

  async callPythonModule<T>(
    pluginId: string,
    moduleName: string,
    functionName: string,
    args: unknown[]
  ): Promise<T> {
    return this.invokeNativeHost<T>("plugin_python_module_call", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
      moduleName,
      functionName,
      args,
    })
  }

  async getPythonModuleAttribute<T>(
    pluginId: string,
    moduleName: string,
    attrName: string
  ): Promise<T> {
    return this.invokeNativeHost<T>("plugin_python_module_getattr", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
      moduleName,
      attrName,
    })
  }

  /**
   * Invoke a provider declared by `manifest.ide`.
   *
   * The generated VSIX contains no plugin business logic. This is the single
   * runtime seam used by Monaco and Pro IDE projections, so frontend, Python,
   * and WASM plugins execute their provider handler exactly once in Cognia.
   */
  async invokeIdeProvider<T>(pluginId: string, handler: string, args: unknown[]): Promise<T> {
    const plugin = usePluginStore.getState().plugins[pluginId]
    if (!plugin || plugin.status !== "enabled") {
      throw new Error(`IDE_PLUGIN_NOT_ACTIVE: ${pluginId}`)
    }
    if (plugin.manifest.type === "python") {
      return this.callPythonFunction<T>(pluginId, handler, args)
    }
    if (plugin.manifest.type === "wasm") {
      return callWasmExport<T>(pluginId, handler, { arguments: args })
    }
    const exported = this.loader.getModuleExports(pluginId)?.[handler]
    if (typeof exported !== "function") {
      throw new Error(`IDE_PROVIDER_HANDLER_MISSING: ${pluginId}.${handler}`)
    }
    return (await exported(...args)) as T
  }

  /**
   * Get Python runtime information
   */
  async getPythonRuntimeInfo(): Promise<PythonRuntimeInfo> {
    return this.invokeNativeHost<PythonRuntimeInfo>("plugin_python_runtime_info")
  }

  /**
   * Check if a Python plugin is initialized
   */
  async isPythonPluginInitialized(pluginId: string): Promise<boolean> {
    return this.invokeNativeHost<boolean>("plugin_python_is_initialized", {
      pluginId,
      generation: this.requirePythonGeneration(pluginId),
    })
  }

  /**
   * Get Python plugin info (tool/hook counts)
   */
  async getPythonPluginInfo(pluginId: string): Promise<PythonPluginInfo | null> {
    const info = await this.invokeNativeHost<Record<string, unknown> | null>(
      "plugin_python_get_info",
      { pluginId, generation: this.requirePythonGeneration(pluginId) }
    )
    if (!info) return null
    const { normalizePluginRuntimeHandshake } = await import("./transport")
    return normalizePluginRuntimeHandshake(info, "python") as unknown as PythonPluginInfo
  }

  /**
   * Unload a Python plugin
   */
  async unloadPythonPlugin(pluginId: string): Promise<void> {
    const generation = this.requirePythonGeneration(pluginId)
    await this.invokeNativeHost("plugin_python_unload", {
      pluginId,
      generation,
    })
    if (this.pythonRuntimeGenerations.get(pluginId) === generation) {
      this.pythonRuntimeGenerations.delete(pluginId)
    }
    unbindPythonRuntimeGeneration(pluginId, generation)
    this.pendingPythonEvents.delete(pluginId)
  }

  /**
   * List all loaded Python plugins
   */
  async listPythonPlugins(): Promise<string[]> {
    return this.invokeNativeHost<string[]>("plugin_python_list")
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
    this.activationSpecCache = new WeakMap()
  }

  private validateHookDeclarations(pluginId: string, hooks: PluginHooks): void {
    // Chat-interception hooks see (and can rewrite) every prompt, tool call,
    // and tool result. Registering any of them requires the high-risk
    // `hooks:chat-intercept` permission in the manifest (W3.2) — without it
    // the whole hook registration is refused, so a plugin cannot silently
    // wiretap the conversation.
    const declaredIntercepts = CHAT_INTERCEPT_HOOKS.filter(
      (name) => (hooks as Record<string, unknown>)[name] !== undefined
    )
    if (declaredIntercepts.length > 0) {
      const manifestPermissions =
        usePluginStore.getState().plugins[pluginId]?.manifest?.permissions ?? []
      if (!manifestPermissions.includes("hooks:chat-intercept")) {
        throw new Error(
          `Plugin "${pluginId}" declares chat-interception hook(s) ` +
            `${declaredIntercepts.join(", ")} without the "hooks:chat-intercept" permission.`
        )
      }
    }

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
