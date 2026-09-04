/**
 * Plugin Context - Runtime context provided to plugins
 */

import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { createPluginSystemLogger, loggers } from "./logger"
import { usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"
import { PluginDataDialog } from "@/components/plugins/dialogs/plugin-data-dialog"
import { getPluginRateLimiter } from "@/lib/plugin/security/rate-limiter"
import {
  assertNetworkRequestAllowed,
  hostFromUrl,
  matchHost,
  type NetworkHttpMethod,
} from "@/lib/plugin/security/network-allowlist"
import { sanitizePluginNetworkEgress } from "@/lib/plugin/api/plugin-pii-gate"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { getPluginSecurityPosture } from "@/lib/plugin/security/security-posture"
import type {
  Plugin,
  PluginManifest,
  PluginBaseContext,
  PluginContext,
  PluginPermission,
  PluginCapability,
  PluginLogger,
  PluginStorage,
  PluginEventEmitter,
  PluginUIAPI,
  PluginA2UIAPI,
  PluginAgentAPI,
  PluginSettingsAPI,
  PluginPythonAPI,
  PluginNetworkAPI,
  PluginFileSystemAPI,
  PluginClipboardAPI,
  PluginShellAPI,
  PluginDatabaseAPI,
  PluginShortcutsAPI,
  PluginContextMenuAPI,
  PluginWindowAPI,
  PluginSecretsAPI,
  PluginNotification,
  PluginDialog,
  PluginInputDialog,
  PluginConfirmDialog,
  PluginToolRegistration,
  PluginA2UIComponent,
  A2UITemplateDef,
  NetworkRequestOptions,
  NetworkResponse,
  DownloadOptions,
  DownloadResult,
  UploadOptions,
  FileEntry,
  FileStat,
  FileWatchEvent,
  ShellOptions,
  ShellResult,
  SpawnOptions,
  ChildProcess,
  DatabaseResult,
  DatabaseTransaction,
  TableSchema,
  ShortcutOptions,
  ShortcutRegistration,
  ContextMenuItem,
  ContextMenuClickContext,
  WindowOptions,
  PluginWindow,
  PluginWorkflowAPI,
  PluginMcpServerPresetDef,
  PluginNativeAnthropicToolDef,
  PluginSkillDef,
  PluginExternalAgentPresetDef,
  PluginGuardrail,
  PluginSubagentDef,
  PluginDispatchSubagentOptions,
  PluginRunTeamOptions,
  PluginCreateSessionOptions,
  PluginContextProvider,
  PluginSharedMemoryReadOptions,
  PluginTwinMemoryQueryOptions,
} from "@/types/plugin"
import {
  isAuthorCallableHostTool,
  type PluginHostToolFailure,
  type PluginInvocationOptions,
} from "@/types/plugin/plugin-host-tools"
import { resolvePluginHostRuntime } from "@/lib/plugin/runtime/host-runtime"
import type { AgentTeamConfig } from "@/lib/ai/agent/agent-team"
import type { PluginNodeDef, PluginTriggerDef } from "@/types/plugin/plugin-workflow"
import { registerNodeExecutor, unregisterNodeExecutor } from "@/lib/workflow/nodes/registry"
import { registerMcpServerPreset } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { registerNativeAnthropicTool } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { registerSkill } from "@/lib/plugin/registries/skill-registry"
import { refreshAllPackWarnings } from "@/lib/plugin/registries/character-pack-registry"
import {
  registerGuardrail,
  unregisterGuardrailById,
  listGuardrailIds,
} from "@/lib/plugin/registries/guardrail-registry"
import { registerPreset as registerExternalAgentPresetOverlay } from "@/lib/ai/agent/external/presets"
import {
  registerPluginProtocolAdapter,
  type ProtocolAdapterFactory,
} from "@/lib/ai/agent/external/protocol-adapter"
import {
  addPluginCatalogEntry,
  removePluginCatalogEntry,
  type NodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import {
  registerPluginTrigger,
  unregisterPluginTrigger,
  type TriggerRegistration,
} from "@/lib/workflow/triggers/registry"
import type { A2UIComponent, A2UISurfaceType } from "@/types/artifact/a2ui"
import type { AgentModeConfig } from "@/types/agent/agent-mode"
import { usePluginStore } from "@/stores/plugin-runtime"
import { useA2UIStore } from "@/stores/a2ui"
import type { PluginManager } from "./manager"
import type { IntrospectablePluginPermission, PluginContextAPI } from "@/types/plugin/plugin"
import {
  createSessionAPI,
  createProjectAPI,
  createVectorAPI,
  createThemeAPI,
  createExportAPI,
  createImportAPI,
  createConfigAPI,
  createSecretsAPI,
  createI18nAPI,
  createCanvasAPI,
  createArtifactAPI,
  createNotificationCenterAPI,
  createAIProviderAPI,
  createExtensionAPI,
  createPermissionAPI,
  createMediaAPI,
  createStorageAPI,
  createFilesAPI,
  revokePluginFileHandles,
  createSkillsAPI,
  createContextPanelAPI,
  createTemplatesAPI,
} from "../api"
import { createCommandsAPI } from "../api/commands-api"
import { createEditorAPI } from "../api/editor-api"
import { createMessagePartAPI } from "../api/message-part-api"
import { createToolResultAPI } from "../api/tool-result-api"
import { createDexieAPI } from "../api/dexie-api"
import { createOcrAPI } from "../api/ocr-api"
import { createWorkspaceAPI } from "../api/workspace-api"
import { createModalAPI } from "../api/modal-api"
import { createWebviewAPI } from "../api/webview-api"
import { createAuthAPI } from "../api/auth-api"
import { createUriAPI } from "../api/uri-api"
import { createChatAPI } from "../api/chat-api"
import { createCapabilitiesAPI } from "../api/capabilities-api"
import { createGitAPI } from "../api/git-api"
import { createGoalAPI } from "../api/goal-api"
import { createHooksAPI } from "../api/hooks-api"
import { createPlanAPI } from "../api/plan-api"
import { createMemoryAPI } from "../api/memory-api"
import { createTeamAPI } from "../api/team-api"
import { createSubscriptionAPI } from "../api/subscription-api"
import { createTerminalAPI } from "../api/terminal-api"
import { createPerfAPI } from "../api/perf-api"
import { createLogsAPI } from "../api/logs-api"
import { createConnectorsAPI } from "../api/connectors-api"
import { createIntegrationsAPI } from "../api/integrations-api"
import { createShareAPI } from "../api/share-api"
import { createBackupAPI } from "../api/backup-api"
import { createAutomationAPI } from "../api/automation-api"
import { createBrowserAPI } from "../api/browser-api"
import { createCharacterPacksAPI } from "../api/character-packs-api"
import { createSandboxAPI } from "../api/sandbox-api"
import { createRecorderAPI } from "../api/recorder-api"
import { createSecurityScansAPI } from "../api/security-scans-api"
import { createEvalAPI } from "../api/eval-api"
import { createUserSchedulerAPI } from "../api/scheduler-tasks"
import { createCompanionAPI } from "../api/companion-api"
import { createPetAPI } from "../api/pet-api"
import { createResourcesAPI } from "../api/resources-api"
import { createSitesAPI } from "../api/sites"
import { createWorkflowAuthorAPI } from "../api/workflow-author-api"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import { getTemplateRuntime } from "@/lib/templates/runtime"
import { getDb } from "@/lib/db/schema"
import { createIPCAPI } from "../messaging/ipc"
import { createEventAPI } from "../messaging/message-bus"
import { getPluginDebugger } from "../devtools/debugger"
import {
  invokePluginApi,
  PluginGatewayError,
  grantPluginPermission,
  isPluginGatewayAvailable,
} from "./transport"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { isTauri } from "@/lib/native/utils"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { createTrayAPI } from "@/lib/plugin/api/tray-api"
import { createQuickActionsAPI } from "@/lib/plugin/api/quick-actions-api"
import { prefixPluginKind } from "../bridge/kind-prefix"
import { dispatchPluginTrigger } from "../bridge/plugin-trigger-dispatch"
import { pluginHasApiPermission } from "@/lib/plugin/api/permission-api"
import {
  runPluginAgent,
  runPluginAgentStreamed,
  dispatchSubagent,
  runTeam,
  createPluginAgentSession,
  resumePluginAgentSession,
  readSharedMemory,
  queryTwinMemory,
} from "@/lib/plugin/agent-sdk"
import {
  registerContextProvider,
  unregisterContextProviderById,
  listContextProviderIds,
} from "@/lib/plugin/registries/context-provider-registry"
import { invokePluginTool } from "@/lib/plugin/core/invoke-plugin-tool"
import type {
  PluginAgentRun,
  PluginAgentRunOptions,
  PluginAgentRunResult,
} from "@/types/plugin/plugin-agent-sdk"
import type { FullPluginContext as PublicFullPluginContext } from "@cognia/plugin-sdk/context"
import { PluginDisposableScope, withPluginDisposableScope } from "./disposable-scope"
import { PLUGIN_RESOURCE_EFFECTS } from "./resource-effects"
import { withGovernedPluginContext } from "../contracts/governed-context"
import { pluginApiRuntimeForType } from "../contracts/interface-catalog"

/** @deprecated `PluginContext` is now the complete activated context. */
export type FullPluginContext = PluginContext

// =============================================================================
// Create Plugin Context
// =============================================================================

export function createPluginContext(
  plugin: Plugin,
  manager: PluginManager,
  options?: { enableDebug?: boolean; generation?: number }
): PluginBaseContext {
  const pluginId = plugin.manifest.id

  const baseContext: PluginBaseContext = {
    pluginId,
    pluginPath: plugin.path,
    config: plugin.config,
    services: manager.createPluginServicesAPI(pluginId),
    logger: createLogger(pluginId),
    // The initial context uses the local storage implementation. Manager
    // construction then supplies the public author-context storage API through
    // the final object spread, so every activated plugin sees one `storage`
    // field with the complete runtime contract.
    storage: createStorage(pluginId),
    events: createEventEmitter(pluginId),
    ui: createUIAPI(pluginId),
    a2ui: createA2UIAPI(pluginId, manager),
    agent: createAgentAPI(pluginId, manager),
    settings: createSettingsAPI(pluginId),
    python: plugin.manifest.type !== "frontend" ? createPythonAPI(pluginId, manager) : undefined,
    network: guardNativeApi(
      pluginId,
      createNetworkAPI(pluginId, plugin.manifest.networkAccess),
      NETWORK_GUARD_MAP
    ),
    fs: guardNativeApi(pluginId, createFileSystemAPI(pluginId), FS_GUARD_MAP, [
      "getDataDir",
      "getCacheDir",
      "getTempDir",
    ]),
    clipboard: guardNativeApi(pluginId, createClipboardAPI(pluginId), CLIPBOARD_GUARD_MAP),
    shell: createShellAPI(pluginId),
    db: guardNativeApi(pluginId, createDatabaseAPI(pluginId), DB_GUARD_MAP),
    shortcuts: createShortcutsAPI(pluginId),
    contextMenu: createContextMenuAPI(pluginId),
    tray: createTrayAPI({
      pluginId,
      capabilities: plugin.manifest.capabilities ?? [],
    }),
    quickActions: createQuickActionsAPI({
      pluginId,
      capabilities: plugin.manifest.capabilities ?? [],
    }),
    window: createWindowAPI(pluginId),
    secrets: guardNativeApi(pluginId, createSecretsAPI(pluginId), SECRETS_GUARD_MAP, [
      "onDidChange",
    ]),
    scheduler: createSchedulerAPI(pluginId, plugin.manifest.capabilities ?? []),
    workflow: createWorkflowAPI(pluginId),
    dexie: plugin.manifest.dexie
      ? createDexieAPI(getDb() as unknown as import("dexie").default, pluginId)
      : undefined,
  }

  // If debug mode is enabled, wrap the context with debug instrumentation
  if (options?.enableDebug) {
    const debugger_ = getPluginDebugger()
    debugger_.startSession(pluginId, options.generation ?? 0)
    return debugger_.createDebugContext(pluginId, baseContext)
  }

  return baseContext
}

/**
 * Create a full plugin context with every host-mounted API.
 */
export function createFullPluginContext(
  plugin: Plugin,
  manager: PluginManager,
  options?: { enableDebug?: boolean; generation?: number }
): FullPluginContext {
  const pluginId = plugin.manifest.id

  // Get the base context (with optional debug mode)
  const baseContext = createPluginContext(plugin, manager, options)

  const permissionsAPI = createPermissionAPI(pluginId, plugin.manifest.permissions || [])
  const templateRuntime = getTemplateRuntime()
  // Resolved before the feature APIs are built, not after: `ctx.commands`
  // registers into a process-global registry and needs the plugin's own
  // lifecycle ledger to hand its disposers to.
  const scope = manager.getPluginDisposableScope?.(pluginId) ?? new PluginDisposableScope(pluginId)
  let lifecycleDisposerSequence = 0

  // Create feature APIs
  const contextAPI: PluginContextAPI = {
    session: createSessionAPI(pluginId),
    project: createProjectAPI(pluginId),
    vector: createVectorAPI(pluginId),
    theme: createThemeAPI(pluginId),
    export: createExportAPI(pluginId),
    import: createImportAPI(pluginId),
    configuration: createConfigAPI(pluginId, manager),
    i18n: createI18nAPI(pluginId),
    canvas: createCanvasAPI(pluginId),
    artifact: createArtifactAPI(pluginId),
    files: createFilesAPI(pluginId),
    skills: createSkillsAPI(pluginId, plugin.manifest.builtInSkills),
    media: createMediaAPI(pluginId, manager),
    notifications: createNotificationCenterAPI(pluginId),
    storage: createStorageAPI(pluginId),
    ai: createAIProviderAPI(pluginId),
    extensions: createExtensionAPI(pluginId, {
      governanceMode: manager.getPluginPointGovernanceMode(),
      hasPermission: (permission) => permissionsAPI.hasPermission(permission as never),
    }),
    contextPanels: createContextPanelAPI(pluginId, (permission) =>
      permissionsAPI.hasPermission(permission as never)
    ),
    editor: createEditorAPI(pluginId, (permission) =>
      permissionsAPI.hasPermission(permission as never)
    ),
    permissions: permissionsAPI,
    templates: createTemplatesAPI(pluginId, {
      catalog: templateRuntime.catalog,
      service: templateRuntime.service,
      // The templates API resolves a definition's declared *capabilities* into
      // permission ids, and an unrecognised capability falls through as its own
      // raw string — so what arrives here is `string`, not a known permission.
      // The cast is safe because `hasPermission` is a set-membership check:
      // a string that is not a real permission is simply denied.
      hasPermission: (permission) =>
        permissionsAPI.hasPermission(permission as IntrospectablePluginPermission),
      confirm: ({ action, definitionId }) =>
        getPluginConsentBroker().request({
          pluginId,
          permission:
            action === "instantiate" ? "templates:instantiate" : "templates:library:write",
          reason: `${action}:${definitionId}`,
        }),
    }),
    commands: createCommandsAPI(pluginId, {
      track: (dispose, label) => scope.track(dispose, label),
    }),
    messagePart: createMessagePartAPI(pluginId),
    toolResult: createToolResultAPI(pluginId),
  }

  // Add new communication and utility APIs to base context
  const ipcAPI = createIPCAPI(pluginId)
  const eventAPI = createEventAPI(pluginId)
  // Merge IPC and events into the base context events
  const enhancedEvents = {
    ...baseContext.events,
    ipc: ipcAPI,
    bus: eventAPI,
  }

  // Keep the compatibility aliases on the same shared overlay-backed API.
  // Using the legacy i18n loader for `t` here would hide manifest messages
  // registered by PluginManager immediately before activate().
  const enhancedI18n = {
    ...contextAPI.i18n,
    getLocale: contextAPI.i18n.getCurrentLocale,
    hasKey: contextAPI.i18n.hasTranslation,
  }

  // Combine base and feature API contexts with enhanced APIs + ADR-0026
  // v2 namespaces (`ocr`, `workspace`). Both are stateless wrappers; the
  // underlying registries already auto-clean on disable through the
  // bridge layer's `clear*ForPlugin(pluginId)` hooks.
  const fullContext = {
    ...baseContext,
    ...contextAPI,
    services: baseContext.services ?? manager.createPluginServicesAPI(pluginId),
    lifecycle: {
      signal: scope.signal,
      onDispose: (dispose: () => void | Promise<void>, label?: string) => {
        lifecycleDisposerSequence += 1
        scope.track(dispose, label ?? `ctx.lifecycle.onDispose#${lifecycleDisposerSequence}`)
      },
    },
    events: enhancedEvents,
    i18n: enhancedI18n,
    ocr: createOcrAPI(pluginId),
    workspace: createWorkspaceAPI(pluginId),
    modal: createModalAPI(pluginId),
    webview: createWebviewAPI(pluginId, plugin.manifest.networkAccess),
    auth: createAuthAPI(pluginId, {
      hasPermission: (p) => (plugin.manifest.permissions ?? []).includes(p as never),
    }),
    uri: createUriAPI(pluginId),
    chat: createChatAPI(pluginId),
    capabilities: createCapabilitiesAPI(),
    git: createGitAPI(pluginId),
    goals: createGoalAPI(pluginId),
    hooks: createHooksAPI(pluginId),
    plans: createPlanAPI(pluginId),
    memory: createMemoryAPI(pluginId),
    team: createTeamAPI(pluginId),
    subscription: createSubscriptionAPI(pluginId),
    terminal: createTerminalAPI(pluginId),
    perf: createPerfAPI(pluginId),
    logs: createLogsAPI(pluginId),
    connectors: createConnectorsAPI(pluginId),
    integrations: createIntegrationsAPI(pluginId, (permission) =>
      permissionsAPI.hasPermission(permission as never)
    ),
    share: createShareAPI(pluginId),
    backup: createBackupAPI(pluginId),
    automation: createAutomationAPI(pluginId),
    browser: createBrowserAPI(),
    characterPacks: createCharacterPacksAPI(pluginId),
    sandbox: createSandboxAPI(pluginId),
    recorder: createRecorderAPI(pluginId),
    securityScans: createSecurityScansAPI(),
    eval: createEvalAPI(),
    userScheduler: createUserSchedulerAPI(),
    companion: createCompanionAPI(pluginId),
    pet: createPetAPI({ pluginId, capabilities: plugin.manifest.capabilities ?? [] }),
    resources: createResourcesAPI(pluginId),
    sites: createSitesAPI(),
  } satisfies PublicFullPluginContext
  const governedContext = withGovernedPluginContext(fullContext, {
    pluginId,
    // Classify by manifest type rather than defaulting to "frontend": a python
    // plugin's calls were being audited as a runtime it does not run in, which
    // meant the catalog's per-runtime gate could never fire for it. Enforcement
    // is still per-namespace `shadow`, so this changes what is recorded, not
    // what is allowed.
    runtime: pluginApiRuntimeForType(plugin.manifest.type),
    hasPermission: (permission) => permissionsAPI.hasPermission(permission),
  })
  scope.track(() => revokePluginFileHandles(pluginId), "ctx.files.handles")
  return withPluginDisposableScope(
    scope,
    "ctx",
    governedContext,
    manager.isPluginLedgerV2Enabled?.() === false ? {} : PLUGIN_RESOURCE_EFFECTS
  ) as FullPluginContext
}

/**
 * Check if a context is a full plugin context
 */
export function isFullPluginContext(
  context: PluginBaseContext | PluginContext
): context is FullPluginContext {
  return "session" in context && "project" in context && "vector" in context
}

// =============================================================================
// Logger
// =============================================================================

function createLogger(pluginId: string): PluginLogger {
  // Tagged at the source, so `/logs`'s `plugin` facet sees every line a plugin
  // writes rather than only the ones a debug session happened to be recording.
  //
  // `getLogSource()` in `components/logging/log-panel.tsx` keys off the entry's
  // `origin`/`runtime`, which the bare plugin child logger never set, so a
  // plugin's own output was filed as ordinary `frontend` noise and the detail
  // pane's Logs deep link (`src=plugin`) matched none of it. Routing that
  // through the devtools ring instead would only have covered plugins running
  // with `enableDebug`, which is developer mode AND non-builtin, so in a
  // default install it covered nothing at all. `withContext` merges into every
  // entry's data and the two keys are hoisted to the entry itself.
  return createPluginSystemLogger(pluginId).withContext({
    runtime: "plugin",
    origin: "plugin",
    pluginId,
  })
}

// =============================================================================
// Storage
// =============================================================================

function createStorage(pluginId: string): PluginStorage {
  const storageKey = `cognia-plugin-storage:${pluginId}`

  const getStorageData = (): Record<string, unknown> => {
    try {
      const data = localStorage.getItem(storageKey)
      return data ? JSON.parse(data) : {}
    } catch {
      return {}
    }
  }

  const setStorageData = (data: Record<string, unknown>): void => {
    localStorage.setItem(storageKey, JSON.stringify(data))
  }

  return {
    get: async <T>(key: string): Promise<T | undefined> => {
      const data = getStorageData()
      return data[key] as T | undefined
    },

    set: async <T>(key: string, value: T): Promise<void> => {
      const data = getStorageData()
      data[key] = value
      setStorageData(data)
    },

    delete: async (key: string): Promise<void> => {
      const data = getStorageData()
      delete data[key]
      setStorageData(data)
    },

    keys: async (): Promise<string[]> => {
      const data = getStorageData()
      return Object.keys(data)
    },

    clear: async (): Promise<void> => {
      localStorage.removeItem(storageKey)
    },
  }
}

// =============================================================================
// Event Emitter
// =============================================================================

function createEventEmitter(pluginId: string): PluginEventEmitter {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const eventPrefix = `plugin:${pluginId}:`

  return {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const key = eventPrefix + event
      if (!listeners.has(key)) {
        listeners.set(key, new Set())
      }
      listeners.get(key)!.add(handler)

      // Return unsubscribe function
      return () => {
        const eventListeners = listeners.get(key)
        if (eventListeners) {
          eventListeners.delete(handler)
        }
      }
    },

    off: (event: string, handler: (...args: unknown[]) => void) => {
      const key = eventPrefix + event
      const eventListeners = listeners.get(key)
      if (eventListeners) {
        eventListeners.delete(handler)
      }
    },

    emit: (event: string, ...args: unknown[]) => {
      const key = eventPrefix + event
      const eventListeners = listeners.get(key)
      if (eventListeners) {
        eventListeners.forEach((handler) => {
          try {
            handler(...args)
          } catch (error) {
            loggers.hooks.error(`Error in plugin event handler for ${event}:`, error)
          }
        })
      }
    },

    once: (event: string, handler: (...args: unknown[]) => void) => {
      const wrappedHandler = (...args: unknown[]) => {
        handler(...args)
        const key = eventPrefix + event
        listeners.get(key)?.delete(wrappedHandler)
      }

      const key = eventPrefix + event
      if (!listeners.has(key)) {
        listeners.set(key, new Set())
      }
      listeners.get(key)!.add(wrappedHandler)

      return () => {
        listeners.get(key)?.delete(wrappedHandler)
      }
    },
  }
}

// =============================================================================
// UI API
// =============================================================================

function createUIAPI(pluginId: string): PluginUIAPI {
  // Push a data-driven dialog onto the plugin modal stack and resolve when the
  // user acts (or with the dismiss default if they close it). Routes through
  // the WIRED `<PluginModalRoot />` instead of `window.prompt`/`confirm`, which
  // are unreliable in the Tauri / Capacitor shells.
  const openDataDialog = <T>(
    args:
      | { kind: "dialog"; options: PluginDialog }
      | { kind: "input"; options: PluginInputDialog }
      | { kind: "confirm"; options: PluginConfirmDialog },
    dismiss: T
  ): Promise<T> => {
    return new Promise<T>((resolve) => {
      let settled = false
      const settle = (value: unknown): void => {
        if (settled) return
        settled = true
        resolve(value as T)
      }
      try {
        usePluginModalStore.getState().open({
          pluginId,
          component: PluginDataDialog,
          args: { ...args, settle },
        })
      } catch (error) {
        recordSilentFailure(
          pluginId,
          { site: "ui.showDialog", message: "Failed to open plugin dialog", expected: false },
          error
        )
        settle(dismiss)
      }
    })
  }

  return {
    showNotification: async (options: PluginNotification) => {
      try {
        // `plugin_show_notification(app, args: ShowNotificationArgs)` takes a
        // single struct parameter, so Tauri deserializes it from the `args`
        // key — a flat payload leaves `args` absent and the required `title`
        // unresolvable, which fails before the notification is ever built.
        await invoke("plugin_show_notification", {
          args: {
            title: options.title,
            body: options.body ?? options.message ?? "",
            icon: options.icon,
          },
        })
      } catch (error) {
        recordSilentFailure(
          pluginId,
          {
            site: "ui.showNotification",
            message: "Failed to show notification",
            expected: false,
          },
          error
        )
      }
    },

    showToast: (message: string, type: "info" | "success" | "warning" | "error" = "info") => {
      // Route to the sonner `<Toaster />` already mounted in `app/layout.tsx`.
      switch (type) {
        case "success":
          toast.success(message)
          break
        case "warning":
          toast.warning(message)
          break
        case "error":
          toast.error(message)
          break
        default:
          toast.info(message)
      }
    },

    showDialog: (options: PluginDialog): Promise<unknown> =>
      openDataDialog<unknown>({ kind: "dialog", options }, undefined),

    showInputDialog: (options: PluginInputDialog): Promise<string | null> =>
      openDataDialog<string | null>({ kind: "input", options }, null),

    showConfirmDialog: (options: PluginConfirmDialog): Promise<boolean> =>
      openDataDialog<boolean>({ kind: "confirm", options }, false),
  }
}

// =============================================================================
// A2UI API
// =============================================================================

function createA2UIAPI(pluginId: string, manager: PluginManager): PluginA2UIAPI {
  const a2uiStore = useA2UIStore.getState()

  return {
    createSurface: (id: string, type: A2UISurfaceType, options?: { title?: string }) => {
      a2uiStore.createSurface(id, type, options)
    },

    deleteSurface: (id: string) => {
      a2uiStore.deleteSurface(id)
    },

    updateComponents: (surfaceId: string, components: A2UIComponent[]) => {
      a2uiStore.processMessage({
        type: "updateComponents",
        surfaceId,
        components,
      })
    },

    setReady: (surfaceId: string) => {
      a2uiStore.processMessage({ type: "surfaceReady", surfaceId })
    },

    updateDataModel: (surfaceId: string, data: Record<string, unknown>, merge = true) => {
      a2uiStore.processMessage({
        type: "dataModelUpdate",
        surfaceId,
        data,
        merge,
      })
    },

    getSurface: (id: string) => {
      return a2uiStore.getSurface(id)
    },

    registerComponent: (component: PluginA2UIComponent) => {
      manager.getA2UIBridge().registerComponent(pluginId, component)
    },

    registerTemplate: (template: A2UITemplateDef) => {
      manager.getA2UIBridge().registerTemplate(pluginId, template)
    },
  }
}

// =============================================================================
// Agent API
// =============================================================================

/**
 * Gate a tool-enabled agent run behind the plugin's declared `agent:control`
 * permission. Tool-enabled runs reach the host's full tool surface through the
 * sidecar; text-only runs stay ungated (parity with prior behaviour). Throws
 * synchronously so both `run` (async) and `runStreamed` (sync) can call it.
 */
function gateToolEnabledRun(pluginId: string, toolsEnabled: boolean | undefined): void {
  if (toolsEnabled === true && !pluginHasApiPermission(pluginId, "agent:control")) {
    throw new Error(
      'agent run: tool-enabled runs require the "agent:control" permission — declare it in the plugin manifest.'
    )
  }
}

/**
 * Apply the plugin's `networkAccess` egress clamp to a promoted host tool whose
 * target the plugin supplies.
 *
 * Returns a structured {@link PluginHostToolFailure} rather than throwing: the
 * author-callable contract is that an expected refusal arrives as a coded
 * result, and `"blocked"` is the code reserved for a guard saying no. A plugin
 * with no `networkAccess` declaration is denied, matching `ctx.network` — the
 * host tool must not be the softer door into the same network.
 *
 * Scope is ONLY the manifest domain clamp. The SSRF target policy
 * (scheme, private/loopback/link-local hosts) belongs to `runWebBuiltinTool`,
 * which is the layer that knows the user's `webTools.allowPrivateHosts`
 * opt-in; running `evaluateEgress` here re-decided it with the default policy,
 * so a user who had opted in still got a refusal — reported, wrongly, as the
 * plugin's manifest denying its own `["*"]`.
 */
function deniedHostToolEgress(
  pluginId: string,
  manager: PluginManager,
  name: string,
  args: Record<string, unknown> | undefined
): PluginHostToolFailure | null {
  if (name !== "web_fetch") return null
  const url = args?.url
  if (typeof url !== "string" || !url) return null
  const host = hostFromUrl(url)
  // Unparseable target: not a domain question. `runWebBuiltinTool`'s guard
  // rejects it with the accurate reason.
  if (!host) return null
  const networkAccess = manager.getPlugin(pluginId)?.manifest.networkAccess
  const domains = networkAccess?.allowedDomains ?? networkAccess?.rules?.map((rule) => rule.domain)
  if (domains && matchHost(host, domains)) return null
  return {
    ok: false,
    code: "blocked",
    error: domains
      ? `web_fetch to ${host} is outside plugin ${pluginId}'s networkAccess.allowedDomains.`
      : `web_fetch is refused: plugin ${pluginId} declares no networkAccess.`,
  }
}

function createAgentAPI(pluginId: string, manager: PluginManager): PluginAgentAPI {
  return {
    registerTool: (tool: PluginToolRegistration) => {
      const ownedTool = { ...tool, pluginId }
      manager.getRegistry().registerTool(pluginId, ownedTool)
      usePluginStore.getState().registerPluginTool(pluginId, ownedTool)
      let registered = true
      return () => {
        if (!registered) return
        registered = false
        const current = manager.getRegistry().getTool(tool.name)
        if (current?.pluginId === pluginId) {
          manager.getRegistry().unregisterTool(tool.name)
          usePluginStore.getState().unregisterPluginTool(pluginId, tool.name)
        }
      }
    },

    unregisterTool: (name: string) => {
      const current = manager.getRegistry().getTool(name)
      if (current?.pluginId !== pluginId) {
        throw new Error(`plugin ${pluginId} does not own tool ${name}`)
      }
      manager.getRegistry().unregisterTool(name)
      usePluginStore.getState().unregisterPluginTool(pluginId, name)
    },

    registerMode: (mode: AgentModeConfig) => {
      const prefixedMode = {
        ...mode,
        id: `${pluginId}:${mode.id}`,
      }
      manager.getRegistry().registerMode(pluginId, prefixedMode)
      usePluginStore.getState().registerPluginMode(pluginId, prefixedMode)
      let registered = true
      return () => {
        if (!registered) return
        registered = false
        manager.getRegistry().unregisterMode(prefixedMode.id)
        usePluginStore.getState().unregisterPluginMode(pluginId, prefixedMode.id)
      }
    },

    unregisterMode: (id: string) => {
      const prefixedId = `${pluginId}:${id}`
      manager.getRegistry().unregisterMode(prefixedId)
      usePluginStore.getState().unregisterPluginMode(pluginId, prefixedId)
    },

    run: async (
      prompt: string,
      options: PluginAgentRunOptions = {}
    ): Promise<PluginAgentRunResult> => {
      gateToolEnabledRun(pluginId, options.toolsEnabled)
      return runPluginAgent(prompt, options, { pluginId })
    },

    runCharacterTurn: async (request) => {
      if (!pluginHasApiPermission(pluginId, "agent:control")) {
        throw new Error(
          'agent.runCharacterTurn requires the "agent:control" permission — declare it in the plugin manifest.'
        )
      }
      const { runPluginAgentTurn } = await import("../api/agent-turn")
      return runPluginAgentTurn(request)
    },

    runStreamed: (prompt: string, options: PluginAgentRunOptions = {}): PluginAgentRun => {
      gateToolEnabledRun(pluginId, options.toolsEnabled)
      return runPluginAgentStreamed(prompt, options, { pluginId })
    },

    invokeTool: (async (
      name: string,
      args: Record<string, unknown>,
      opts?: PluginInvocationOptions
    ) => {
      if (!pluginHasApiPermission(pluginId, "agent:control")) {
        throw new Error(
          'agent.invokeTool requires the "agent:control" permission — declare it in the plugin manifest.'
        )
      }
      if (typeof name !== "string" || !name) {
        throw new Error("agent.invokeTool requires a tool name")
      }
      // ── 1. Author-callable host tools ─────────────────────────────────────
      // Resolved FIRST so a plugin cannot shadow a promoted host tool by
      // registering the same name — the host's search/fetch policy (providers,
      // cache, source verification, PII, SSRF, rate limit) must be the one that
      // runs. Only the names on the allowlist reach here; every other host tool
      // stays private to the agent loop.
      if (isAuthorCallableHostTool(name)) {
        // Running host-side reuses the host's SSRF guard and rate limiter, but
        // NOT the plugin's own egress clamp — `runWebBuiltinTool` has never
        // heard of a manifest. `web_fetch` is the one promoted tool whose
        // target the PLUGIN chooses, so it stays inside
        // `networkAccess.allowedDomains` exactly like `ctx.network` would.
        // (`web_search` reaches only the user's configured search providers,
        // which the plugin does not pick, so the allowlist does not apply.)
        const egressDenial = deniedHostToolEgress(pluginId, manager, name, args)
        if (egressDenial) return egressDenial
        const runtime = resolvePluginHostRuntime({
          pluginId,
          ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
          ...(opts?.messageId ? { messageId: opts.messageId } : {}),
        })
        return runtime.runHostTool(name, args ?? {}, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
        })
      }
      // ── 2. The calling plugin's own tools ─────────────────────────────────
      // Cross-plugin calls are NOT reachable from here: `invokePluginTool`
      // enforces ownership, and a plugin that means to call another plugin's
      // tool must declare the dependency and use `invokeDependencyTool`.
      const { result } = await invokePluginTool(pluginId, name, args ?? {}, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts?.messageId ? { messageId: opts.messageId } : {}),
        reason: `plugin ${pluginId} invoked tool ${name}`,
      })
      return result
    }) as PluginAgentAPI["invokeTool"],

    invokeDependencyTool: async (dependencyId, name, args, opts) => {
      if (!pluginHasApiPermission(pluginId, "agent:control")) {
        throw new Error(
          'agent.invokeDependencyTool requires the "agent:control" permission — declare it in the plugin manifest.'
        )
      }
      const caller = manager.getPlugin(pluginId)
      if (!caller?.manifest.dependencies?.[dependencyId]) {
        throw new Error(`plugin ${pluginId} has not declared dependency ${dependencyId}`)
      }
      if (!name) throw new Error("agent.invokeDependencyTool requires a tool name")
      const { result } = await invokePluginTool(dependencyId, name, args ?? {}, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts?.messageId ? { messageId: opts.messageId } : {}),
        reason: `plugin ${pluginId} invoked dependency tool ${dependencyId}/${name}`,
      })
      return result
    },

    executeAgent: async (config: Record<string, unknown>) => {
      const prompt = typeof config.prompt === "string" ? config.prompt : ""
      if (!prompt) {
        throw new Error("agent.execute requires config.prompt")
      }
      // Map the legacy config bag onto the typed run options. Legacy callers
      // used the executor's field names (`systemPrompt` / `defaultProvider`);
      // translate them to the SDK's (`system` / `provider`). A caller-supplied
      // `agentId` still chooses the cancellation handle.
      const { prompt: _ignored, agentId, label, systemPrompt, defaultProvider, ...rest } = config
      gateToolEnabledRun(pluginId, rest.toolsEnabled === true)
      const options = {
        ...(rest as PluginAgentRunOptions),
        ...(typeof systemPrompt === "string" ? { system: systemPrompt } : {}),
        ...(typeof defaultProvider === "string" ? { provider: defaultProvider } : {}),
      }
      return runPluginAgent(prompt, options, {
        pluginId,
        ...(typeof agentId === "string" && agentId ? { agentId } : {}),
        ...(typeof label === "string" ? { label } : {}),
      })
    },

    runExternalAgent: async (
      presetOrAgentId: string,
      prompt: string,
      options?: Record<string, unknown>
    ) => {
      const { pluginHasApiPermission } = await import("@/lib/plugin/api/permission-api")
      if (!pluginHasApiPermission(pluginId, "agent:dispatch-external")) {
        throw new Error(
          'agent.runExternalAgent requires the "agent:dispatch-external" permission — declare it in the plugin manifest.'
        )
      }
      if (typeof presetOrAgentId !== "string" || !presetOrAgentId) {
        throw new Error("agent.runExternalAgent requires a preset or agent id")
      }
      if (typeof prompt !== "string" || !prompt) {
        throw new Error("agent.runExternalAgent requires a non-empty prompt")
      }

      const [{ getExternalAgentManager }, { createAgentFromPreset }] = await Promise.all([
        import("@/lib/ai/agent/external/manager"),
        import("@/lib/ai/agent/external/presets"),
      ])
      const externalManager = getExternalAgentManager()

      // If the id is a known live instance, execute against it directly.
      // Otherwise treat it as a preset id (including plugin-contributed
      // overlay presets, which `createAgentFromPreset` resolves) and add a
      // fresh instance first.
      let agentId = presetOrAgentId
      if (!externalManager.getAgent(presetOrAgentId)) {
        const config = createAgentFromPreset(presetOrAgentId)
        if (!config) {
          throw new Error(
            `agent.runExternalAgent: no live agent or preset "${presetOrAgentId}" found`
          )
        }
        const instance = await externalManager.addAgent(config)
        agentId = instance.config.id
      }

      return externalManager.execute(
        agentId,
        prompt,
        options as Parameters<typeof externalManager.execute>[2]
      )
    },

    cancelAgent: (agentId: string) => {
      void import("@/lib/ai/agent/background-agent-manager")
        .then(({ getBackgroundAgentManager }) => {
          const cancelled = getBackgroundAgentManager().cancelAgent(agentId)
          if (!cancelled) {
            loggers.agent.warn(`No active background agent to cancel: ${agentId}`)
          }
        })
        .catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "agent.cancelAgent",
              message: `Failed to cancel agent ${agentId}`,
              expected: false,
            },
            error
          )
        )
    },

    // M1·T5 — Plugin-first Computer Use capability registration.
    // Each method writes into the matching §A-3 overlay registry. The plugin
    // manager calls `unregister*ByPlugin(pluginId)` during disable, so plugins
    // don't have to track ids individually — bulk cleanup is automatic.
    registerMcpServerPreset: (def: PluginMcpServerPresetDef) => {
      registerMcpServerPreset(def.id, def, { pluginId })
      refreshAllPackWarnings()
    },

    registerNativeAnthropicTool: (def: PluginNativeAnthropicToolDef) => {
      registerNativeAnthropicTool(def.id, def, { pluginId })
      refreshAllPackWarnings()
    },

    registerSkill: (def: PluginSkillDef) => {
      registerSkill(def.id, def, { pluginId })
      refreshAllPackWarnings()
    },

    registerExternalAgentPreset: (def: PluginExternalAgentPresetDef) => {
      const { id, ...config } = def
      registerExternalAgentPresetOverlay(id, config, { pluginId })
    },

    registerExternalAgentAdapter: (id: string, factory: ProtocolAdapterFactory) => {
      registerPluginProtocolAdapter(`${pluginId}:${id}`, factory, { pluginId })
    },

    // Package B — input/output guardrails. Registration is ungated (a plugin's
    // own validators); guardrails only take effect on runs the plugin starts.
    guardrails: {
      register: (guardrail: PluginGuardrail) => {
        registerGuardrail(guardrail.id, guardrail, { pluginId })
      },
      unregister: (id: string) => {
        unregisterGuardrailById(id)
      },
      list: () => listGuardrailIds(),
    },

    // Package C — programmatic dispatch. Both reach the host's agent fan-out
    // surface, so they require the `agent:dispatch` permission.
    dispatchSubagent: async (
      idOrDef: string | PluginSubagentDef,
      prompt: string,
      options?: PluginDispatchSubagentOptions
    ) => {
      if (!pluginHasApiPermission(pluginId, "agent:dispatch")) {
        throw new Error(
          'agent.dispatchSubagent requires the "agent:dispatch" permission — declare it in the plugin manifest.'
        )
      }
      return dispatchSubagent(idOrDef, prompt, options)
    },

    runTeam: async (teamOrConfig: string | AgentTeamConfig, options?: PluginRunTeamOptions) => {
      if (!pluginHasApiPermission(pluginId, "agent:dispatch")) {
        throw new Error(
          'agent.runTeam requires the "agent:dispatch" permission — declare it in the plugin manifest.'
        )
      }
      return runTeam(teamOrConfig, options)
    },

    // Package D — durable multi-turn sessions. Creating/resuming a session
    // reaches the chat-session store, so it requires the session permissions.
    sessions: {
      create: async (options?: PluginCreateSessionOptions) => {
        if (!pluginHasApiPermission(pluginId, "session:write")) {
          throw new Error(
            'agent.sessions.create requires the "session:write" permission — declare it in the plugin manifest.'
          )
        }
        return createPluginAgentSession(options)
      },
      resume: async (sessionId: string) => {
        if (!pluginHasApiPermission(pluginId, "session:read")) {
          throw new Error(
            'agent.sessions.resume requires the "session:read" permission — declare it in the plugin manifest.'
          )
        }
        return resumePluginAgentSession(sessionId)
      },
    },

    // Package E — context/memory providers + guarded reads. Provider
    // registration is ungated (a plugin's own ambient context); the reads reach
    // new sensitive data domains so each needs its own permission.
    context: {
      registerProvider: (provider: PluginContextProvider) => {
        registerContextProvider(provider.id, provider, { pluginId })
      },
      unregisterProvider: (id: string) => {
        unregisterContextProviderById(id)
      },
      listProviders: () => listContextProviderIds(),
      readSharedMemory: async (teamId: string, opts?: PluginSharedMemoryReadOptions) => {
        if (!pluginHasApiPermission(pluginId, "agent:shared-memory:read")) {
          throw new Error(
            'agent.context.readSharedMemory requires the "agent:shared-memory:read" permission — declare it in the plugin manifest.'
          )
        }
        return readSharedMemory(teamId, opts)
      },
      queryTwinMemory: async (
        characterId: string,
        query: string,
        opts?: PluginTwinMemoryQueryOptions
      ) => {
        if (!pluginHasApiPermission(pluginId, "twin:read")) {
          throw new Error(
            'agent.context.queryTwinMemory requires the "twin:read" permission — declare it in the plugin manifest.'
          )
        }
        return queryTwinMemory(characterId, query, opts)
      },
    },
  }
}

