/** @jest-environment jsdom */

import { isLikelyMeteredConnection, isOnline, readNetworkInformation } from "./network-cost"

describe("isLikelyMeteredConnection", () => {
  it("allows the fetch when the platform says nothing", () => {
    // The permissive direction is deliberate. Refusing on an absent API would
    // make `wifiOnly` mean "never fetch on a Mac", where the API never exists.
    expect(isLikelyMeteredConnection(null)).toBe(false)
    expect(isLikelyMeteredConnection({})).toBe(false)
  })

  it("holds when the user asked for reduced data use", () => {
    expect(isLikelyMeteredConnection({ saveData: true })).toBe(true)
  })

  it("holds on a cellular connection", () => {
    expect(isLikelyMeteredConnection({ type: "cellular" })).toBe(true)
    expect(isLikelyMeteredConnection({ type: "CELLULAR" })).toBe(true)
  })

  it("holds on a connection too slow for several megabytes", () => {
    expect(isLikelyMeteredConnection({ effectiveType: "slow-2g" })).toBe(true)
    expect(isLikelyMeteredConnection({ effectiveType: "2g" })).toBe(true)
  })

  it("allows wifi and ethernet", () => {
    expect(isLikelyMeteredConnection({ type: "wifi", effectiveType: "4g" })).toBe(false)
    expect(isLikelyMeteredConnection({ type: "ethernet" })).toBe(false)
  })

  it("allows a fast connection of unknown type", () => {
    expect(isLikelyMeteredConnection({ effectiveType: "4g" })).toBe(false)
    expect(isLikelyMeteredConnection({ effectiveType: "3g" })).toBe(false)
  })

  it("lets saveData override an otherwise fine connection", () => {
    expect(isLikelyMeteredConnection({ saveData: true, type: "wifi", effectiveType: "4g" })).toBe(
      true
    )
  })
})

describe("readNetworkInformation", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "connection")

  afterEach(() => {
    if (original) Object.defineProperty(navigator, "connection", original)
    else delete (navigator as { connection?: unknown }).connection
  })

  it("returns null where the API is absent", () => {
    delete (navigator as { connection?: unknown }).connection
    expect(readNetworkInformation()).toBeNull()
  })

  it("reads the standard property", () => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: { effectiveType: "4g" },
    })
    expect(readNetworkInformation()).toEqual({ effectiveType: "4g" })
  })
})

describe("isOnline", () => {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")

  afterEach(() => {
    if (original) Object.defineProperty(Navigator.prototype, "onLine", original)
  })

  it("reports online by default", () => {
    expect(isOnline()).toBe(true)
  })

  it("reports offline when the shell says so", () => {
    Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, value: false })
    expect(isOnline()).toBe(false)
  })
})
