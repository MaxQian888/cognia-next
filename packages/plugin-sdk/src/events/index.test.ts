import * as sdk from "./index"
import type { BusEvent, EventSubscription, PluginEventAPI } from "./index"

describe("plugin-sdk: events", () => {
  it("re-exports the SystemEvents constant", () => {
    expect(sdk.SystemEvents).toEqual({
      PLUGIN_LOADED: "system:plugin:loaded",
      PLUGIN_ENABLED: "system:plugin:enabled",
      PLUGIN_DISABLED: "system:plugin:disabled",
      PLUGIN_UNLOADED: "system:plugin:unloaded",
      PLUGIN_ERROR: "system:plugin:error",
      SESSION_CREATED: "system:session:created",
      SESSION_SWITCHED: "system:session:switched",
      SESSION_DELETED: "system:session:deleted",
      AGENT_STARTED: "system:agent:started",
      AGENT_COMPLETED: "system:agent:completed",
      AGENT_ERROR: "system:agent:error",
      MESSAGE_SENT: "system:message:sent",
      MESSAGE_RECEIVED: "system:message:received",
      TOOL_CALL_STARTED: "system:tool:started",
      TOOL_CALL_COMPLETED: "system:tool:completed",
      THEME_CHANGED: "system:theme:changed",
      SETTINGS_CHANGED: "system:settings:changed",
      APP_READY: "system:app:ready",
      APP_CLOSING: "system:app:closing",
    })
  })

  it("re-exports the bus event + subscription types", () => {
    const event: BusEvent<{ message: string }> = {
      type: "test.event",
      source: { type: "plugin", id: "x" },
      payload: { message: "hi" },
      timestamp: Date.now(),
    } as BusEvent<{ message: string }>
    expect(event.type).toBe("test.event")
  })

  it("re-exports the PluginEventAPI shape", () => {
    const api: PluginEventAPI | undefined = undefined
    const sub: EventSubscription | undefined = undefined
    expect(api).toBeUndefined()
    expect(sub).toBeUndefined()
  })
})