// =============================================================================
// Settings API
// =============================================================================

function createSettingsAPI(pluginId: string): PluginSettingsAPI {
  // Persist plugin settings in localStorage under a per-plugin namespace so
  // `get`/`set` read/write the same place, round-trip, and survive reloads
  // (works across browser / Tauri / Capacitor shells, mirroring `createStorage`
  // above). Previously `set` only logged and `get` read a `useSettingsStore`
  // slice that never existed, so the round-trip silently lost every write.
  const settingsKey = `cognia-plugin-settings:${pluginId}`
  const listeners = new Map<string, Set<(value: unknown) => void>>()

  const readAll = (): Record<string, unknown> => {
    try {
      const raw = localStorage.getItem(settingsKey)
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  return {
    get: <T>(key: string): T | undefined => {
      return readAll()[key] as T | undefined
    },

    set: <T>(key: string, value: T) => {
      const data = readAll()
      data[key] = value
      try {
        localStorage.setItem(settingsKey, JSON.stringify(data))
      } catch (error) {
        loggers.manager.error(`Plugin ${pluginId} failed to persist setting ${key}:`, error)
        return
      }

      // Notify same-context listeners synchronously on a real write.
      const keyListeners = listeners.get(key)
      if (keyListeners) {
        keyListeners.forEach((listener) => {
          try {
            listener(value)
          } catch (error) {
            loggers.manager.error(
              `Plugin ${pluginId} settings onChange handler for ${key} threw:`,
              error
            )
          }
        })
      }
    },

    onChange: (key: string, handler: (value: unknown) => void) => {
      if (!listeners.has(key)) {
        listeners.set(key, new Set())
      }
      listeners.get(key)!.add(handler)

      return () => {
        listeners.get(key)?.delete(handler)
      }
    },
  }
}

// =============================================================================
// Python API
// =============================================================================

function createPythonAPI(pluginId: string, manager: PluginManager): PluginPythonAPI {
  const rateLimiter = getPluginRateLimiter()
  return {
    call: async <T>(functionName: string, ...args: unknown[]): Promise<T> => {
      rateLimiter.check(pluginId, "python:call")
      return manager.callPythonFunction<T>(pluginId, functionName, args)
    },

    eval: async <T>(code: string, locals?: Record<string, unknown>): Promise<T> => {
      rateLimiter.check(pluginId, "python:eval")
      return manager.evalPython<T>(pluginId, code, locals)
    },

    import: async (moduleName: string) => {
      rateLimiter.check(pluginId, "python:import")
      try {
        await manager.importPythonModule(pluginId, moduleName)
      } catch (error) {
        recordSilentFailure(
          pluginId,
          {
            site: "python.import",
            message: `Failed to import Python module: ${moduleName}`,
            expected: false,
          },
          error
        )
        throw error
      }

      return {
        call: async <T>(functionName: string, ...args: unknown[]): Promise<T> => {
          return manager.callPythonModule<T>(pluginId, moduleName, functionName, args)
        },

        getattr: async <T>(name: string): Promise<T> => {
          return manager.getPythonModuleAttribute<T>(pluginId, moduleName, name)
        },
      }
    },
  }
}

// =============================================================================
// Network API
// =============================================================================

/**
 * Persist a ledger grant once the user consents to a "confirm"-tier native
 * call. The native fs/secrets/clipboard/network namespaces route through the
 * `plugin_api_invoke` gateway, which the Rust host re-gates against its own
 * ledger — so after a renderer consent we must mirror the grant to the host or
 * the very next gateway call is denied. No-op in the browser (no Rust ledger).
 */
function persistHostConsentGrant(pluginId: string, permission: string): void {
  if (!isPluginGatewayAvailable()) return
  void grantPluginPermission(pluginId, permission, "user").catch(() => undefined)
}

/**
 * Wrap a native gateway namespace so every method (a) requires its declared
 * permission and (b) routes dangerous-tier actions through the per-call consent
 * overlay before running — closing the gap where these namespaces previously
 * only rate-limited. Pure helpers go in `unguarded`.
 */
function guardNativeApi<T extends object>(
  pluginId: string,
  api: T,
  permissionMap: Partial<Record<keyof T, PluginPermission | PluginPermission[]>>,
  unguarded?: ReadonlyArray<keyof T>
): T {
  return createGuardedAPI(pluginId, api, permissionMap, {
    unguarded,
    onConsentGranted: (permission) => persistHostConsentGrant(pluginId, permission),
  })
}

const NETWORK_GUARD_MAP: Partial<Record<keyof PluginNetworkAPI, PluginPermission>> = {
  get: "network:fetch",
  post: "network:fetch",
  put: "network:fetch",
  delete: "network:fetch",
  patch: "network:fetch",
  fetch: "network:fetch",
  download: "network:fetch",
  upload: "network:upload",
}

const NETWORK_HTTP_METHODS = new Set<NetworkHttpMethod>([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
])

const FS_GUARD_MAP: Partial<Record<keyof PluginFileSystemAPI, PluginPermission>> = {
  readText: "filesystem:read",
  readBinary: "filesystem:read",
  readJson: "filesystem:read",
  exists: "filesystem:read",
  readDir: "filesystem:read",
  stat: "filesystem:read",
  watch: "filesystem:read",
  writeText: "filesystem:write",
  writeBinary: "filesystem:write",
  writeJson: "filesystem:write",
  appendText: "filesystem:write",
  mkdir: "filesystem:write",
  remove: "filesystem:write",
  copy: "filesystem:write",
  move: "filesystem:write",
}

const CLIPBOARD_GUARD_MAP: Partial<Record<keyof PluginClipboardAPI, PluginPermission>> = {
  readText: "clipboard:read",
  readImage: "clipboard:read",
  hasText: "clipboard:read",
  hasImage: "clipboard:read",
  writeText: "clipboard:write",
  writeImage: "clipboard:write",
  clear: "clipboard:write",
}

const SECRETS_GUARD_MAP: Partial<Record<keyof PluginSecretsAPI, PluginPermission>> = {
  get: "secrets:read",
  has: "secrets:read",
  keys: "secrets:read",
  store: "secrets:write",
  delete: "secrets:write",
}

const DB_GUARD_MAP: Partial<Record<keyof PluginDatabaseAPI, PluginPermission>> = {
  query: "database:read",
  tableExists: "database:read",
  execute: "database:write",
  createTable: "database:write",
  dropTable: "database:write",
  transaction: "database:write",
}

function createNetworkAPI(
  pluginId: string,
  networkAccess?: PluginManifest["networkAccess"]
): PluginNetworkAPI {
  const rateLimiter = getPluginRateLimiter()
  const auditEgress = (
    url: string,
    method: NetworkHttpMethod,
    options?: Pick<NetworkRequestOptions, "dataClassification" | "piiPolicy">,
    fileContentPolicy?: UploadOptions["fileContentPolicy"]
  ): void => {
    const target = new URL(url)
    getPermissionGuard().recordUsage(
      pluginId,
      fileContentPolicy ? "network:upload" : "network:fetch",
      `egress ${method} ${target.origin}${target.pathname} ` +
        `classification=${options?.dataClassification ?? "unspecified"} ` +
        (fileContentPolicy
          ? `metadataPii=${options?.piiPolicy ?? "redact"} fileContent=${fileContentPolicy}/raw`
          : `pii=${options?.piiPolicy ?? "redact"}`)
    )
  }
  const parseBrowserResponse = async <T>(
    response: Response,
    responseType?: NetworkRequestOptions["responseType"]
  ): Promise<NetworkResponse<T>> => {
    const resolvedType = responseType || "json"
    let data: unknown

    if (resolvedType === "text") {
      data = await response.text()
    } else if (resolvedType === "blob") {
      data = await response.blob()
    } else if (resolvedType === "arraybuffer") {
      data = await response.arrayBuffer()
    } else {
      const contentType = response.headers.get("content-type") || ""
      data = contentType.includes("application/json")
        ? await response.json()
        : await response.text()
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: data as T,
    }
  }

  const makeRequest = async <T>(
    url: string,
    options?: NetworkRequestOptions
  ): Promise<NetworkResponse<T>> => {
    rateLimiter.check(pluginId, "network:fetch")
    const method = (options?.method ?? "GET").toUpperCase() as NetworkHttpMethod
    if (!NETWORK_HTTP_METHODS.has(method)) {
      throw new Error(`network policy denied unsupported HTTP method: ${String(options?.method)}`)
    }
    const egress = sanitizePluginNetworkEgress(pluginId, {
      url,
      headers: options?.headers,
      body: options?.body,
      piiPolicy: options?.piiPolicy,
    })
    // Renderer-side egress policy. The Tauri path mirrors this in Rust for
    // defense-in-depth; this is the enforcement point in web/mobile mode.
    assertNetworkRequestAllowed(
      pluginId,
      egress.url,
      method,
      networkAccess,
      getPluginSecurityPosture()
    )
    auditEgress(egress.url, method, options)
    const requestOptions = {
      ...options,
      method,
      headers: egress.headers,
      body: egress.body,
    }
    delete requestOptions.dataClassification
    delete requestOptions.piiPolicy
    if (!isPluginGatewayAvailable()) {
      const headers = { ...(requestOptions.headers ?? {}) }
      const body =
        requestOptions.body === undefined || typeof requestOptions.body === "string"
          ? requestOptions.body
          : JSON.stringify(requestOptions.body)
      if (body !== undefined && typeof requestOptions.body !== "string") {
        const hasContentType = Object.keys(headers).some(
          (header) => header.toLowerCase() === "content-type"
        )
        if (!hasContentType) headers["content-type"] = "application/json"
      }
      const response = await fetch(egress.url, {
        method,
        headers,
        body,
        signal: requestOptions.signal,
      })
      return parseBrowserResponse<T>(response, options?.responseType)
    }

    return invokePluginApi<NetworkResponse<T>>(pluginId, "network:fetch", {
      url: egress.url,
      options: requestOptions,
    })
  }

  return {
    get: <T>(url: string, options?: NetworkRequestOptions) =>
      makeRequest<T>(url, { ...options, method: "GET" }),

    post: <T>(url: string, body?: unknown, options?: NetworkRequestOptions) =>
      makeRequest<T>(url, { ...options, method: "POST", body }),

    put: <T>(url: string, body?: unknown, options?: NetworkRequestOptions) =>
      makeRequest<T>(url, { ...options, method: "PUT", body }),

    delete: <T>(url: string, options?: NetworkRequestOptions) =>
      makeRequest<T>(url, { ...options, method: "DELETE" }),

    patch: <T>(url: string, body?: unknown, options?: NetworkRequestOptions) =>
      makeRequest<T>(url, { ...options, method: "PATCH", body }),

    fetch: makeRequest,

    download: async (
      url: string,
      destPath: string,
      options?: DownloadOptions
    ): Promise<DownloadResult> => {
      rateLimiter.check(pluginId, "network:download")
      const egress = sanitizePluginNetworkEgress(pluginId, {
        url,
        headers: options?.headers,
        piiPolicy: options?.piiPolicy,
      })
      assertNetworkRequestAllowed(
        pluginId,
        egress.url,
        "GET",
        networkAccess,
        getPluginSecurityPosture()
      )
      auditEgress(egress.url, "GET", options)
      if (!isPluginGatewayAvailable()) {
        const response = await fetch(egress.url, { headers: egress.headers })
        if (!response.ok) {
          throw new PluginGatewayError({
            code: "NOT_SUPPORTED",
            message: `Failed to download ${egress.url}: ${response.status} ${response.statusText}`,
            requestId: `browser-network-download-${pluginId}`,
            api: "network:download",
            pluginId,
          })
        }

        const blob = await response.blob()
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = objectUrl
        anchor.download = destPath.split("/").pop() || "download.bin"
        anchor.click()
        URL.revokeObjectURL(objectUrl)

        return {
          path: destPath,
          size: blob.size,
          contentType: blob.type || undefined,
        }
      }

      // The host streams the body into the plugin's data sandbox; `onProgress`
      // can't cross the IPC boundary, so only the static request shape is sent.
      return invokePluginApi<DownloadResult>(pluginId, "network:download", {
        url: egress.url,
        destPath,
        headers: egress.headers,
      })
    },

    upload: async (
      url: string,
      filePath: string,
      options?: UploadOptions
    ): Promise<NetworkResponse<unknown>> => {
      rateLimiter.check(pluginId, "network:upload")
      const egress = sanitizePluginNetworkEgress(pluginId, {
        url,
        headers: options?.headers,
        piiPolicy: options?.piiPolicy,
      })
      assertNetworkRequestAllowed(
        pluginId,
        egress.url,
        "POST",
        networkAccess,
        getPluginSecurityPosture()
      )
      const fileContentPolicy = options?.fileContentPolicy ?? "block"
      if (fileContentPolicy !== "allow") {
        throw new Error("network:upload file content is blocked; set fileContentPolicy to allow")
      }
      if (!options?.dataClassification) {
        throw new Error(
          "network:upload requires dataClassification when fileContentPolicy is allow"
        )
      }
      auditEgress(egress.url, "POST", options, fileContentPolicy)
      return invokePluginApi<NetworkResponse<unknown>>(pluginId, "network:upload", {
        url: egress.url,
        filePath,
        headers: egress.headers,
        // When set, the host sends multipart/form-data with this field name;
        // otherwise the file bytes are the raw request body.
        fieldName: options?.fieldName,
        fileContentPolicy,
        dataClassification: options?.dataClassification,
      })
    },
  }
}

// =============================================================================
// File System API
// =============================================================================

function createFileSystemAPI(pluginId: string): PluginFileSystemAPI {
  const rateLimiter = getPluginRateLimiter()
  const dataDir = `plugins_runtime/${pluginId}/data`
  const cacheDir = `plugins_runtime/${pluginId}/cache`
  const tempDir = `plugins_runtime/${pluginId}/temp`
  const notSupported = (api: string): Promise<never> => {
    return Promise.reject(
      new PluginGatewayError({
        code: "NOT_SUPPORTED",
        message: `${api} requires the Cognia desktop app in browser runtime.`,
        requestId: `browser-${api}-${pluginId}`,
        api,
        pluginId,
      })
    )
  }

  return {
    readText: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isPluginGatewayAvailable()) return notSupported("fs:readText")
      return invokePluginApi<string>(pluginId, "fs:readText", { path })
    },

    readBinary: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isPluginGatewayAvailable()) return notSupported("fs:readBinary")
      return invokePluginApi<number[]>(pluginId, "fs:readBinary", { path }).then((bytes) =>
        Uint8Array.from(bytes)
      )
    },

    readJson: async <T>(path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isPluginGatewayAvailable()) return notSupported("fs:readText")
      const raw = await invokePluginApi<string>(pluginId, "fs:readText", { path })
      return JSON.parse(raw) as T
    },

    writeText: (path: string, content: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isPluginGatewayAvailable()) return notSupported("fs:writeText")
      return invokePluginApi<void>(pluginId, "fs:writeText", { path, content })
    },

    writeBinary: (path: string, content: Uint8Array) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isPluginGatewayAvailable()) return notSupported("fs:writeBinary")
      return invokePluginApi<void>(pluginId, "fs:writeBinary", {
        path,
        content: Array.from(content),
      })
    },

    writeJson: async (path: string, data: unknown, pretty = true) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isPluginGatewayAvailable()) return notSupported("fs:writeText")
      const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
      await invokePluginApi<void>(pluginId, "fs:writeText", { path, content })
    },

    appendText: async (path: string, content: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isPluginGatewayAvailable()) return notSupported("fs:writeText")
      let current = ""
      try {
        current = await invokePluginApi<string>(pluginId, "fs:readText", { path })
      } catch {
        current = ""
      }
      await invokePluginApi<void>(pluginId, "fs:writeText", {
        path,
        content: `${current}${content}`,
      })
    },

    exists: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isPluginGatewayAvailable()) return notSupported("fs:exists")
      return invokePluginApi<boolean>(pluginId, "fs:exists", { path })
    },

    mkdir: (path: string, recursive = true) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isPluginGatewayAvailable()) return notSupported("fs:mkdir")
      return invokePluginApi<void>(pluginId, "fs:mkdir", { path, recursive })
    },

    remove: (path: string, recursive = false) => {
      rateLimiter.check(pluginId, "fs:delete")
      if (!isPluginGatewayAvailable()) return notSupported("fs:remove")
      return invokePluginApi<void>(pluginId, "fs:remove", { path, recursive })
    },

    copy: (src: string, dest: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isPluginGatewayAvailable()) return notSupported("fs:copy")
      return invokePluginApi<void>(pluginId, "fs:copy", { src, dest })
    },

    move: (src: string, dest: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isPluginGatewayAvailable()) return notSupported("fs:move")
      return invokePluginApi<void>(pluginId, "fs:move", { src, dest })
    },

    readDir: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isPluginGatewayAvailable()) return notSupported("fs:readDir")
      return invokePluginApi<FileEntry[]>(pluginId, "fs:readDir", { path })
    },

    stat: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isPluginGatewayAvailable()) return notSupported("fs:stat")
      return invokePluginApi<FileStat>(pluginId, "fs:stat", { path })
    },

    watch: (path: string, callback: (event: FileWatchEvent) => void) => {
      const watchId = `${pluginId}:${path}:${Date.now()}`
      invoke("plugin_fs_watch", { pluginId, path, watchId }).catch((error) =>
        recordSilentFailure(
          pluginId,
          {
            site: "fs.watch",
            message: `Failed to watch path: ${path}`,
            expected: false,
          },
          error
        )
      )

      const handler = (event: CustomEvent<FileWatchEvent>) => {
        if (event.detail.path.startsWith(path)) {
          callback(event.detail)
        }
      }

      window.addEventListener(`plugin-fs-watch:${watchId}`, handler as EventListener)

      return () => {
        window.removeEventListener(`plugin-fs-watch:${watchId}`, handler as EventListener)
        invoke("plugin_fs_unwatch", { watchId }).catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "fs.unwatch",
              message: `Failed to unwatch path: ${path}`,
              expected: false,
            },
            error
          )
        )
      }
    },

    getDataDir: () => dataDir,
    getCacheDir: () => cacheDir,
    getTempDir: () => tempDir,
  }
}

