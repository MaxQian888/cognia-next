/**
 * Plugin Context - Runtime context provided to plugins
 */

import { invoke } from "@tauri-apps/api/core"
import { createPluginSystemLogger, loggers } from "./logger"
import { getPluginRateLimiter } from "@/lib/plugin/security/rate-limiter"
import type {
  Plugin,
  PluginContext,
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
  PluginStatusBarItem,
  PluginSidebarPanel,
  PluginTool,
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
} from "@/types/plugin"
import type { AgentTeamConfig } from "@/lib/ai/agent/agent-team"
import type { PluginNodeDef, PluginTriggerDef } from "@/types/plugin/plugin-workflow"
import { registerNodeExecutor, unregisterNodeExecutor } from "@/lib/workflow/nodes/registry"
import { registerMcpServerPreset } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { registerNativeAnthropicTool } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { registerSkill } from "@/lib/plugin/registries/skill-registry"
import {
  registerGuardrail,
  unregisterGuardrailById,
  listGuardrailIds,
} from "@/lib/plugin/registries/guardrail-registry"
import { registerPreset as registerExternalAgentPresetOverlay } from "@/lib/ai/agent/external/presets"
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
import { useSettingsStore } from "@/stores/settings"
import type { PluginManager } from "./manager"
import type { PluginContextAPI } from "@/types/plugin/plugin-extended"
import {
  createSessionAPI,
  createProjectAPI,
  createVectorAPI,
  createThemeAPI,
  createExportAPI,
  createI18nAPI,
  createCanvasAPI,
  createArtifactAPI,
  createNotificationCenterAPI,
  createAIProviderAPI,
  createExtensionAPI,
  createPermissionAPI,
  createMediaAPI,
  createStorageAPI,
} from "../api"
import { createMessagePartAPI } from "../api/message-part-api"
import { createDexieAPI } from "../api/dexie-api"
import { createOcrAPI, type PluginOcrAPI } from "../api/ocr-api"
import { createWorkspaceAPI, type PluginWorkspaceAPI } from "../api/workspace-api"
import { createModalAPI, type PluginModalAPI } from "../api/modal-api"
import { createChatAPI, type PluginChatAPI } from "../api/chat-api"
import { createCapabilitiesAPI, type PluginCapabilitiesAPI } from "../api/capabilities-api"
import { createGitAPI, type PluginGitAPI } from "../api/git-api"
import { createGoalAPI, type PluginGoalAPI } from "../api/goal-api"
import { createSubscriptionAPI, type PluginSubscriptionAPI } from "../api/subscription-api"
import { createTerminalAPI, type PluginTerminalAPI } from "../api/terminal-api"
import { createPerfAPI, type PluginPerfAPI } from "../api/perf-api"
import { createConnectorsAPI, type PluginConnectorsAPI } from "../api/connectors-api"
import { createShareAPI, type PluginShareAPI } from "../api/share-api"
import { createBackupAPI, type PluginBackupAPI } from "../api/backup-api"
import { createAutomationAPI, type PluginAutomationAPI } from "../api/automation-api"
import { createCompanionAPI, type PluginCompanionAPI } from "../api/companion-api"
import { getDb } from "@/lib/db/schema"
import { createIPCAPI } from "../messaging/ipc"
import { createEventAPI } from "../messaging/message-bus"
import { getPluginI18nLoader } from "../utils/i18n-loader"
import { getPluginDebugger } from "../devtools/debugger"
import { invokePluginApi, PluginGatewayError } from "./transport"
import { isTauri } from "@/lib/native/utils"
import { recordSilentFailure } from "../contracts/diagnostics-store"
import { createTrayAPI } from "@/lib/plugin/api/tray-api"
import { createQuickActionsAPI } from "@/lib/plugin/api/quick-actions-api"
import { prefixPluginKind } from "../bridge/kind-prefix"
import { dispatchPluginTrigger } from "../bridge/trigger-bridge"
import { pluginHasApiPermission } from "@/lib/plugin/api/permission-api"
import {
  runPluginAgent,
  runPluginAgentStreamed,
  dispatchSubagent,
  runTeam,
} from "@/lib/plugin/agent-sdk"
import { invokePluginTool } from "@/lib/plugin/core/invoke-plugin-tool"
import type {
  PluginAgentRun,
  PluginAgentRunOptions,
  PluginAgentRunResult,
} from "@/types/plugin/plugin-agent-sdk"

