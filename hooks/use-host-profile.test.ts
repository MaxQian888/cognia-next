/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { capabilityAvailable, useCapability, useHostProfile } from "./use-host-profile"

let platformMock: "tauri" | "mobile" | "web" = "web"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => platformMock,
}))

beforeEach(() => {
  platformMock = "web"
  delete process.env.NEXT_PUBLIC_COGNIA_SERVER_URL
  window.localStorage.clear()
})

describe("useHostProfile", () => {
  it("resolves desktop on tauri", () => {
    platformMock = "tauri"
    expect(renderHook(() => useHostProfile()).result.current).toBe("desktop")
  })

  it("resolves mobile-companion on capacitor", () => {
    platformMock = "mobile"
    expect(renderHook(() => useHostProfile()).result.current).toBe("mobile-companion")
  })

  it("resolves web-standalone in a plain browser with no server target", () => {
    expect(renderHook(() => useHostProfile()).result.current).toBe("web-standalone")
  })

  it("resolves cloud-companion when a server URL is baked in", () => {
    process.env.NEXT_PUBLIC_COGNIA_SERVER_URL = "https://cloud.example.com"
    expect(renderHook(() => useHostProfile()).result.current).toBe("cloud-companion")
  })
})

describe("useCapability — local OR server-backed", () => {
  it("desktop has local ocr, no headless", () => {
    platformMock = "tauri"
    expect(renderHook(() => useCapability("ocr")).result.current).toBe(true)
    expect(renderHook(() => useCapability("headless")).result.current).toBe(false)
  })

  it("cloud-companion gets server-backed sidecar/shell but not local-hardware ocr", () => {
    process.env.NEXT_PUBLIC_COGNIA_SERVER_URL = "https://cloud.example.com"
    expect(renderHook(() => useCapability("sidecar")).result.current).toBe(true)
    expect(renderHook(() => useCapability("shell")).result.current).toBe(true)
    expect(renderHook(() => useCapability("ocr")).result.current).toBe(false)
    expect(renderHook(() => useCapability("uia-automation")).result.current).toBe(false)
  })

  it("web-standalone gets neither", () => {
    expect(renderHook(() => useCapability("sidecar")).result.current).toBe(false)
    expect(renderHook(() => useCapability("webview")).result.current).toBe(true)
  })
})

describe("capabilityAvailable", () => {
  it("is the pure form of the same rule", () => {
    expect(capabilityAvailable("sidecar", "cloud-companion")).toBe(true)
    expect(capabilityAvailable("sidecar", "web-standalone")).toBe(false)
  })
})
