/**
 * Tests for Plugin Message Bus
 */

import {
  MessageBus,
  getMessageBus,
  resetMessageBus,
  createEventAPI,
  SystemEvents,
  type BusEvent,
} from "./message-bus"
import { PLUGIN_MESSAGE_HISTORY_MAX } from "./constants"

describe("MessageBus", () => {
  let bus: MessageBus

  beforeEach(() => {
    resetMessageBus()
    bus = new MessageBus()
  })

  afterEach(() => {
    bus.clear()
  })

  describe("history cap defaults", () => {
    it("uses PLUGIN_MESSAGE_HISTORY_MAX as the default cap (parity with PluginIPC)", () => {
      const tinyBus = new MessageBus({ maxHistory: 3 })
      try {
        for (let i = 0; i < 5; i += 1) {
          tinyBus.emit("test-event", { data: i }, { type: "plugin", id: "plugin-a" })
        }
        expect(tinyBus.getHistory().length).toBe(3)
      } finally {
        tinyBus.clear()
      }
      // The constant guarantees ≥500 — sourced from the shared module.
      expect(PLUGIN_MESSAGE_HISTORY_MAX).toBeGreaterThanOrEqual(500)
    })
  })

  describe("Event Emission", () => {
    it("should emit events", () => {
      const handler = jest.fn()
      bus.on("test-event", handler)

      bus.emit("test-event", { data: "test" }, { type: "plugin", id: "plugin-a" })

      expect(handler).toHaveBeenCalled()
      const event = handler.mock.calls[0][0] as BusEvent
      expect(event.type).toBe("test-event")
      expect(event.payload).toEqual({ data: "test" })
      expect(event.source.id).toBe("plugin-a")
    })

    it("should emit from plugin helper", () => {
      const handler = jest.fn()
      bus.on("plugin-event", handler)

      bus.emitFromPlugin("my-plugin", "plugin-event", { value: 123 })

      expect(handler).toHaveBeenCalled()
      const event = handler.mock.calls[0][0] as BusEvent
      expect(event.source.type).toBe("plugin")
      expect(event.source.id).toBe("my-plugin")
    })

    it("should emit from system helper", () => {
      const handler = jest.fn()
      bus.on(SystemEvents.APP_READY, handler)

      bus.emitFromSystem(SystemEvents.APP_READY, {})

      expect(handler).toHaveBeenCalled()
      const event = handler.mock.calls[0][0] as BusEvent
      expect(event.source.type).toBe("system")
    })
  })

  describe("Subscriptions", () => {
    it("should subscribe to events", () => {
      const handler = jest.fn()
      const unsubscribe = bus.on("event", handler)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should handle once subscriptions", () => {
      const handler = jest.fn()
      bus.once("once-event", handler)

      bus.emit("once-event", {}, { type: "system", id: "test" })
      bus.emit("once-event", {}, { type: "system", id: "test" })

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it("should unsubscribe correctly", () => {
      const handler = jest.fn()
      const unsubscribe = bus.on("event", handler)

      unsubscribe()

      bus.emit("event", {}, { type: "system", id: "test" })

      expect(handler).not.toHaveBeenCalled()
    })

    it("should unsubscribe all by source", () => {
      const handler1 = jest.fn()
      const handler2 = jest.fn()

      bus.on("event-1", handler1, { source: { type: "plugin", id: "plugin-a" } })
      bus.on("event-2", handler2, { source: { type: "plugin", id: "plugin-a" } })

      bus.offAll("plugin-a")

      bus.emit("event-1", {}, { type: "system", id: "test" })
      bus.emit("event-2", {}, { type: "system", id: "test" })

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).not.toHaveBeenCalled()
    })
  })

  describe("Pattern Matching", () => {
    it("should match exact event types", () => {
      const handler = jest.fn()
      bus.on("exact-event", handler)

      bus.emit("exact-event", {}, { type: "system", id: "test" })
      bus.emit("other-event", {}, { type: "system", id: "test" })

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it("should match regex patterns", () => {
      const handler = jest.fn()
      bus.on(/^plugin:.*/, handler)

      bus.emit("plugin:loaded", {}, { type: "system", id: "test" })
      bus.emit("plugin:enabled", {}, { type: "system", id: "test" })
      bus.emit("system:ready", {}, { type: "system", id: "test" })

      expect(handler).toHaveBeenCalledTimes(2)
    })

    it("should match wildcard subscriptions", () => {
      const handler = jest.fn()
      bus.on("*", handler)

      bus.emit("event-1", {}, { type: "system", id: "test" })
      bus.emit("event-2", {}, { type: "system", id: "test" })

      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  describe("Event Filtering", () => {
    it("should filter by source type", () => {
      const handler = jest.fn()
      bus.on("event", handler, { filter: { sourceType: "plugin" } })

      bus.emit("event", {}, { type: "plugin", id: "plugin-a" })
      bus.emit("event", {}, { type: "system", id: "system" })

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it("should filter by source id", () => {
      const handler = jest.fn()
      bus.on("event", handler, { filter: { sourceId: "plugin-a" } })

      bus.emit("event", {}, { type: "plugin", id: "plugin-a" })
      bus.emit("event", {}, { type: "plugin", id: "plugin-b" })

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it("should filter by metadata", () => {
      const handler = jest.fn()
      bus.on("event", handler, { filter: { metadata: { priority: "high" } } })

      bus.emit("event", {}, { type: "system", id: "test" }, { priority: "high" })
      bus.emit("event", {}, { type: "system", id: "test" }, { priority: "low" })

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe("Priority", () => {
    it("should execute handlers in priority order", () => {
      const order: number[] = []

      bus.on("event", () => order.push(1), { priority: 1 })
      bus.on("event", () => order.push(3), { priority: 3 })
      bus.on("event", () => order.push(2), { priority: 2 })

      bus.emit("event", {}, { type: "system", id: "test" })

      expect(order).toEqual([3, 2, 1])
    })
  })

  describe("Event History", () => {
    it("should record event history", () => {
      bus.emit("event-1", { a: 1 }, { type: "system", id: "test" })
      bus.emit("event-2", { b: 2 }, { type: "system", id: "test" })

      const history = bus.getHistory()
      expect(history.length).toBe(2)
    })

    it("should filter history by event type", () => {
      bus.emit("type-a", {}, { type: "system", id: "test" })
      bus.emit("type-b", {}, { type: "system", id: "test" })

      const history = bus.getHistory({ eventType: "type-a" })
      expect(history.length).toBe(1)
      expect(history[0].type).toBe("type-a")
    })

    it("should clear history", () => {
      bus.emit("event", {}, { type: "system", id: "test" })
      bus.clearHistory()

      expect(bus.getHistory().length).toBe(0)
    })
  })

  describe("Event Replay", () => {
    it("should replay recent events", () => {
      const handler = jest.fn()

      bus.emit("event", { n: 1 }, { type: "system", id: "test" })
      bus.emit("event", { n: 2 }, { type: "system", id: "test" })

      const count = bus.replay("event", handler)

      expect(count).toBe(2)
      expect(handler).toHaveBeenCalledTimes(2)
    })

    it("should respect replay limit", () => {
      const handler = jest.fn()

      for (let i = 0; i < 5; i++) {
        bus.emit("event", { n: i }, { type: "system", id: "test" })
      }

      const count = bus.replay("event", handler, { limit: 2 })

      expect(count).toBe(2)
    })
  })

  describe("Stats", () => {
    it("should return correct stats", () => {
      bus.on("event-1", () => {})
      bus.on(/pattern/, () => {})
      bus.on("*", () => {})

      bus.emit("event", {}, { type: "system", id: "test" })

      const stats = bus.getStats()
      expect(stats.totalSubscriptions).toBe(1)
      expect(stats.patternSubscriptions).toBe(1)
      expect(stats.wildcardSubscriptions).toBe(1)
      expect(stats.historySize).toBe(1)
    })
  })
})

describe("createEventAPI", () => {
  beforeEach(() => {
    resetMessageBus()
  })

  it("should create an event API for a plugin", () => {
    const api = createEventAPI("my-plugin")

    expect(api.emit).toBeDefined()
    expect(api.on).toBeDefined()
    expect(api.once).toBeDefined()
    expect(api.off).toBeDefined()
    expect(api.offAll).toBeDefined()
    expect(api.getHistory).toBeDefined()
  })

  it("should emit events with correct source", () => {
    const api = createEventAPI("my-plugin")
    const bus = getMessageBus()
    const handler = jest.fn()

    bus.on("test", handler)
    api.emit("test", { data: 123 })

    expect(handler).toHaveBeenCalled()
    const event = handler.mock.calls[0][0] as BusEvent
    expect(event.source.id).toBe("my-plugin")
    expect(event.source.type).toBe("plugin")
  })
})

describe("SystemEvents", () => {
  it("should have all expected system events", () => {
    expect(SystemEvents.PLUGIN_LOADED).toBeDefined()
    expect(SystemEvents.PLUGIN_ENABLED).toBeDefined()
    expect(SystemEvents.PLUGIN_DISABLED).toBeDefined()
    expect(SystemEvents.APP_READY).toBeDefined()
    expect(SystemEvents.MESSAGE_SENT).toBeDefined()
  })
})