// =============================================================================
// Clipboard API
// =============================================================================

function createClipboardAPI(_pluginId: string): PluginClipboardAPI {
  const rateLimiter = getPluginRateLimiter()
  return {
    readText: () => {
      rateLimiter.check(_pluginId, "clipboard:read")
      if (!isTauri()) {
        if (!navigator.clipboard?.readText) {
          throw new PluginGatewayError({
            code: "NOT_SUPPORTED",
            message: "Browser clipboard text read is unavailable in this environment.",
            requestId: `browser-clipboard-read-${_pluginId}`,
            api: "clipboard:readText",
            pluginId: _pluginId,
          })
        }
        return navigator.clipboard.readText()
      }
      return invokePluginApi<string>(_pluginId, "clipboard:readText", {})
    },
    writeText: (text: string) => {
      rateLimiter.check(_pluginId, "clipboard:write")
      if (!isTauri()) {
        if (!navigator.clipboard?.writeText) {
          throw new PluginGatewayError({
            code: "NOT_SUPPORTED",
            message: "Browser clipboard text write is unavailable in this environment.",
            requestId: `browser-clipboard-write-${_pluginId}`,
            api: "clipboard:writeText",
            pluginId: _pluginId,
          })
        }
        return navigator.clipboard.writeText(text)
      }
      return invokePluginApi<void>(_pluginId, "clipboard:writeText", { text })
    },
    readImage: () => {
      rateLimiter.check(_pluginId, "clipboard:read")
      if (!isTauri()) {
        throw new PluginGatewayError({
          code: "NOT_SUPPORTED",
          message: "Browser clipboard image read is unavailable in this environment.",
          requestId: `browser-clipboard-read-image-${_pluginId}`,
          api: "clipboard:readImage",
          pluginId: _pluginId,
        })
      }
      return invokePluginApi<number[] | null>(_pluginId, "clipboard:readImage", {}).then((value) =>
        value ? Uint8Array.from(value) : null
      )
    },
    writeImage: (data: Uint8Array, format?: "png" | "jpeg") => {
      rateLimiter.check(_pluginId, "clipboard:write")
      if (!isTauri()) {
        throw new PluginGatewayError({
          code: "NOT_SUPPORTED",
          message: "Browser clipboard image write is unavailable in this environment.",
          requestId: `browser-clipboard-write-image-${_pluginId}`,
          api: "clipboard:writeImage",
          pluginId: _pluginId,
        })
      }
      return invokePluginApi<void>(_pluginId, "clipboard:writeImage", {
        data: Array.from(data),
        format,
      })
    },
    hasText: () => {
      rateLimiter.check(_pluginId, "clipboard:read")
      if (!isTauri()) {
        if (!navigator.clipboard?.readText) {
          return Promise.resolve(false)
        }
        return navigator.clipboard
          .readText()
          .then((value) => value.length > 0)
          .catch(() => false)
      }
      return invokePluginApi<boolean>(_pluginId, "clipboard:hasText", {})
    },
    hasImage: () => {
      rateLimiter.check(_pluginId, "clipboard:read")
      if (!isTauri()) {
        return Promise.resolve(false)
      }
      return invokePluginApi<boolean>(_pluginId, "clipboard:hasImage", {})
    },
    clear: () => {
      rateLimiter.check(_pluginId, "clipboard:write")
      if (!isTauri()) {
        if (!navigator.clipboard?.writeText) {
          throw new PluginGatewayError({
            code: "NOT_SUPPORTED",
            message: "Browser clipboard clear is unavailable in this environment.",
            requestId: `browser-clipboard-clear-${_pluginId}`,
            api: "clipboard:clear",
            pluginId: _pluginId,
          })
        }
        return navigator.clipboard.writeText("")
      }
      return invokePluginApi<void>(_pluginId, "clipboard:clear", {})
    },
  }
}

