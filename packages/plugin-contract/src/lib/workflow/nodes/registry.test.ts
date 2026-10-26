/**
 * Tests for the node executor registry — focuses on the new
 * subscribe / unregister surface added to support plugin contributions.
 */

import {
  registerNodeExecutor,
  unregisterNodeExecutor,
  subscribeNodeRegistry,
  getExecutor,
  listRegisteredKinds,
  __resetRegistryForTesting,
  type NodeRegistryEvent,
  type NodeExecuteFn,
} from "./registry"

const noop: NodeExecuteFn = async () => ({ output: undefined })

describe("registerNodeExecutor", () => {
  beforeEach(() => {
    __resetRegistryForTesting()
  })

  it("stores and retrieves an executor by (kind, version)", () => {
    registerNodeExecutor({
      kind: "trigger.manual",
      typeVersion: 1,
      execute: noop,
    })
    const found = getExecutor("trigger.manual", 1)
    expect(found?.execute).toBe(noop)
  })

  it("treats different versions of the same kind as separate executors", () => {
    registerNodeExecutor({ kind: "trigger.manual", typeVersion: 1, execute: noop })
    registerNodeExecutor({ kind: "trigger.manual", typeVersion: 2, execute: noop })
    expect(getExecutor("trigger.manual", 1)).toBeDefined()
    expect(getExecutor("trigger.manual", 2)).toBeDefined()
    expect(listRegisteredKinds()).toEqual(["trigger.manual"])
  })

  it("returns undefined for unregistered kinds", () => {
    expect(getExecutor("trigger.manual", 1)).toBeUndefined()
  })
})

describe("unregisterNodeExecutor", () => {
  beforeEach(() => {
    __resetRegistryForTesting()
  })

  it("removes a registered executor", () => {
    registerNodeExecutor({ kind: "action.character.send", typeVersion: 1, execute: noop })
    unregisterNodeExecutor("action.character.send", 1)
    expect(getExecutor("action.character.send", 1)).toBeUndefined()
  })

  it("is idempotent for unregistered (kind, version)", () => {
    expect(() => unregisterNodeExecutor("trigger.manual", 99)).not.toThrow()
  })

  it("does not affect other versions of the same kind", () => {
    registerNodeExecutor({ kind: "trigger.manual", typeVersion: 1, execute: noop })
    registerNodeExecutor({ kind: "trigger.manual", typeVersion: 2, execute: noop })
    unregisterNodeExecutor("trigger.manual", 1)
    expect(getExecutor("trigger.manual", 1)).toBeUndefined()
    expect(getExecutor("trigger.manual", 2)).toBeDefined()
  })
})

describe("subscribeNodeRegistry", () => {
  beforeEach(() => {
    __resetRegistryForTesting()
  })

  it("notifies listeners on register, asynchronously", async () => {
    const listener = jest.fn() as jest.Mock<void, [NodeRegistryEvent]>
    subscribeNodeRegistry(listener)
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: noop })
    // Microtask deferral: not yet called synchronously.
    expect(listener).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledWith({
      type: "register",
      kind: "ai.prompt",
      typeVersion: 1,
    })
  })

  it("notifies listeners on unregister", async () => {
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: noop })
    await Promise.resolve()
    const listener = jest.fn() as jest.Mock<void, [NodeRegistryEvent]>
    subscribeNodeRegistry(listener)
    unregisterNodeExecutor("ai.prompt", 1)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledWith({
      type: "unregister",
      kind: "ai.prompt",
      typeVersion: 1,
    })
  })

  it("returns an unsubscribe function that stops further notifications", async () => {
    const listener = jest.fn() as jest.Mock<void, [NodeRegistryEvent]>
    const unsubscribe = subscribeNodeRegistry(listener)
    unsubscribe()
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: noop })
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })

  it("isolates listener errors so one bad listener doesn't block the others", async () => {
    const errSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    const bad = jest.fn(() => {
      throw new Error("boom")
    })
    const good = jest.fn() as jest.Mock<void, [NodeRegistryEvent]>
    subscribeNodeRegistry(bad)
    subscribeNodeRegistry(good)
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: noop })
    await Promise.resolve()
    expect(bad).toHaveBeenCalled()
    expect(good).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("does not fire on unregister-noop (kind never registered)", async () => {
    const listener = jest.fn() as jest.Mock<void, [NodeRegistryEvent]>
    subscribeNodeRegistry(listener)
    unregisterNodeExecutor("ai.prompt", 1)
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe("owner / conflict policy", () => {
  const a: NodeExecuteFn = async () => ({ output: "a" })
  const b: NodeExecuteFn = async () => ({ output: "b" })

  beforeEach(() => {
    __resetRegistryForTesting()
  })

  it("protects a built-in (no pluginId) from being overwritten by a plugin", () => {
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: a })
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: b, pluginId: "p1" })
    // The host built-in (registered first, sentinel owner) wins.
    expect(getExecutor("ai.prompt", 1)?.execute).toBe(a)
  })

  it("keeps the incumbent when a different plugin claims the same kind@version", () => {
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: a, pluginId: "p1" })
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: b, pluginId: "p2" })
    expect(getExecutor("ai.prompt", 1)?.execute).toBe(a)
  })

  it("lets a plugin refresh its OWN registration (same owner)", () => {
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: a, pluginId: "p1" })
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: b, pluginId: "p1" })
    expect(getExecutor("ai.prompt", 1)?.execute).toBe(b)
  })

  it("does not emit a register event for a rejected cross-plugin collision", async () => {
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: a, pluginId: "p1" })
    await Promise.resolve()
    const listener = jest.fn() as jest.Mock<void, [NodeRegistryEvent]>
    subscribeNodeRegistry(listener)
    registerNodeExecutor({ kind: "ai.prompt", typeVersion: 1, execute: b, pluginId: "p2" })
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })
})
