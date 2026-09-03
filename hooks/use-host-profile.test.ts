/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import type { Transport } from "@/lib/tauri/transport-types"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"

import {
  capabilityAvailable,
  useCapability,
  useCapabilityChecker,
  useHostProfile,
} from "./use-host-profile"

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

  it("resolves cloud-companion from a host paired in the remote-host registry", () => {
    writePairedRemoteHost()
    expect(renderHook(() => useHostProfile()).result.current).toBe("cloud-companion")
  })

  it("re-reads when a host is activated in this session", () => {
    // The old no-op subscribe froze the first answer, so a browser that paired
    // without reloading kept reporting "no host" to every mounted surface.
    const view = renderHook(() => useHostProfile())
    expect(view.result.current).toBe("web-standalone")
    act(() => {
      writePairedRemoteHost()
      setActiveRemoteTransport({} as Transport)
    })
    expect(view.result.current).toBe("cloud-companion")
  })

  it("re-reads on a companion config change", () => {
    const view = renderHook(() => useHostProfile())
    expect(view.result.current).toBe("web-standalone")
    act(() => {
      writePairedRemoteHost()
      window.dispatchEvent(new Event("cognia:companion-config-changed"))
    })
    expect(view.result.current).toBe("cloud-companion")
  })
})

describe("companion config event parity", () => {
  it("listens to the event name the transport actually dispatches", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.join(__dirname, "..", "lib", "tauri", "transport-companion.ts"),
      "utf8"
    )
    expect(source).toContain('new Event("cognia:companion-config-changed")')
  })
})

/** One row in the shape `stores/remote-host` persists after a pairing. */
function writePairedRemoteHost(): void {
  window.localStorage.setItem(
    "cognia-remote-hosts",
    JSON.stringify({
      version: 3,
      state: {
        hosts: [
          {
            id: "host-1",
            label: "Brain",
            config: {
              baseUrl: "https://brain.example:27890",
              deviceId: "device-1",
              deviceKeyThumbprint: "thumb-1",
              serverVersion: "1.0.0",
            },
          },
        ],
      },
    })
  )
}

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

describe("useCapabilityChecker", () => {
  it("returns a checker bound to the profile that answers like useCapability", () => {
    process.env.NEXT_PUBLIC_COGNIA_SERVER_URL = "https://cloud.example.com"
    const { result } = renderHook(() => useCapabilityChecker())
    expect(result.current("sidecar")).toBe(true)
    expect(result.current("ocr")).toBe(false)
  })

  it("is referentially stable until the remote-transport state changes", () => {
    platformMock = "tauri"
    const { result, rerender } = renderHook(() => useCapabilityChecker())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
    expect(first("headless")).toBe(false)

    const remote: Transport = {
      call: jest.fn(),
      subscribe: jest.fn(() => () => undefined),
    }
    act(() => setActiveRemoteTransport(remote))
    expect(result.current).not.toBe(first)
    expect(result.current("headless")).toBe(true)
  })
})