// =============================================================================
// Shell API
// =============================================================================

function createShellAPI(pluginId: string): PluginShellAPI {
  const rateLimiter = getPluginRateLimiter()
  return {
    execute: (command: string, options?: ShellOptions) => {
      rateLimiter.check(pluginId, "shell:execute")
      return invokePluginApi<ShellResult>(pluginId, "shell:execute", { command, options })
    },

    spawn: (_command: string, _args?: string[], _options?: SpawnOptions): ChildProcess => {
      rateLimiter.check(pluginId, "process:spawn")
      // The shell/process domain has no host backend (api_bridge.rs routes it to
      // NOT_SUPPORTED on every platform). `spawn` is synchronous, so it cannot
      // surface that rejection through a Promise — it must throw. Returning a
      // hollow ChildProcess (pid:0, dead streams) handed plugin authors silent
      // garbage that looks live; failing loud is the honest contract.
      throw new PluginGatewayError({
        code: "NOT_SUPPORTED",
        message: "ctx.shell.spawn is not supported: the host has no process backend",
        requestId: `${pluginId}:shell:spawn`,
        api: "shell:spawn",
        pluginId,
      })
    },

    open: (path: string) => invokePluginApi<void>(pluginId, "shell:open", { path }),
    showInFolder: (path: string) => invokePluginApi<void>(pluginId, "shell:showInFolder", { path }),
  }
}

