/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { detectPlatform, usePlatform } from "./use-platform"

afterEach(() => {
  // Clean up any window patches between tests.
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as { Capacitor?: unknown }).Capacitor
})

describe("detectPlatform", () => {
  it("returns 'tauri' when __TAURI_INTERNALS__ is present", () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    expect(detectPlatform()).toBe("tauri")
  })

  it("returns 'mobile' when window.Capacitor.isNativePlatform() === true", () => {
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    expect(detectPlatform()).toBe("mobile")
  })

  it("returns 'web' when window.Capacitor.isNativePlatform() === false", () => {
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => false,
    }
    expect(detectPlatform()).toBe("web")
  })

  it("returns 'web' when neither marker is present", () => {
    expect(detectPlatform()).toBe("web")
  })

  it("prefers 'tauri' over 'mobile' when both somehow appear", () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    expect(detectPlatform()).toBe("tauri")
  })
})

describe("usePlatform", () => {
  it("returns 'tauri' when __TAURI_INTERNALS__ is on window", () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    const { result } = renderHook(() => usePlatform())
    expect(result.current).toBe("tauri")
  })

  it("returns 'mobile' when window.Capacitor.isNativePlatform() is true", () => {
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    const { result } = renderHook(() => usePlatform())
    expect(result.current).toBe("mobile")
  })

  it("returns 'web' on a vanilla browser", () => {
    const { result } = renderHook(() => usePlatform())
    expect(result.current).toBe("web")
  })
})
