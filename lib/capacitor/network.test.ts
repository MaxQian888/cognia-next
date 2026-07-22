/**
 * @jest-environment jsdom
 */
import { getStatus, subscribe, type NetworkStatus } from "./network"

describe("network.getStatus", () => {
  it("returns ok with native status when plugin available", async () => {
    const status: NetworkStatus = { connected: true, connectionType: "wifi" }
    const out = await getStatus(async () => ({
      getStatus: async () => status,
      addListener: jest.fn(),
    }))
    expect(out).toEqual({ kind: "ok", status })
  })

  it("falls back to navigator.onLine when plugin unsupported", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    const out = await getStatus(async () => {
      throw new Error("not native")
    })
    expect(out).toEqual({
      kind: "fallback",
      status: { connected: false, connectionType: "none" },
    })
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  })

  it("assumes connected when navigator exists but has no onLine (Node >= 26)", async () => {
    // Node 26 ships a global `navigator` without `onLine`. The fallback must not
    // read that as "disconnected".
    const original = Object.getOwnPropertyDescriptor(navigator, "onLine")
    Object.defineProperty(navigator, "onLine", { configurable: true, value: undefined })
    try {
      const out = await getStatus(async () => {
        throw new Error("not native")
      })
      expect(out).toEqual({
        kind: "fallback",
        status: { connected: true, connectionType: "unknown" },
      })
    } finally {
      if (original) Object.defineProperty(navigator, "onLine", original)
    }
  })

  it("returns error when plugin throws", async () => {
    const out = await getStatus(async () => ({
      getStatus: async () => {
        throw new Error("device error")
      },
      addListener: jest.fn(),
    }))
    expect(out).toEqual({ kind: "error", message: "device error" })
  })
})

describe("network.subscribe", () => {
  it("forwards plugin listener events", async () => {
    const remove = jest.fn()
    const seen: NetworkStatus[] = []
    const addListener = jest.fn(async (_event: string, handler: (s: NetworkStatus) => void) => {
      handler({ connected: false, connectionType: "none" })
      return { remove }
    })
    const unsub = await subscribe(
      (s) => seen.push(s),
      async () => ({
        getStatus: jest.fn(),
        addListener,
      })
    )
    expect(seen).toEqual([{ connected: false, connectionType: "none" }])
    unsub()
    expect(remove).toHaveBeenCalled()
  })

  it("uses window events when plugin unsupported", async () => {
    const seen: NetworkStatus[] = []
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    const unsub = await subscribe(
      (s) => seen.push(s),
      async () => {
        throw new Error("nope")
      }
    )
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    window.dispatchEvent(new Event("offline"))
    expect(seen.at(-1)).toEqual({ connected: false, connectionType: "none" })
    unsub()
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  })
})