// =============================================================================
// Database API
// =============================================================================

function createDatabaseAPI(pluginId: string): PluginDatabaseAPI {
  const rateLimiter = getPluginRateLimiter()
  return {
    query: <T>(sql: string, params?: unknown[]) => {
      rateLimiter.check(pluginId, "db:query")
      return invokePluginApi<T[]>(pluginId, "db:query", { sql, params })
    },

    execute: (sql: string, params?: unknown[]) => {
      rateLimiter.check(pluginId, "db:execute")
      return invokePluginApi<DatabaseResult>(pluginId, "db:execute", { sql, params })
    },

    transaction: async <T>(fn: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => {
      const txId = `${pluginId}:${Date.now()}`
      await invokePluginApi<void>(pluginId, "db:beginTransaction", { txId })

      try {
        const tx: DatabaseTransaction = {
          query: <R>(sql: string, params?: unknown[]) =>
            invokePluginApi<R[]>(pluginId, "db:txQuery", { txId, sql, params }),
          execute: (sql: string, params?: unknown[]) =>
            invokePluginApi<DatabaseResult>(pluginId, "db:txExecute", { txId, sql, params }),
        }

        const result = await fn(tx)
        await invokePluginApi<void>(pluginId, "db:commit", { txId })
        return result
      } catch (error) {
        await invokePluginApi<void>(pluginId, "db:rollback", { txId })
        throw error
      }
    },

    createTable: (name: string, schema: TableSchema) => {
      rateLimiter.check(pluginId, "db:execute")
      return invokePluginApi<void>(pluginId, "db:createTable", { name, schema })
    },

    dropTable: (name: string) => {
      rateLimiter.check(pluginId, "db:execute")
      return invokePluginApi<void>(pluginId, "db:dropTable", { name })
    },

    tableExists: (name: string) => {
      rateLimiter.check(pluginId, "db:query")
      return invokePluginApi<boolean>(pluginId, "db:tableExists", { name })
    },
  }
}

// =============================================================================
// Shortcuts API
// =============================================================================

function createShortcutsAPI(pluginId: string): PluginShortcutsAPI {
  const registeredShortcuts = new Set<string>()

  const api: PluginShortcutsAPI = {
    register: (shortcut: string, callback: () => void, options?: ShortcutOptions) => {
      registeredShortcuts.add(shortcut)

      // Route onto the live shortcut rail (Rust ShortcutRegistry on
      // desktop, the shared keydown fallback in the browser) via the
      // plugin shortcut bridge. The bind is async (conflict check + IPC);
      // the sync disposer contract is kept with a deferred handle.
      let dispose: (() => void) | null = null
      let disposed = false
      import("@/lib/plugin/shortcuts/plugin-shortcut-bridge")
        .then(({ bindPluginShortcut }) =>
          bindPluginShortcut({ pluginId, chord: shortcut, run: callback, options })
        )
        .then((d) => {
          if (disposed) d()
          else dispose = d
        })
        .catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "shortcut.register",
              message: `Failed to register shortcut: ${shortcut}`,
              expected: false,
            },
            error
          )
        )

      return () => {
        disposed = true
        registeredShortcuts.delete(shortcut)
        dispose?.()
        dispose = null
      }
    },

    registerMany: (shortcuts: ShortcutRegistration[]) => {
      const unsubscribes = shortcuts.map(({ shortcut, callback, options }) =>
        api.register(shortcut, callback, options)
      )

      return () => unsubscribes.forEach((unsub) => unsub())
    },

    isAvailable: (shortcut: string) => !registeredShortcuts.has(shortcut),
    getRegistered: () => Array.from(registeredShortcuts),
  }

  return api
}

