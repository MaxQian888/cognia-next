import * as sdk from "./index"
import type { BusEvent, EventSubscription, PluginEventAPI } from "./index"

describe("plugin-sdk: events", () => {
  it("re-exports the SystemEvents constant", () => {
    expect(typeof sdk.SystemEvents).toBe("object")
    expect(sdk.SystemEvents).not.toBeNull()
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