/**
 * Full plugin context combining base and extended APIs.
 * The extended storage API intentionally replaces the legacy async storage shape.
 *
 * ADR-0026 v2 namespaces (`ocr`, `workspace`) are intersected at the end so
 * the existing `PluginContextAPI` interface stays untouched — plugins gain
 * the new namespaces without breaking any structural-type consumers in the
 * SDK or sidecar that already type the existing keys.
 */
export type FullPluginContext = Omit<PluginContext, "storage"> &
  Omit<PluginContextAPI, "storage"> & {
    storage: PluginContextAPI["storage"]
  } & {
    /** OCR provider registration (ADR-0026 §2 §A). */
    ocr: PluginOcrAPI
    /** Workspace backend registration (ADR-0026 §2 §D). */
    workspace: PluginWorkspaceAPI
    /** Modal stack push/close (ADR-0026 §3 §A). */
    modal: PluginModalAPI
    /** Chat-middleware registration (ADR-0026 §4 §A). */
    chat: PluginChatAPI
    /** Read-only platform-capability flags (ADR-0026 §5 §C). */
    capabilities: PluginCapabilitiesAPI
    /** Active source-control repository read/write (gated `git:read`/`git:write`). */
    git: PluginGitAPI
    /** Self-driving goal read/drive (gated `goal:read`/`goal:write`). */
    goals: PluginGoalAPI
    /** Read-only subscription plan + usage metrics (gated `subscription:read`). */
    subscription: PluginSubscriptionAPI
    /** Integrated-terminal dock spawn/write/kill (gated `terminal:*`, ownership-checked). */
    terminal: PluginTerminalAPI
    /** Read-only performance dashboard snapshots + live samples (gated `perf:read`). */
    perf: PluginPerfAPI
    /** Connector adapter list + outbound send (gated `connectors:read`/`connectors:send`). */
    connectors: PluginConnectorsAPI
    /** Public share-link create/revoke/inspect (gated `share:read`/`share:create`). */
    share: PluginShareAPI
    /** Encrypted backup build/restore/history (gated `backup:read`/`backup:write`; never the API key). */
    backup: PluginBackupAPI
    /** Desktop automation / Computer Use action surface (gated `automation:*`, all DANGEROUS). */
    automation: PluginAutomationAPI
    /** Paired-device + remote-control + host goal-loop steering (gated `companion:*`). */
    companion: PluginCompanionAPI
  }

// =============================================================================
// Create Plugin Context
// =============================================================================

export function createPluginContext(
  plugin: Plugin,
  manager: PluginManager,
  options?: { enableDebug?: boolean }
): PluginContext {
  const pluginId = plugin.manifest.id

  const baseContext: PluginContext = {
    pluginId,
    pluginPath: plugin.path,
    config: plugin.config,
    logger: createLogger(pluginId),
    storage: createStorage(pluginId),
    events: createEventEmitter(pluginId),
    ui: createUIAPI(pluginId),
    a2ui: createA2UIAPI(pluginId, manager),
    agent: createAgentAPI(pluginId, manager),
    settings: createSettingsAPI(pluginId),
    python: plugin.manifest.type !== "frontend" ? createPythonAPI(pluginId, manager) : undefined,
    network: createNetworkAPI(pluginId),
    fs: createFileSystemAPI(pluginId),
    clipboard: createClipboardAPI(pluginId),
    shell: createShellAPI(pluginId),
    db: createDatabaseAPI(pluginId),
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
    secrets: createSecretsAPI(pluginId),
    scheduler: createSchedulerAPI(pluginId),
    workflow: createWorkflowAPI(pluginId),
    dexie: plugin.manifest.dexie
      ? createDexieAPI(getDb() as unknown as import("dexie").default, pluginId)
      : undefined,
  }

  // If debug mode is enabled, wrap the context with debug instrumentation
  if (options?.enableDebug) {
    const debugger_ = getPluginDebugger()
    debugger_.startSession(pluginId)
    return debugger_.createDebugContext(pluginId, baseContext)
  }

  return baseContext
}