// =============================================================================
// Context Menu API
// =============================================================================

function createContextMenuAPI(pluginId: string): PluginContextMenuAPI {
  const handlers = new Map<string, (context: ContextMenuClickContext) => void>()

  const api: PluginContextMenuAPI = {
    register: (item: ContextMenuItem) => {
      const id = `${pluginId}:${item.id}`
      handlers.set(id, item.onClick)

      // Renderer registry — the consumer half. UI surfaces (chat message
      // menu, workflow canvas menu, …) read items per zone via
      // `usePluginContextMenuItems` and dispatch the CustomEvent below.
      let unregisterRenderer: (() => void) | null = null
      import("@/lib/plugin/context-menu/registry")
        .then(({ registerContextMenuItem, unregisterContextMenuItem }) => {
          registerContextMenuItem({ id, pluginId, item: { ...item, id } })
          unregisterRenderer = () => unregisterContextMenuItem(id)
        })
        .catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "contextMenu.register",
              message: `Failed to register context menu in renderer registry: ${item.id}`,
              expected: false,
            },
            error
          )
        )

      // Rust mirror — persistence of the registration intent (desktop).
      invoke("plugin_context_menu_register", {
        pluginId,
        item: { ...item, id },
      }).catch((error) =>
        recordSilentFailure(
          pluginId,
          {
            site: "contextMenu.register",
            message: `Failed to register context menu: ${item.id}`,
            expected: false,
          },
          error
        )
      )

      const handler = ((e: CustomEvent<ContextMenuClickContext>) => {
        item.onClick(e.detail)
      }) as EventListener

      window.addEventListener(`plugin-context-menu:${id}`, handler)

      return () => {
        handlers.delete(id)
        window.removeEventListener(`plugin-context-menu:${id}`, handler)
        unregisterRenderer?.()
        unregisterRenderer = null
        invoke("plugin_context_menu_unregister", { pluginId, itemId: id }).catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "contextMenu.unregister",
              message: `Failed to unregister context menu: ${item.id}`,
              expected: false,
            },
            error
          )
        )
      }
    },

    registerMany: (items: ContextMenuItem[]) => {
      const unsubscribes = items.map((item) => api.register(item))

      return () => unsubscribes.forEach((unsub) => unsub())
    },
  }

  return api
}

