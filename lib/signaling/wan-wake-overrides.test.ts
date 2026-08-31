/**
 * The manual-wake override set. Its contract is small but load-bearing: the
 * device console writes it, the desktop controller re-pushes the hub's device
 * list from it, and `useSyncExternalStore` reads it, so a snapshot whose
 * identity churned would loop the console.
 */

import {
  getWanWakeOverrides,
  getWanWakeOverridesServerSnapshot,
  isWanWakeRequested,
  resetWanWakeOverridesForTests,
  sleepDeviceForWan,
  subscribeWanWakeOverrides,
  wakeDeviceForWan,
} from "./wan-wake-overrides"

afterEach(() => {
  resetWanWakeOverridesForTests()
})

describe("wan wake overrides", () => {
  it("starts empty", () => {
    expect(getWanWakeOverrides().size).toBe(0)
    expect(isWanWakeRequested("d1")).toBe(false)
  })

  it("records a wake and notifies subscribers", () => {
    const listener = jest.fn()
    subscribeWanWakeOverrides(listener)
    wakeDeviceForWan("d1")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isWanWakeRequested("d1")).toBe(true)
    expect([...getWanWakeOverrides()]).toEqual(["d1"])
  })

  it("is idempotent, so a double-click cannot churn the hub", () => {
    const listener = jest.fn()
    subscribeWanWakeOverrides(listener)
    wakeDeviceForWan("d1")
    const first = getWanWakeOverrides()
    wakeDeviceForWan("d1")
    expect(listener).toHaveBeenCalledTimes(1)
    // Same identity, so a `useSyncExternalStore` consumer does not re-render.
    expect(getWanWakeOverrides()).toBe(first)
  })

  it("ignores an empty device id", () => {
    const listener = jest.fn()
    subscribeWanWakeOverrides(listener)
    wakeDeviceForWan("")
    expect(listener).not.toHaveBeenCalled()
    expect(getWanWakeOverrides().size).toBe(0)
  })

  it("publishes a new set identity on every real change", () => {
    const before = getWanWakeOverrides()
    wakeDeviceForWan("d1")
    const after = getWanWakeOverrides()
    expect(after).not.toBe(before)
    // The previous snapshot is not mutated, which is what makes a captured
    // render-time snapshot safe to compare against.
    expect(before.has("d1")).toBe(false)
  })

  it("drops an override again and notifies", () => {
    const listener = jest.fn()
    wakeDeviceForWan("d1")
    subscribeWanWakeOverrides(listener)
    sleepDeviceForWan("d1")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isWanWakeRequested("d1")).toBe(false)
  })

  it("does not notify when sleeping a device that was never woken", () => {
    const listener = jest.fn()
    subscribeWanWakeOverrides(listener)
    sleepDeviceForWan("d1")
    expect(listener).not.toHaveBeenCalled()
  })

  it("keeps several devices independently", () => {
    wakeDeviceForWan("d1")
    wakeDeviceForWan("d2")
    sleepDeviceForWan("d1")
    expect([...getWanWakeOverrides()]).toEqual(["d2"])
  })

  it("unsubscribes cleanly", () => {
    const listener = jest.fn()
    const stop = subscribeWanWakeOverrides(listener)
    stop()
    wakeDeviceForWan("d1")
    expect(listener).not.toHaveBeenCalled()
  })

  it("survives a listener that unsubscribes while being notified", () => {
    // The console unmounts on the same click that wakes a device often enough
    // that iterating the live set would skip the next listener.
    const second = jest.fn()
    const stop = subscribeWanWakeOverrides(() => stop())
    subscribeWanWakeOverrides(second)
    expect(() => wakeDeviceForWan("d1")).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("always reports an empty server snapshot so a prerender cannot hydrate a wake", () => {
    wakeDeviceForWan("d1")
    expect(getWanWakeOverridesServerSnapshot().size).toBe(0)
  })
})
