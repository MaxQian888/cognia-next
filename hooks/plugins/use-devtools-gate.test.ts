/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { DEVTOOLS_GATE_STORAGE_KEY, useDevtoolsGate } from "./use-devtools-gate"

describe("useDevtoolsGate", () => {
  beforeEach(() => {
    window.localStorage.removeItem(DEVTOOLS_GATE_STORAGE_KEY)
    jest.replaceProperty(process.env, "NODE_ENV", "production")
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("starts disabled when neither dev build nor storage flag", () => {
    const { result } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(false)
  })

  it("enables when localStorage flag is set to 'true'", () => {
    window.localStorage.setItem(DEVTOOLS_GATE_STORAGE_KEY, "true")
    const { result } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(true)
  })

  it("ignores non-'true' storage values", () => {
    window.localStorage.setItem(DEVTOOLS_GATE_STORAGE_KEY, "yes")
    const { result } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(false)
  })

  it("enables in development builds even without storage flag", () => {
    jest.replaceProperty(process.env, "NODE_ENV", "development")
    const { result } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(true)
  })

  it("re-evaluates on a storage event", () => {
    const { result } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(false)
    act(() => {
      window.localStorage.setItem(DEVTOOLS_GATE_STORAGE_KEY, "true")
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: DEVTOOLS_GATE_STORAGE_KEY,
          newValue: "true",
        })
      )
    })
    expect(result.current).toBe(true)
  })

  it("re-evaluates when the entire storage is cleared (event.key === null)", () => {
    window.localStorage.setItem(DEVTOOLS_GATE_STORAGE_KEY, "true")
    const { result } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(true)
    act(() => {
      window.localStorage.clear()
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(result.current).toBe(false)
  })

  it("returns false when localStorage throws (privacy mode / sandbox)", () => {
    const original = window.localStorage.getItem
    Object.defineProperty(window.localStorage, "getItem", {
      configurable: true,
      value: () => {
        throw new Error("storage disabled")
      },
    })
    const { result } = renderHook(() => useDevtoolsGate())
    expect(result.current).toBe(false)
    Object.defineProperty(window.localStorage, "getItem", {
      configurable: true,
      value: original,
    })
  })
})
