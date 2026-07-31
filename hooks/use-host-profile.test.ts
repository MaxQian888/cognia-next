/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import type { Transport } from "@/lib/tauri/transport-types"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"

import { capabilityAvailable, useCapability, useHostProfile } from "./use-host-profile"

let platformMock: "tauri" | "mobile" | "web" = "web"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => platformMock,
}))

beforeEach(() => {
  __resetRoutingForTests()
  platformMock = "web"
  delete process.env.NEXT_PUBLIC_COGNIA_SERVER_URL
  window.localStorage.clear()
})

afterEach(() => {
  __resetRoutingForTests()
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

  it("reacts when a desktop starts and stops driving a remote headless host", () => {
    platformMock = "tauri"
    const { result } = renderHook(() => useCapability("headless"))
    expect(result.current).toBe(false)

    const remote: Transport = {
      call: jest.fn(),
      subscribe: jest.fn(() => () => undefined),
    }
    act(() => setActiveRemoteTransport(remote))
    expect(result.current).toBe(true)

    act(() => setActiveRemoteTransport(null))
    expect(result.current).toBe(false)
  })
})

describe("capabilityAvailable", () => {
  it("is the pure form of the same rule", () => {
    expect(capabilityAvailable("sidecar", "cloud-companion")).toBe(true)
    expect(capabilityAvailable("sidecar", "web-standalone")).toBe(false)
  })

  it("adds server-backed capabilities for a desktop with an active remote", () => {
    expect(capabilityAvailable("headless", "desktop", true)).toBe(true)
    expect(capabilityAvailable("uia-automation", "desktop", true)).toBe(false)
  })
})
