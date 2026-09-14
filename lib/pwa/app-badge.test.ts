/** @jest-environment jsdom */

import { applyAppBadge, isAppBadgeSupported } from "./app-badge"
import { __resetPwaInstallStateForTests } from "./install-state"

const setAppBadge = jest.fn().mockResolvedValue(undefined)
const clearAppBadge = jest.fn().mockResolvedValue(undefined)

function stubBadgeApis(present: boolean) {
  const nav = window.navigator as unknown as {
    setAppBadge?: unknown
    clearAppBadge?: unknown
  }
  if (present) {
    nav.setAppBadge = setAppBadge
    nav.clearAppBadge = clearAppBadge
  } else {
    delete nav.setAppBadge
    delete nav.clearAppBadge
  }
}

function stubStandalone(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: jest.fn((query: string) => ({
      matches: query === "(display-mode: standalone)" ? matches : false,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
      onchange: null,
    })),
  })
}

beforeEach(() => {
  __resetPwaInstallStateForTests()
  setAppBadge.mockClear()
  clearAppBadge.mockClear()
  stubBadgeApis(true)
  stubStandalone(true)
})

describe("isAppBadgeSupported", () => {
  it("is true when navigator.setAppBadge exists", () => {
    expect(isAppBadgeSupported()).toBe(true)
  })

  it("is false without the API", () => {
    stubBadgeApis(false)
    expect(isAppBadgeSupported()).toBe(false)
  })
})

describe("applyAppBadge", () => {
  it("sets the count when unread > 0 in a standalone window", () => {
    expect(applyAppBadge(3)).toBe(true)
    expect(setAppBadge).toHaveBeenCalledWith(3)
    expect(clearAppBadge).not.toHaveBeenCalled()
  })

  it("clears the badge at zero unread", () => {
    expect(applyAppBadge(0)).toBe(true)
    expect(clearAppBadge).toHaveBeenCalledTimes(1)
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it("is a no-op outside standalone display-mode", () => {
    stubStandalone(false)
    expect(applyAppBadge(5)).toBe(false)
    expect(setAppBadge).not.toHaveBeenCalled()
  })

  it("is a no-op when the API is missing", () => {
    stubBadgeApis(false)
    expect(applyAppBadge(5)).toBe(false)
  })

  it("does not throw when the badge call rejects", async () => {
    setAppBadge.mockRejectedValueOnce(new Error("denied"))
    expect(() => applyAppBadge(2)).not.toThrow()
    // Give the swallowed rejection a tick to surface if it isn't caught.
    await Promise.resolve()
  })
})