/**
 * Create a full plugin context with all APIs (base + extended)
 */
export function createFullPluginContext(
  plugin: Plugin,
  manager: PluginManager,
  options?: { enableDebug?: boolean }
): FullPluginContext {
  const pluginId = plugin.manifest.id

  // Get the base context (with optional debug mode)
  const baseContext = createPluginContext(plugin, manager, options)

  const permissionsAPI = createPermissionAPI(pluginId, plugin.manifest.permissions || [])

  // Create feature APIs
  const contextAPI: PluginContextAPI = {
    session: createSessionAPI(pluginId),
    project: createProjectAPI(pluginId),
    vector: createVectorAPI(pluginId),
    theme: createThemeAPI(pluginId),
    export: createExportAPI(pluginId),
    i18n: createI18nAPI(pluginId),
    canvas: createCanvasAPI(pluginId),
    artifact: createArtifactAPI(pluginId),
    media: createMediaAPI(pluginId, manager),
    notifications: createNotificationCenterAPI(pluginId),
    storage: createStorageAPI(pluginId),
    ai: createAIProviderAPI(pluginId),
    extensions: createExtensionAPI(pluginId, {
      governanceMode: manager.getPluginPointGovernanceMode(),
      hasPermission: (permission) => permissionsAPI.hasPermission(permission as never),
    }),
    permissions: permissionsAPI,
    messagePart: createMessagePartAPI(pluginId),
  }

  // Add new communication and utility APIs to base context
  const ipcAPI = createIPCAPI(pluginId)
  const eventAPI = createEventAPI(pluginId)
  const i18nLoader = getPluginI18nLoader()
  const pluginI18n = i18nLoader.createPluginAPI(pluginId)

  // Merge IPC and events into the base context events
  const enhancedEvents = {
    ...baseContext.events,
    ipc: ipcAPI,
    bus: eventAPI,
  }

  // Enhanced i18n combining base API with loader
  const enhancedI18n = {
    ...contextAPI.i18n,
    t: pluginI18n.t,
    getLocale: pluginI18n.getLocale,
    hasKey: pluginI18n.hasKey,
    // Wrap onLocaleChange to match PluginI18nAPI signature (Locale instead of string)
    onLocaleChange: (handler: (locale: import("@/types/plugin/plugin-extended").Locale) => void) =>
      pluginI18n.onLocaleChange((locale: string) =>
        handler(locale as import("@/types/plugin/plugin-extended").Locale)
      ),
  }

  // Combine base and feature API contexts with enhanced APIs + ADR-0026
  // v2 namespaces (`ocr`, `workspace`). Both are stateless wrappers; the
  // underlying registries already auto-clean on disable through the
  // bridge layer's `clear*ForPlugin(pluginId)` hooks.
  return {
    ...baseContext,
    ...contextAPI,
    events: enhancedEvents,
    i18n: enhancedI18n,
    ocr: createOcrAPI(pluginId),
    workspace: createWorkspaceAPI(pluginId),
    modal: createModalAPI(pluginId),
    chat: createChatAPI(pluginId),
    capabilities: createCapabilitiesAPI(),
    git: createGitAPI(pluginId),
    goals: createGoalAPI(pluginId),
    subscription: createSubscriptionAPI(pluginId),
    terminal: createTerminalAPI(pluginId),
    perf: createPerfAPI(pluginId),
    connectors: createConnectorsAPI(pluginId),
    share: createShareAPI(pluginId),
    backup: createBackupAPI(pluginId),
    automation: createAutomationAPI(pluginId),
    companion: createCompanionAPI(pluginId),
  }
}

/**
 * Check if a context is a full plugin context
 */
export function isFullPluginContext(context: PluginContext): context is FullPluginContext {
  return "session" in context && "project" in context && "vector" in context
}

