/**
 * @jest-environment jsdom
 */
import {
  capabilitiesForPlatform,
  CORE_CAPABILITY_IDS,
  detectHostProfile,
  detectLocalCapabilities,
  hasCapability,
  isCapabilityId,
  serverBackedCapabilities,
  hasHostRuntime,
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
  delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
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
  it("returns the complete server-backed baseline in the headless brain", () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true

    const caps = detectLocalCapabilities()
    expect(caps).toEqual([
      "shell",
      "pty",
      "sidecar",
      "keyring",
      "always-on",
      "connector-runtime",
      "mcp-runtime",
      "headless",
      "thread-handoff-v1",
    ])
    expect(caps).toBe(serverBackedCapabilities("cloud-companion"))
  })

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
        "browser",
        "pro-ide",
      ])
    )
    expect(caps).not.toContain("camera")
    expect(caps).not.toContain("headless")
  })

  it("keeps the embedded Pro IDE off every non-desktop shell", () => {
    // `action.editor.*` gates on this: the node palette greys those nodes out
    // wherever code-server cannot be hosted, instead of letting a user drop a
    // node onto the canvas that is guaranteed to fail at run time.
    setCapacitorNative(true)
    expect(detectLocalCapabilities()).not.toContain("pro-ide")
  })

  it("keeps the embedded Pro IDE off the web baseline", () => {
    expect(detectLocalCapabilities()).not.toContain("pro-ide")
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
    expect(caps).not.toContain("pro-ide")
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

  it("resolves the brain as its own headless execution profile", () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    expect(detectHostProfile()).toBe("headless")
  })

  it("cloud-companion on web with a server target, web-standalone otherwise", () => {
    expect(detectHostProfile()).toBe("web-standalone")
    process.env[ENV_KEY] = "https://cloud.example.com"
    expect(detectHostProfile()).toBe("cloud-companion")
  })

  it("counts a host paired through the remote-host registry", () => {
    // `addHost()` writes here and never touches the credential book, and
    // `activeHostId` is not persisted, so on the next page load this row is the
    // only trace that the browser has a host at all. Reading just the book
    // reported "no host anywhere" and Settings refused every host-backed
    // section on a client that was fully paired.
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
    expect(detectHostProfile()).toBe("cloud-companion")
    expect(hasHostRuntime()).toBe(true)
    expect(serverBackedCapabilities()).toContain("shell")
  })
})

describe("hasHostRuntime", () => {
  it("is false only for a standalone browser", () => {
    for (const profile of ["desktop", "mobile-companion", "cloud-companion", "headless"] as const) {
      expect(hasHostRuntime(profile)).toBe(true)
    }
    expect(hasHostRuntime("web-standalone")).toBe(false)
  })

  it("counts the headless brain as a host, which the open-coded version did not", () => {
    // Six copies of `isTauri() || isCapacitor() || hasWebCompanionTarget()`
    // answered false here, because the brain has no Tauri marker, no Capacitor
    // and no pairing of its own. It IS the execution plane.
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    expect(hasHostRuntime()).toBe(true)
  })

  it("reads the live profile when none is passed", () => {
    setTauri(true)
    expect(hasHostRuntime()).toBe(true)
    setTauri(false)
    expect(hasHostRuntime()).toBe(false)
  })
})

describe("serverBackedCapabilities", () => {
  it("companion profiles proxy execution capabilities to the server", () => {
    for (const profile of ["mobile-companion", "cloud-companion"] as const) {
      const caps = serverBackedCapabilities(profile)
      expect(caps).toContain("shell")
      expect(caps).toContain("pty")
      expect(caps).toContain("sidecar")
      expect(caps).toContain("keyring")
      expect(caps).toContain("headless")
      // Local-machine surfaces are NOT server-backed.
      expect(caps).not.toContain("uia-automation")
      expect(caps).not.toContain("ocr")
    }
  })

  it("empty for hosts that are their own execution plane or have no server", () => {
    expect(serverBackedCapabilities("desktop")).toEqual([])
    expect(serverBackedCapabilities("web-standalone")).toEqual([])
    expect(serverBackedCapabilities("headless")).toEqual([])
  })

  it("local-OR-server composition answers the C3 gating question", () => {
    const caps = serverBackedCapabilities("cloud-companion")
    expect(hasCapability("shell", caps)).toBe(true)
  })
})

describe("capabilitiesForPlatform", () => {
  it("returns the fixed Headless publication baseline without platform detection", () => {
    expect(capabilitiesForPlatform("headless")).toEqual(
      expect.arrayContaining(["shell", "sidecar", "keyring", "always-on", "headless"])
    )
    expect(capabilitiesForPlatform("headless")).not.toContain("webview")
    expect(capabilitiesForPlatform("headless")).not.toContain("uia-automation")
  })
})
