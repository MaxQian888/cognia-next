import * as sdk from "./scheduled-task"
import type {
  PluginScheduledTaskDef,
  PluginSchedulerAPI,
  PluginTaskContext,
  PluginTaskHandler,
  PluginTaskResult,
  PluginTaskTrigger,
  RegisteredScheduledTask,
  ScheduledTaskBridgeOptions,
  ScheduledTaskBridgeResult,
  ScheduledTaskSchedulerPort,
} from "./scheduled-task"

describe("plugin-sdk api/scheduled-task", () => {
  let consoleInfoSpy: jest.SpyInstance

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined)
  })

  afterEach(() => {
    sdk.unregisterScheduledTaskDefsByPlugin("plugin-sdk-test")
    sdk.clearPluginTaskHandlers()
    consoleInfoSpy.mockRestore()
  })

  it("exposes the scheduled-task authoring helper, bridge, definition registry, and handler registry", () => {
    expect(typeof sdk.defineScheduledTask).toBe("function")
    expect(typeof sdk.toTaskTrigger).toBe("function")
    expect(typeof sdk.registerScheduledTasksForPlugin).toBe("function")
    expect(typeof sdk.unregisterScheduledTasksForPlugin).toBe("function")
    expect(typeof sdk.registerScheduledTaskDefsForPlugin).toBe("function")
    expect(typeof sdk.unregisterScheduledTaskDefsByPlugin).toBe("function")
    expect(typeof sdk.listScheduledTaskDefs).toBe("function")
    expect(typeof sdk.subscribeScheduledTaskDefs).toBe("function")
    expect(typeof sdk.registerPluginTaskHandler).toBe("function")
    expect(typeof sdk.unregisterPluginTaskHandler).toBe("function")
    expect(typeof sdk.getPluginTaskHandler).toBe("function")
    expect(typeof sdk.hasPluginTaskHandler).toBe("function")
    expect(typeof sdk.getPluginTaskHandlerNames).toBe("function")
    expect(typeof sdk.clearPluginTaskHandlers).toBe("function")
  })

  it("defineScheduledTask is a typesafe identity function and maps triggers", () => {
    const def = sdk.defineScheduledTask({
      name: "refresh-index",
      handler: "refreshIndex",
      trigger: { type: "interval", seconds: 30 },
      defaultEnabled: false,
    })

    expect(def.name).toBe("refresh-index")
    expect(sdk.toTaskTrigger(def)).toEqual({ type: "interval", intervalMs: 30_000 })
  })

  it("exposes the in-memory scheduled-task definition and handler registries", () => {
    const def = sdk.defineScheduledTask({
      name: "refresh-index",
      handler: "refreshIndex",
      trigger: { type: "interval", seconds: 30 },
    })
    expect(sdk.registerScheduledTaskDefsForPlugin("plugin-sdk-test", [def])).toBe(1)
    expect(sdk.listScheduledTaskDefs()).toEqual([{ pluginId: "plugin-sdk-test", def }])

    const handler: PluginTaskHandler = async () => ({ success: true })
    sdk.registerPluginTaskHandler("plugin-sdk-test:refreshIndex", handler)
    expect(sdk.hasPluginTaskHandler("plugin-sdk-test:refreshIndex")).toBe(true)
    expect(sdk.getPluginTaskHandler("plugin-sdk-test:refreshIndex")).toBe(handler)
    expect(sdk.getPluginTaskHandlerNames()).toContain("plugin-sdk-test:refreshIndex")
  })

  it("re-exports scheduled-task bridge, registry, and runtime API types", () => {
    const assertTypes = <
      _T extends
        | PluginScheduledTaskDef
        | PluginTaskTrigger
        | PluginTaskHandler
        | PluginTaskContext
        | PluginTaskResult
        | PluginSchedulerAPI
        | RegisteredScheduledTask
        | ScheduledTaskSchedulerPort
        | ScheduledTaskBridgeOptions
        | ScheduledTaskBridgeResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