// =============================================================================
// Logger
// =============================================================================

function createLogger(pluginId: string): PluginLogger {
  const logger = createPluginSystemLogger(pluginId)
  return logger
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
  // Status bar items registry
  const statusBarItems = new Map<string, PluginStatusBarItem>()
  // Sidebar panels registry
  const sidebarPanels = new Map<string, PluginSidebarPanel>()

  return {
    showNotification: async (options: PluginNotification) => {
      try {
        await invoke("plugin_show_notification", {
          title: options.title,
          body: options.body ?? options.message ?? "",
          icon: options.icon,
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
      // This would integrate with a toast system
      // For now, use console
      loggers.manager.info(`[Toast:${type}] ${message}`)
    },

    showDialog: async (options: PluginDialog): Promise<unknown> => {
      // This would show a custom dialog
      // For now, return a promise that resolves with the first action
      loggers.manager.debug("Dialog:", options.title, options.content)
      return options.actions?.[0]?.value
    },

    showInputDialog: async (options: PluginInputDialog): Promise<string | null> => {
      // Use browser prompt as fallback
      const result = window.prompt(
        `${options.title}\n${options.message || ""}`,
        options.defaultValue
      )

      if (result !== null && options.validate) {
        const error = options.validate(result)
        if (error) {
          loggers.manager.error("Validation error:", error)
          return null
        }
      }

      return result
    },

    showConfirmDialog: async (options: PluginConfirmDialog): Promise<boolean> => {
      // Use browser confirm as fallback
      return window.confirm(`${options.title}\n\n${options.message}`)
    },

    registerStatusBarItem: (item: PluginStatusBarItem) => {
      statusBarItems.set(item.id, item)
      // Would emit event to update status bar UI
      return () => {
        statusBarItems.delete(item.id)
      }
    },

    registerSidebarPanel: (panel: PluginSidebarPanel) => {
      sidebarPanels.set(panel.id, panel)
      // Would emit event to update sidebar UI
      return () => {
        sidebarPanels.delete(panel.id)
      }
    },
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

function createAgentAPI(pluginId: string, manager: PluginManager): PluginAgentAPI {
  return {
    registerTool: (tool: PluginTool) => {
      manager.getRegistry().registerTool(pluginId, tool)
      usePluginStore.getState().registerPluginTool(pluginId, tool)
    },

    unregisterTool: (name: string) => {
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

    runStreamed: (prompt: string, options: PluginAgentRunOptions = {}): PluginAgentRun => {
      gateToolEnabledRun(pluginId, options.toolsEnabled)
      return runPluginAgentStreamed(prompt, options, { pluginId })
    },

    invokeTool: async (
      name: string,
      args: Record<string, unknown>,
      opts?: { signal?: AbortSignal }
    ) => {
      if (!pluginHasApiPermission(pluginId, "agent:control")) {
        throw new Error(
          'agent.invokeTool requires the "agent:control" permission — declare it in the plugin manifest.'
        )
      }
      if (typeof name !== "string" || !name) {
        throw new Error("agent.invokeTool requires a tool name")
      }
      const { result } = await invokePluginTool(pluginId, name, args ?? {}, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        reason: `plugin ${pluginId} invoked tool ${name}`,
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
    },

    registerNativeAnthropicTool: (def: PluginNativeAnthropicToolDef) => {
      registerNativeAnthropicTool(def.id, def, { pluginId })
    },

    registerSkill: (def: PluginSkillDef) => {
      registerSkill(def.id, def, { pluginId })
    },

    registerExternalAgentPreset: (def: PluginExternalAgentPresetDef) => {
      const { id, ...config } = def
      registerExternalAgentPresetOverlay(id, config, { pluginId })
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
  }
}

// =============================================================================
// Settings API
// =============================================================================

function createSettingsAPI(pluginId: string): PluginSettingsAPI {
  const settingsKey = `plugin:${pluginId}`
  const listeners = new Map<string, Set<(value: unknown) => void>>()

  return {
    get: <T>(key: string): T | undefined => {
      const state = useSettingsStore.getState()
      const pluginSettings = (state as unknown as Record<string, unknown>)[settingsKey] as
        | Record<string, unknown>
        | undefined
      return pluginSettings?.[key] as T | undefined
    },

    set: <T>(key: string, value: T) => {
      // This would integrate with settings store
      loggers.manager.debug(`Plugin ${pluginId} setting ${key}:`, value)

      // Notify listeners
      const keyListeners = listeners.get(key)
      if (keyListeners) {
        keyListeners.forEach((listener) => listener(value))
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

function createPythonAPI(pluginId: string, _manager: PluginManager): PluginPythonAPI {
  const rateLimiter = getPluginRateLimiter()
  return {
    call: async <T>(functionName: string, ...args: unknown[]): Promise<T> => {
      rateLimiter.check(pluginId, "python:call")
      return invoke<T>("plugin_python_call", {
        pluginId,
        functionName,
        args,
      })
    },

    eval: async <T>(code: string, locals?: Record<string, unknown>): Promise<T> => {
      rateLimiter.check(pluginId, "python:eval")
      return invoke<T>("plugin_python_eval", {
        pluginId,
        code,
        locals: locals || {},
      })
    },

    import: async (moduleName: string) => {
      rateLimiter.check(pluginId, "python:import")
      try {
        await invoke("plugin_python_import", {
          pluginId,
          moduleName,
        })
      } catch (error) {
        recordSilentFailure(
          pluginId,
          {
            site: "python.import",
            message: `Failed to import Python module: ${moduleName}`,
            expected: !isTauri(),
          },
          error
        )
        throw error
      }

      return {
        call: async <T>(functionName: string, ...args: unknown[]): Promise<T> => {
          return invoke<T>("plugin_python_module_call", {
            pluginId,
            moduleName,
            functionName,
            args,
          })
        },

        getattr: async <T>(name: string): Promise<T> => {
          return invoke<T>("plugin_python_module_getattr", {
            pluginId,
            moduleName,
            attrName: name,
          })
        },
      }
    },
  }
}

// =============================================================================
// Network API
// =============================================================================

function createNetworkAPI(pluginId: string): PluginNetworkAPI {
  const rateLimiter = getPluginRateLimiter()
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
    if (!isTauri()) {
      const response = await fetch(url, {
        method: options?.method,
        headers: options?.headers,
        body: options?.body as BodyInit | null | undefined,
      })
      return parseBrowserResponse<T>(response, options?.responseType)
    }

    return invokePluginApi<NetworkResponse<T>>(pluginId, "network:fetch", {
      url,
      options: options || {},
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
      _options?: DownloadOptions
    ): Promise<DownloadResult> => {
      rateLimiter.check(pluginId, "network:download")
      if (!isTauri()) {
        const response = await fetch(url)
        if (!response.ok) {
          throw new PluginGatewayError({
            code: "NOT_SUPPORTED",
            message: `Failed to download ${url}: ${response.status} ${response.statusText}`,
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

      return invokePluginApi<DownloadResult>(pluginId, "network:download", {
        url,
        destPath,
      })
    },

    upload: async (
      url: string,
      filePath: string,
      _options?: UploadOptions
    ): Promise<NetworkResponse<unknown>> => {
      rateLimiter.check(pluginId, "network:upload")
      return invokePluginApi<NetworkResponse<unknown>>(pluginId, "network:upload", {
        url,
        filePath,
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
      if (!isTauri()) return notSupported("fs:readText")
      return invokePluginApi<string>(pluginId, "fs:readText", { path })
    },

    readBinary: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isTauri()) return notSupported("fs:readBinary")
      return invokePluginApi<number[]>(pluginId, "fs:readBinary", { path }).then((bytes) =>
        Uint8Array.from(bytes)
      )
    },

    readJson: async <T>(path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isTauri()) return notSupported("fs:readText")
      const raw = await invokePluginApi<string>(pluginId, "fs:readText", { path })
      return JSON.parse(raw) as T
    },

    writeText: (path: string, content: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isTauri()) return notSupported("fs:writeText")
      return invokePluginApi<void>(pluginId, "fs:writeText", { path, content })
    },

    writeBinary: (path: string, content: Uint8Array) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isTauri()) return notSupported("fs:writeBinary")
      return invokePluginApi<void>(pluginId, "fs:writeBinary", {
        path,
        content: Array.from(content),
      })
    },

    writeJson: async (path: string, data: unknown, pretty = true) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isTauri()) return notSupported("fs:writeText")
      const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
      await invokePluginApi<void>(pluginId, "fs:writeText", { path, content })
    },

    appendText: async (path: string, content: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isTauri()) return notSupported("fs:writeText")
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
      if (!isTauri()) return notSupported("fs:exists")
      return invokePluginApi<boolean>(pluginId, "fs:exists", { path })
    },

    mkdir: (path: string, recursive = true) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isTauri()) return notSupported("fs:mkdir")
      return invokePluginApi<void>(pluginId, "fs:mkdir", { path, recursive })
    },

    remove: (path: string, recursive = false) => {
      rateLimiter.check(pluginId, "fs:delete")
      if (!isTauri()) return notSupported("fs:remove")
      return invokePluginApi<void>(pluginId, "fs:remove", { path, recursive })
    },

    copy: (src: string, dest: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isTauri()) return notSupported("fs:copy")
      return invokePluginApi<void>(pluginId, "fs:copy", { src, dest })
    },

    move: (src: string, dest: string) => {
      rateLimiter.check(pluginId, "fs:write")
      if (!isTauri()) return notSupported("fs:move")
      return invokePluginApi<void>(pluginId, "fs:move", { src, dest })
    },

    readDir: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isTauri()) return notSupported("fs:readDir")
      return invokePluginApi<FileEntry[]>(pluginId, "fs:readDir", { path })
    },

    stat: (path: string) => {
      rateLimiter.check(pluginId, "fs:read")
      if (!isTauri()) return notSupported("fs:stat")
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

    spawn: (command: string, args?: string[], options?: SpawnOptions): ChildProcess => {
      rateLimiter.check(pluginId, "process:spawn")
      const processId = `${pluginId}:${Date.now()}`

      let pid = 0
      void invokePluginApi<{ pid?: number }>(pluginId, "shell:spawn", {
        processId,
        command,
        args,
        options,
      })
        .then((result) => {
          pid = result.pid || 0
        })
        .catch((error) =>
          recordSilentFailure(
            pluginId,
            {
              site: "shell.spawn",
              message: `Failed to spawn process: ${command}`,
              expected: false,
            },
            error
          )
        )

      return {
        pid,
        stdin: new WritableStream(),
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        kill: (signal?: string) => {
          invoke("plugin_process_kill", { processId, signal }).catch((error) =>
            recordSilentFailure(
              pluginId,
              {
                site: "process.kill",
                message: `Failed to kill process ${processId}`,
                expected: false,
              },
              error
            )
          )
        },
        onExit: (callback: (code: number) => void) => {
          window.addEventListener(`plugin-process-exit:${processId}`, ((e: CustomEvent) => {
            callback(e.detail.code)
          }) as EventListener)
        },
      }
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
    isMaximized: () => false, // Would need async check
    setSize: (width: number, height: number) =>
      invokePluginApi<void>(pluginId, "window:setSize", { windowId: id, width, height }),
    getSize: () => ({ width: 800, height: 600 }), // Would need async check
    setPosition: (x: number, y: number) =>
      invokePluginApi<void>(pluginId, "window:setPosition", { windowId: id, x, y }),
    getPosition: () => ({ x: 0, y: 0 }), // Would need async check
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
// Secrets API
// =============================================================================

function createSecretsAPI(pluginId: string): PluginSecretsAPI {
  return {
    store: (key: string, value: string) =>
      invokePluginApi<void>(pluginId, "secrets:store", { key, value }),

    get: (key: string) => invokePluginApi<string | null>(pluginId, "secrets:get", { key }),

    delete: (key: string) => invokePluginApi<void>(pluginId, "secrets:delete", { key }),

    has: (key: string) => invokePluginApi<boolean>(pluginId, "secrets:has", { key }),
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

function createSchedulerAPI(pluginId: string): PluginSchedulerAPI {
  // Local handler registry for this plugin
  const handlers = new Map<string, PluginTaskHandler>()

  return {
    // Task Management
    createTask: async (input: CreatePluginTaskInput): Promise<PluginScheduledTask> => {
      const taskId = nanoid()
      const now = new Date()

      const task: ScheduledTask = {
        id: taskId,
        name: input.name,
        description: input.description,
        type: "plugin",
        trigger: {
          type: input.trigger.type,
          cronExpression: input.trigger.type === "cron" ? input.trigger.expression : undefined,
          intervalMs: input.trigger.type === "interval" ? input.trigger.seconds * 1000 : undefined,
          runAt: input.trigger.type === "once" ? new Date(input.trigger.runAt) : undefined,
          eventType: input.trigger.type === "event" ? input.trigger.eventType : undefined,
          eventSource: input.trigger.type === "event" ? input.trigger.eventSource : undefined,
          timezone: input.trigger.type === "cron" ? input.trigger.timezone : undefined,
        },
        payload: {
          pluginId,
          handler: input.handler,
          args: input.handlerArgs || {},
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
        status: input.enabled !== false ? "active" : "paused",
        tags: input.tags,
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      }

      await schedulerDb.createTask(task)
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

      const updatedTask: ScheduledTask = { ...existingTask, updatedAt: new Date() }

      if (input.name !== undefined) updatedTask.name = input.name
      if (input.description !== undefined) updatedTask.description = input.description
      if (input.trigger !== undefined) {
        updatedTask.trigger = {
          type: input.trigger.type,
          cronExpression: input.trigger.type === "cron" ? input.trigger.expression : undefined,
          intervalMs: input.trigger.type === "interval" ? input.trigger.seconds * 1000 : undefined,
          runAt: input.trigger.type === "once" ? new Date(input.trigger.runAt) : undefined,
          eventType: input.trigger.type === "event" ? input.trigger.eventType : undefined,
          eventSource: input.trigger.type === "event" ? input.trigger.eventSource : undefined,
          timezone: input.trigger.type === "cron" ? input.trigger.timezone : undefined,
        }
      }
      if (input.handler !== undefined) {
        updatedTask.payload = {
          ...(existingTask.payload as Record<string, unknown>),
          handler: input.handler,
        }
      }
      if (input.handlerArgs !== undefined) {
        updatedTask.payload = {
          ...(existingTask.payload as Record<string, unknown>),
          args: input.handlerArgs,
        }
      }
      if (input.tags !== undefined) updatedTask.tags = input.tags

      await schedulerDb.updateTask(updatedTask)
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
      return schedulerDb.deleteTask(taskId)
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
      const updatedTask = { ...existingTask, status: "paused" as const, updatedAt: new Date() }
      await schedulerDb.updateTask(updatedTask)
      return true
    },

    resumeTask: async (taskId: string): Promise<boolean> => {
      const existingTask = await schedulerDb.getTask(taskId)
      if (
        !existingTask ||
        (existingTask.payload as Record<string, unknown>)?.pluginId !== pluginId
      ) {
        return false
      }
      const updatedTask = { ...existingTask, status: "active" as const, updatedAt: new Date() }
      await schedulerDb.updateTask(updatedTask)
      return true
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

function createWorkflowAPI(pluginId: string): PluginWorkflowAPI {
  return {
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
        category: def.category,
        label: def.label,
        description: def.description,
        iconName: def.iconName,
        keywords: def.keywords ?? [],
        desktopOnly: def.desktopOnly,
        pluginId,
        // Surfacing the JSON Schema lets the inspector render a SchemaForm
        // instead of falling back to a raw-JSON editor.
        paramsSchema: def.paramsSchema,
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
        category: "trigger",
        label: def.label,
        description: def.description,
        iconName: def.iconName,
        keywords: [],
        desktopOnly: def.desktopOnly,
        pluginId,
        paramsSchema: def.paramsSchema,
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

    emitTriggerEvent(workflowId: string, kind: string, payload: unknown): void {
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