// =============================================================================
// Window API
// =============================================================================

function createWindowAPI(pluginId: string): PluginWindowAPI {
  const windows = new Map<string, PluginWindow>()

  const createPluginWindow = (id: string, title: string): PluginWindow => ({
    id,
    title,
    setTitle: (newTitle: string) => {
      invokePluginApi<void>(pluginId, "window:setTitle", { windowId: id, title: newTitle }).catch(
        (error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "window.setTitle",
              message: `Failed to set window title (windowId=${id})`,
              expected: false,
            },
            error
          )
      )
    },
    close: () => invokePluginApi<void>(pluginId, "window:close", { windowId: id }),
    minimize: () => invoke<void>("plugin_window_minimize", { windowId: id }),
    maximize: () => invoke<void>("plugin_window_maximize", { windowId: id }),
    unmaximize: () => invoke<void>("plugin_window_unmaximize", { windowId: id }),
    isMaximized: () => invokePluginApi<boolean>(pluginId, "window:isMaximized", { windowId: id }),
    setSize: (width: number, height: number) =>
      invokePluginApi<void>(pluginId, "window:setSize", { windowId: id, width, height }),
    getSize: () =>
      invokePluginApi<{ width: number; height: number }>(pluginId, "window:getSize", {
        windowId: id,
      }),
    setPosition: (x: number, y: number) =>
      invokePluginApi<void>(pluginId, "window:setPosition", { windowId: id, x, y }),
    getPosition: () =>
      invokePluginApi<{ x: number; y: number }>(pluginId, "window:getPosition", { windowId: id }),
    center: () => invokePluginApi<void>(pluginId, "window:center", { windowId: id }),
    setAlwaysOnTop: (flag: boolean) =>
      invoke<void>("plugin_window_set_always_on_top", { windowId: id, flag }),
    show: () => invokePluginApi<void>(pluginId, "window:show", { windowId: id }),
    hide: () => invokePluginApi<void>(pluginId, "window:hide", { windowId: id }),
    onClose: (callback: () => void) => {
      const handler = () => callback()
      window.addEventListener(`plugin-window-close:${id}`, handler)
      return () => window.removeEventListener(`plugin-window-close:${id}`, handler)
    },
  })

  return {
    create: async (options: WindowOptions): Promise<PluginWindow> => {
      const windowId = await invokePluginApi<string>(pluginId, "window:create", { options })
      const win = createPluginWindow(windowId, options.title)
      windows.set(windowId, win)
      return win
    },

    getMain: () => createPluginWindow("main", "Cognia"),
    getAll: () => Array.from(windows.values()),
    focus: (windowId: string) => {
      invokePluginApi<void>(pluginId, "window:focus", { windowId }).catch((error) =>
        recordSilentFailure(
          pluginId,
          {
            site: "window.focus",
            message: `Failed to focus window (windowId=${windowId})`,
            expected: false,
          },
          error
        )
      )
    },
  }
}

// =============================================================================
// Scheduler API
// =============================================================================

import type {
  PluginSchedulerAPI,
  PluginTaskHandler,
  CreatePluginTaskInput,
  UpdatePluginTaskInput,
  PluginTaskFilter,
  PluginScheduledTask,
  PluginTaskExecution,
  PluginTaskTrigger,
  PluginTaskExecutionStatus,
} from "@/types/plugin/plugin-scheduler"
import {
  registerPluginTaskHandler,
  unregisterPluginTaskHandler,
  getPluginTaskHandler,
} from "../scheduler/scheduler-plugin-executor"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { nanoid } from "nanoid"

function mapPluginTaskTrigger(trigger: PluginTaskTrigger): ScheduledTask["trigger"] {
  return {
    type: trigger.type,
    cronExpression: trigger.type === "cron" ? trigger.expression : undefined,
    intervalMs: trigger.type === "interval" ? trigger.seconds * 1000 : undefined,
    runAt: trigger.type === "once" ? new Date(trigger.runAt) : undefined,
    eventType: trigger.type === "event" ? trigger.eventType : undefined,
    eventSource: trigger.type === "event" ? trigger.eventSource : undefined,
    timezone: trigger.type === "cron" ? trigger.timezone : undefined,
  }
}

async function loadTaskScheduler() {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  return getTaskScheduler()
}

const SCHEDULER_SYNC_METHODS = new Set([
  "registerHandler",
  "unregisterHandler",
  "hasHandler",
  "getHandlers",
])

function deniedSchedulerAPI(pluginId: string): PluginSchedulerAPI {
  return new Proxy({} as PluginSchedulerAPI, {
    get: (_target, property) => {
      const error = new Error(
        "Plugin '" +
          pluginId +
          "' must declare the 'scheduler' capability before using ctx.scheduler"
      )
      if (SCHEDULER_SYNC_METHODS.has(String(property))) {
        return () => {
          throw error
        }
      }
      return () => Promise.reject(error)
    },
  })
}

function createSchedulerAPI(
  pluginId: string,
  capabilities: readonly PluginCapability[]
): PluginSchedulerAPI {
  if (!capabilities.includes("scheduler")) {
    return deniedSchedulerAPI(pluginId)
  }
  // Local handler registry for this plugin
  const handlers = new Map<string, PluginTaskHandler>()

  return {
    // Task Management
    createTask: async (input: CreatePluginTaskInput): Promise<PluginScheduledTask> => {
      const scheduler = await loadTaskScheduler()
      const task = await scheduler.createTask({
        name: input.name,
        description: input.description,
        type: "plugin",
        trigger: mapPluginTaskTrigger(input.trigger),
        payload: {
          pluginId,
          handler: input.handler,
          args: input.handlerArgs || {},
          ...(input.metadata && { metadata: input.metadata }),
        },
        config: {
          timeout: (input.timeout || 300) * 1000,
          maxRetries: input.retry?.maxAttempts || 0,
          retryDelay: (input.retry?.delaySeconds || 60) * 1000,
          runMissedOnStartup: false,
          maxMissedRuns: 0,
          allowConcurrent: false,
        },
        notification: {
          onStart: false,
          onComplete: false,
          onError: true,
          onProgress: false,
          channels: ["toast"],
        },
        tags: input.tags,
      })

      if (input.enabled === false) {
        await scheduler.pauseTask(task.id)
        return mapToPluginTask({ ...task, status: "paused" }, pluginId)
      }
      return mapToPluginTask(task, pluginId)
    },

    updateTask: async (
      taskId: string,
      input: UpdatePluginTaskInput
    ): Promise<PluginScheduledTask | null> => {
      const existingTask = await schedulerDb.getTask(taskId)
      if (
        !existingTask ||
        (existingTask.payload as Record<string, unknown>)?.pluginId !== pluginId
      ) {
        return null
      }

      const scheduler = await loadTaskScheduler()
      const updatedTask = await scheduler.updateTask(taskId, {
        name: input.name,
        description: input.description,
        trigger: input.trigger ? mapPluginTaskTrigger(input.trigger) : undefined,
        payload:
          input.handler !== undefined ||
          input.handlerArgs !== undefined ||
          input.metadata !== undefined
            ? {
                ...(existingTask.payload as Record<string, unknown>),
                ...(input.handler !== undefined && { handler: input.handler }),
                ...(input.handlerArgs !== undefined && { args: input.handlerArgs }),
                ...(input.metadata !== undefined && { metadata: input.metadata }),
              }
            : undefined,
        config:
          input.timeout !== undefined || input.retry !== undefined
            ? {
                ...(input.timeout !== undefined && { timeout: input.timeout * 1000 }),
                ...(input.retry !== undefined && {
                  maxRetries: input.retry.maxAttempts,
                  retryDelay: input.retry.delaySeconds * 1000,
                }),
              }
            : undefined,
        tags: input.tags,
      })
      if (!updatedTask) return null
      return mapToPluginTask(updatedTask, pluginId)
    },

    deleteTask: async (taskId: string): Promise<boolean> => {
      const existingTask = await schedulerDb.getTask(taskId)
      if (
        !existingTask ||
        (existingTask.payload as Record<string, unknown>)?.pluginId !== pluginId
      ) {
        return false
      }
      const scheduler = await loadTaskScheduler()
      return scheduler.deleteTask(taskId)
    },

    getTask: async (taskId: string): Promise<PluginScheduledTask | null> => {
      const task = await schedulerDb.getTask(taskId)
      if (!task || (task.payload as Record<string, unknown>)?.pluginId !== pluginId) {
        return null
      }
      return mapToPluginTask(task, pluginId)
    },

    listTasks: async (filter?: PluginTaskFilter): Promise<PluginScheduledTask[]> => {
      const rawStatuses = filter?.status
        ? Array.isArray(filter.status)
          ? filter.status
          : [filter.status]
        : undefined
      // Filter to only valid ScheduledTaskStatus values (exclude 'error'/'completed' which are PluginTaskStatus-only)
      const schedulerCompatible = rawStatuses?.filter((s) =>
        ["active", "paused", "disabled", "expired"].includes(s)
      ) as import("@/types/scheduler").ScheduledTaskStatus[] | undefined
      const allTasks = await schedulerDb.getFilteredTasks({
        types: ["plugin"],
        statuses:
          schedulerCompatible && schedulerCompatible.length > 0 ? schedulerCompatible : undefined,
        tags: filter?.tags,
        search: filter?.name,
      })

      // Filter to only this plugin's tasks
      const pluginTasks = allTasks.filter(
        (t) => (t.payload as Record<string, unknown>)?.pluginId === pluginId
      )

      // Apply additional filters
      let filtered = pluginTasks
      if (filter?.handler) {
        filtered = filtered.filter(
          (t) => (t.payload as Record<string, unknown>)?.handler === filter.handler
        )
      }

      // Apply limit and offset
      if (filter?.offset) {
        filtered = filtered.slice(filter.offset)
      }
      if (filter?.limit) {
        filtered = filtered.slice(0, filter.limit)
      }

      return filtered.map((t) => mapToPluginTask(t, pluginId))
    },

    // Task Control
    pauseTask: async (taskId: string): Promise<boolean> => {
      const existingTask = await schedulerDb.getTask(taskId)
      if (
        !existingTask ||
        (existingTask.payload as Record<string, unknown>)?.pluginId !== pluginId
      ) {
        return false
      }
      const scheduler = await loadTaskScheduler()
      return scheduler.pauseTask(taskId)
    },

    resumeTask: async (taskId: string): Promise<boolean> => {
      const existingTask = await schedulerDb.getTask(taskId)
      if (
        !existingTask ||
        (existingTask.payload as Record<string, unknown>)?.pluginId !== pluginId
      ) {
        return false
      }
      const scheduler = await loadTaskScheduler()
      return scheduler.resumeTask(taskId)
    },

    runTaskNow: async (taskId: string, _args?: Record<string, unknown>): Promise<string> => {
      const existingTask = await schedulerDb.getTask(taskId)
      if (
        !existingTask ||
        (existingTask.payload as Record<string, unknown>)?.pluginId !== pluginId
      ) {
        throw new Error(`Task not found: ${taskId}`)
      }

      // Create a manual execution record
      const executionId = nanoid()
      const execution: TaskExecution = {
        id: executionId,
        taskId,
        taskName: existingTask.name,
        taskType: "plugin",
        status: "pending",
        retryAttempt: 0,
        startedAt: new Date(),
        logs: [],
      }

      await schedulerDb.createExecution(execution)

      // Execute the task asynchronously
      import("@/lib/scheduler/task-scheduler")
        .then(({ getTaskScheduler }) => {
          getTaskScheduler()
            .runTaskNow(taskId)
            .catch((error: Error) =>
              recordSilentFailure(
                pluginId,
                {
                  site: "scheduler.runTaskNow",
                  message: `Failed to execute task ${taskId}`,
                  expected: false,
                },
                error
              )
            )
        })
        .catch((error: Error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "scheduler.loadTaskScheduler",
              message: "Failed to load task-scheduler module",
              expected: false,
            },
            error
          )
        )

      return executionId
    },

    cancelExecution: async (executionId: string): Promise<boolean> => {
      const execution = await schedulerDb.getExecution(executionId)
      if (!execution) return false

      const task = await schedulerDb.getTask(execution.taskId)
      if (!task || (task.payload as Record<string, unknown>)?.pluginId !== pluginId) {
        return false
      }

      if (execution.status !== "running" && execution.status !== "pending") {
        return false
      }

      const updatedExecution = {
        ...execution,
        status: "cancelled" as const,
        completedAt: new Date(),
      }
      await schedulerDb.updateExecution(updatedExecution)
      return true
    },

    // Execution History
    getExecutions: async (taskId: string, limit: number = 50): Promise<PluginTaskExecution[]> => {
      const task = await schedulerDb.getTask(taskId)
      if (!task || (task.payload as Record<string, unknown>)?.pluginId !== pluginId) {
        return []
      }

      const executions = await schedulerDb.getTaskExecutions(taskId, limit)
      return executions.map((e) => mapToPluginExecution(e, pluginId))
    },

    getExecution: async (executionId: string): Promise<PluginTaskExecution | null> => {
      const execution = await schedulerDb.getExecution(executionId)
      if (!execution) return null

      const task = await schedulerDb.getTask(execution.taskId)
      if (!task || (task.payload as Record<string, unknown>)?.pluginId !== pluginId) {
        return null
      }

      return mapToPluginExecution(execution, pluginId)
    },

    getLatestExecution: async (taskId: string): Promise<PluginTaskExecution | null> => {
      const task = await schedulerDb.getTask(taskId)
      if (!task || (task.payload as Record<string, unknown>)?.pluginId !== pluginId) {
        return null
      }

      const executions = await schedulerDb.getTaskExecutions(taskId, 1)
      return executions.length > 0 ? mapToPluginExecution(executions[0], pluginId) : null
    },

    // Handler Registration
    registerHandler: (name: string, handler: PluginTaskHandler): (() => void) => {
      const fullName = `${pluginId}:${name}`
      handlers.set(name, handler)
      registerPluginTaskHandler(fullName, handler)

      return () => {
        handlers.delete(name)
        unregisterPluginTaskHandler(fullName)
      }
    },

    unregisterHandler: (name: string): void => {
      const fullName = `${pluginId}:${name}`
      handlers.delete(name)
      unregisterPluginTaskHandler(fullName)
    },

    hasHandler: (name: string): boolean => {
      const fullName = `${pluginId}:${name}`
      return handlers.has(name) || !!getPluginTaskHandler(fullName)
    },

    getHandlers: (): string[] => Array.from(handlers.keys()),
  }
}

