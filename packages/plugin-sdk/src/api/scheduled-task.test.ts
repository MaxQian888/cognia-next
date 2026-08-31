import * as sdk from "./scheduled-task"
import type {
  PluginScheduledTaskDef,
  PluginSchedulerAPI,
  PluginTaskContext,
  PluginTaskHandler,
  PluginTaskResult,
  PluginTaskTrigger,
} from "./scheduled-task"

describe("plugin-sdk api/scheduled-task", () => {
  let consoleInfoSpy: jest.SpyInstance

  beforeEach(() => {
    consoleInfoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined)
  })

  afterEach(() => consoleInfoSpy.mockRestore())

  it("exposes portable scheduled-task authoring helpers", () => {
    expect(typeof sdk.defineScheduledTask).toBe("function")
    expect(typeof sdk.toTaskTrigger).toBe("function")
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

  it("re-exports scheduled-task authoring and runtime context types", () => {
    const assertTypes = <
      _T extends
        | PluginScheduledTaskDef
        | PluginTaskTrigger
        | PluginTaskHandler
        | PluginTaskContext
        | PluginTaskResult
        | PluginSchedulerAPI,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
