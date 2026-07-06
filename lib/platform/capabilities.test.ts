/**
 * @jest-environment jsdom
 */
import {
  CORE_CAPABILITY_IDS,
  detectHostProfile,
  detectLocalCapabilities,
  hasCapability,
  isCapabilityId,
  serverBackedCapabilities,
} from "./capabilities"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

function setCapacitorNative(on: boolean) {
  const w = window as unknown as Record<string, unknown>
  if (on) w.Capacitor = { isNativePlatform: () => true }
  else delete w.Capacitor
}

afterEach(() => {
  setTauri(false)
  setCapacitorNative(false)
})

describe("isCapabilityId", () => {
  it("accepts every core id", () => {
    for (const id of CORE_CAPABILITY_IDS) expect(isCapabilityId(id)).toBe(true)
  })

  it("accepts plugin-scoped ids", () => {
    expect(isCapabilityId("plugin:github-delivery")).toBe(true)
  })

  it("rejects a bare 'plugin:' prefix, unknown strings, and non-strings", () => {
    expect(isCapabilityId("plugin:")).toBe(false)
    expect(isCapabilityId("teleportation")).toBe(false)
    expect(isCapabilityId(42)).toBe(false)
    expect(isCapabilityId(null)).toBe(false)
    expect(isCapabilityId(undefined)).toBe(false)
  })
})

describe("detectLocalCapabilities", () => {
  it("returns the tauri baseline under the Tauri marker", () => {
    setTauri(true)
    const caps = detectLocalCapabilities()
    expect(caps).toEqual(
      expect.arrayContaining([
        "webview",
        "shell",
        "pty",
        "sidecar",
        "keyring",
        "uia-automation",
        "ocr",
        "always-on",
        "connector-runtime",
        "mcp-runtime",
        "push-display",
      ])
    )
    expect(caps).not.toContain("camera")
    expect(caps).not.toContain("headless")
  })

  it("returns the mobile baseline under Capacitor native", () => {
    setCapacitorNative(true)
    const caps = detectLocalCapabilities()
    expect(caps).toEqual(
      expect.arrayContaining([
        "webview",
        "camera",
        "geolocation",
        "barcode-scan",
        "voice-record",
        "share-sheet",
        "push-display",
        "biometric",
      ])
    )
    expect(caps).not.toContain("shell")
    expect(caps).not.toContain("always-on")
  })

  it("returns the minimal web baseline on a vanilla browser", () => {
    expect(detectLocalCapabilities()).toEqual(["webview"])
  })

  it("returns the web baseline when window is undefined (SSR)", () => {
    const real = globalThis.window
    // @ts-expect-error simulate SSR
    globalThis.window = undefined
    expect(detectLocalCapabilities()).toEqual(["webview"])
    globalThis.window = real
  })

  it("returns a frozen array", () => {
    expect(Object.isFrozen(detectLocalCapabilities())).toBe(true)
  })

  it("assigns 'headless' to no webview platform", () => {
    for (const setup of [() => setTauri(true), () => setCapacitorNative(true), () => {}]) {
      setTauri(false)
      setCapacitorNative(false)
      setup()
      expect(detectLocalCapabilities()).not.toContain("headless")
    }
  })
})

describe("hasCapability", () => {
  it("checks against an explicit capability set", () => {
    expect(hasCapability("camera", ["camera", "webview"])).toBe(true)
    expect(hasCapability("shell", ["camera", "webview"])).toBe(false)
  })

  it("defaults to the local baseline", () => {
    setTauri(true)
    expect(hasCapability("shell")).toBe(true)
    expect(hasCapability("camera")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Host profiles (ADR-0059 C3/F5)
// ---------------------------------------------------------------------------

const ENV_KEY = "NEXT_PUBLIC_COGNIA_SERVER_URL"

describe("detectHostProfile", () => {
  afterEach(() => {
    delete process.env[ENV_KEY]
    window.localStorage.clear()
  })

  it("desktop on Tauri, mobile-companion on Capacitor", () => {
    setTauri(true)
    expect(detectHostProfile()).toBe("desktop")
    setTauri(false)
    setCapacitorNative(true)
    expect(detectHostProfile()).toBe("mobile-companion")
  })

  it("cloud-companion on web with a server target, web-standalone otherwise", () => {
    expect(detectHostProfile()).toBe("web-standalone")
    process.env[ENV_KEY] = "https://cloud.example.com"
    expect(detectHostProfile()).toBe("cloud-companion")
  })
})

describe("serverBackedCapabilities", () => {
  it("companion profiles proxy execution capabilities to the server", () => {
    for (const profile of ["mobile-companion", "cloud-companion"] as const) {
      const caps = serverBackedCapabilities(profile)
      expect(caps).toContain("shell")
      expect(caps).toContain("sidecar")
      expect(caps).toContain("headless")
      // Local-machine surfaces are NOT server-backed.
      expect(caps).not.toContain("uia-automation")
      expect(caps).not.toContain("ocr")
      expect(caps).not.toContain("pty")
    }
  })

  it("empty for hosts that are their own execution plane or have no server", () => {
    expect(serverBackedCapabilities("desktop")).toEqual([])
    expect(serverBackedCapabilities("web-standalone")).toEqual([])
  })

  it("local-OR-server composition answers the C3 gating question", () => {
    const caps = serverBackedCapabilities("cloud-companion")
    expect(hasCapability("shell", caps)).toBe(true)
  })
})
