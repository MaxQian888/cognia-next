import * as sdk from "./workflow-trigger"
import type {
  PluginTriggerDef,
  PluginTriggerHandle,
  PluginTriggerLogger,
  PluginTriggerStartContext,
  TriggerInstanceHandle,
  TriggerRegistration,
  TriggerRegistryEvent,
  TriggerRegistryListener,
} from "./workflow-trigger"

describe("plugin-sdk api/workflow-trigger", () => {
  it("exposes the authoring helper, trigger registry, lifecycle, and mute helpers", () => {
    expect(typeof sdk.defineWorkflowTrigger).toBe("function")
    expect(typeof sdk.registerPluginTrigger).toBe("function")
    expect(typeof sdk.unregisterPluginTrigger).toBe("function")
    expect(typeof sdk.getPluginTrigger).toBe("function")
    expect(typeof sdk.listPluginTriggers).toBe("function")
    expect(typeof sdk.startPluginTriggerInstance).toBe("function")
    expect(typeof sdk.subscribePluginTriggerRegistry).toBe("function")
    expect(typeof sdk.setTriggerMuted).toBe("function")
    expect(typeof sdk.isTriggerMuted).toBe("function")
    expect(typeof sdk.subscribeTriggerMuteChanges).toBe("function")
  })

  it("re-exports workflow trigger definition, registry, and lifecycle types", () => {
    const assertTypes = <
      _T extends
        | PluginTriggerDef
        | PluginTriggerHandle
        | PluginTriggerStartContext
        | PluginTriggerLogger
        | TriggerRegistration
        | TriggerInstanceHandle
        | TriggerRegistryEvent
        | TriggerRegistryListener,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