// Helper functions for mapping scheduler types to plugin types
function mapToPluginTask(task: ScheduledTask, pluginId: string): PluginScheduledTask {
  const trigger = task.trigger
  let pluginTrigger: PluginTaskTrigger

  if (trigger.type === "cron" && trigger.cronExpression) {
    pluginTrigger = { type: "cron", expression: trigger.cronExpression, timezone: trigger.timezone }
  } else if (trigger.type === "interval" && trigger.intervalMs) {
    pluginTrigger = { type: "interval", seconds: trigger.intervalMs / 1000 }
  } else if (trigger.type === "once" && trigger.runAt) {
    pluginTrigger = { type: "once", runAt: trigger.runAt }
  } else if (trigger.type === "event" && trigger.eventType) {
    pluginTrigger = {
      type: "event",
      eventType: trigger.eventType,
      eventSource: trigger.eventSource,
    }
  } else {
    pluginTrigger = { type: "interval", seconds: 3600 } // Default fallback
  }

  const payload = task.payload as Record<string, unknown> | undefined

  return {
    id: task.id,
    pluginId,
    name: task.name,
    description: task.description,
    trigger: pluginTrigger,
    handler: (payload?.handler as string) || "",
    handlerArgs: payload?.args as Record<string, unknown> | undefined,
    metadata: payload?.metadata as Record<string, unknown> | undefined,
    status: task.status as "active" | "paused" | "disabled" | "completed" | "error",
    lastRunAt: task.lastRunAt,
    nextRunAt: task.nextRunAt,
    runCount: task.runCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    retry: task.config
      ? {
          maxAttempts: task.config.maxRetries,
          delaySeconds: task.config.retryDelay / 1000,
        }
      : undefined,
    timeout: task.config?.timeout ? task.config.timeout / 1000 : undefined,
    tags: task.tags,
  }
}

function mapToPluginExecution(
  execution: TaskExecution,
  pluginId: string = ""
): PluginTaskExecution {
  return {
    id: execution.id,
    taskId: execution.taskId,
    pluginId,
    status: execution.status as PluginTaskExecutionStatus,
    scheduledAt: execution.startedAt,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    duration: execution.duration,
    attemptNumber: execution.retryAttempt + 1,
    error: execution.error ? { message: execution.error } : undefined,
    logs: execution.logs.map((log) => ({
      timestamp: log.timestamp,
      level: log.level,
      message: log.message,
      data:
        log.data && typeof log.data === "object" && !Array.isArray(log.data)
          ? (log.data as Record<string, unknown>)
          : undefined,
    })),
  }
}

// =============================================================================
// Workflow API — plugin-contributed node executors and trigger sources.
// (ADR 0017)
// =============================================================================

/**
 * Per-plugin teardown bookkeeping. The PluginContext is recreated on
 * activate/deactivate, but we track registrations on a module-level map
 * keyed by pluginId so a manager-driven force-disable still finds the
 * right rows to clean up.
 */
const pluginWorkflowRegistrations = new Map<
  string,
  {
    nodes: Set<string> // prefixed kinds to unregister
    nodeVersions: Map<string, number> // version per kind, for unregisterNodeExecutor
    triggers: Set<string> // prefixed kinds to unregister
    triggerVersions: Map<string, number>
  }
>()

function getOrCreatePluginRegistry(pluginId: string) {
  let row = pluginWorkflowRegistrations.get(pluginId)
  if (!row) {
    row = {
      nodes: new Set(),
      nodeVersions: new Map(),
      triggers: new Set(),
      triggerVersions: new Map(),
    }
    pluginWorkflowRegistrations.set(pluginId, row)
  }
  return row
}

// Re-export under the legacy local name so the surrounding callsites stay
// readable. Single source of truth lives in `lib/plugin/bridge/kind-prefix.ts`.
const prefixKind = prefixPluginKind

export function createWorkflowAPI(pluginId: string): PluginWorkflowAPI {
  return {
    ...createWorkflowAuthorAPI(),
    registerNode(def: PluginNodeDef): () => void {
      const prefixed = prefixKind(pluginId, def.kind)
      const registry = getOrCreatePluginRegistry(pluginId)
      // Cast — the registry's `WorkflowNodeKind` is a closed union of
      // built-ins, but plugin-contributed kinds intentionally extend it
      // at runtime. Catalog merging is the only consumer that cares.
      registerNodeExecutor({
        kind: prefixed as never,
        typeVersion: def.typeVersion,
        execute: def.execute,
        retryable: def.retryable,
        timeoutMs: def.timeoutMs,
        // Tag the owner so the registry's first-wins-cross-plugin policy can
        // protect built-ins and reject a second plugin claiming the same kind.
        pluginId,
      })
      const catalogEntry: NodeCatalogEntry = {
        kind: prefixed as never,
        typeVersion: def.typeVersion,
        category: def.category,
        label: def.label,
        description: def.description,
        iconName: def.iconName,
        keywords: def.keywords ?? [],
        desktopOnly: def.desktopOnly,
        requires: def.requires,
        pluginId,
        // Surfacing the JSON Schema lets the inspector render a SchemaForm
        // instead of falling back to a raw-JSON editor.
        paramsSchema: def.paramsSchema,
        defaultParams: def.defaultParams,
      }
      addPluginCatalogEntry(catalogEntry)
      registry.nodes.add(prefixed)
      registry.nodeVersions.set(prefixed, def.typeVersion)
      return () => {
        unregisterNodeExecutor(prefixed as never, def.typeVersion)
        removePluginCatalogEntry(prefixed)
        registry.nodes.delete(prefixed)
        registry.nodeVersions.delete(prefixed)
      }
    },

    registerTrigger(def: PluginTriggerDef): () => void {
      const prefixed = prefixKind(pluginId, def.kind)
      const registry = getOrCreatePluginRegistry(pluginId)
      const reg: TriggerRegistration = {
        kind: prefixed,
        typeVersion: def.typeVersion,
        pluginId,
        def,
        instances: new Map(),
      }
      registerPluginTrigger(reg)
      // Plugin triggers also surface as a sidebar entry under the trigger
      // category so authors can drag them onto canvases.
      addPluginCatalogEntry({
        kind: prefixed as never,
        typeVersion: def.typeVersion,
        category: "trigger",
        label: def.label,
        description: def.description,
        iconName: def.iconName,
        keywords: [],
        desktopOnly: def.desktopOnly,
        pluginId,
        paramsSchema: def.paramsSchema,
        defaultParams: def.defaultParams,
      })
      registry.triggers.add(prefixed)
      registry.triggerVersions.set(prefixed, def.typeVersion)
      return () => {
        void unregisterPluginTrigger(prefixed, def.typeVersion)
        removePluginCatalogEntry(prefixed)
        registry.triggers.delete(prefixed)
        registry.triggerVersions.delete(prefixed)
      }
    },

    emitTriggerEvent(workflowId: string, kind: string, payload: unknown, triggerId?: string): void {
      // Phase 2: route into the orchestrator via `dispatchPluginTrigger`,
      // which prefixes the kind, verifies registration, and hands off to
      // `lib/workflow/runtime/trigger-bridge.dispatchTrigger`. Fire-and-
      // forget — failures land in the audit panel through
      // `recordSilentFailure`, not in the plugin's call stack.
      void dispatchPluginTrigger({
        pluginId,
        workflowId,
        kind,
        payload,
        triggerId,
      }).then((result) => {
        if (!result.ok) {
          loggers.manager.debug("plugin emitTriggerEvent rejected", {
            pluginId,
            workflowId,
            kind,
            prefixedKind: result.prefixedKind,
            reason: result.rejectedReason,
          })
        } else {
          loggers.manager.debug("plugin emitTriggerEvent dispatched", {
            pluginId,
            workflowId,
            prefixedKind: result.prefixedKind,
          })
        }
      })
    },
  }
}

/**
 * Tear down every workflow registration owned by `pluginId`. Called by the
 * plugin manager during deactivate / unload so the editor + runtime stop
 * surfacing the plugin's contributions immediately. Idempotent.
 */
export async function teardownPluginWorkflowRegistrations(pluginId: string): Promise<void> {
  const row = pluginWorkflowRegistrations.get(pluginId)
  if (!row) return
  for (const kind of row.nodes) {
    const v = row.nodeVersions.get(kind) ?? 1
    unregisterNodeExecutor(kind as never, v)
    removePluginCatalogEntry(kind)
  }
  for (const kind of row.triggers) {
    const v = row.triggerVersions.get(kind) ?? 1
    await unregisterPluginTrigger(kind, v)
    removePluginCatalogEntry(kind)
  }
  pluginWorkflowRegistrations.delete(pluginId)
}
