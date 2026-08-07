/**
 * @jest-environment jsdom
 *
 * Tests for native/local-runtime.getLocalRuntimeDiagnostics()
 */

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const platformMock = jest.fn()
const versionMock = jest.fn()
const archMock = jest.fn()
const familyMock = jest.fn()
const localeMock = jest.fn()
const hostnameMock = jest.fn()

jest.mock(
  "@tauri-apps/plugin-os",
  () => ({
    platform: () => platformMock(),
    version: () => versionMock(),
    arch: () => archMock(),
    family: () => familyMock(),
    locale: () => localeMock(),
    hostname: () => hostnameMock(),
  }),
  { virtual: true }
)

const getNameMock = jest.fn()
const getVersionMock = jest.fn()
const getTauriVersionMock = jest.fn()

jest.mock(
  "@tauri-apps/api/app",
  () => ({
    getName: () => getNameMock(),
    getVersion: () => getVersionMock(),
    getTauriVersion: () => getTauriVersionMock(),
  }),
  { virtual: true }
)

import { getLocalRuntimeDiagnostics } from "./local-runtime"

const healthyReaders = {
  readSidecarStatus: async () => ({ ready: true }),
  readSyncStates: async () => ({}),
  readPluginStatuses: async () => [],
  readMcpTransports: async () => [],
  readRecentErrorCount: async () => 0,
}

const readDiagnostics = (overrides: Parameters<typeof getLocalRuntimeDiagnostics>[0] = {}) =>
  getLocalRuntimeDiagnostics({ ...healthyReaders, ...overrides })

beforeEach(() => {
  isTauriValue = false
  platformMock.mockReset()
  versionMock.mockReset()
  archMock.mockReset()
  familyMock.mockReset()
  localeMock.mockReset()
  hostnameMock.mockReset()
  getNameMock.mockReset()
  getVersionMock.mockReset()
  getTauriVersionMock.mockReset()
})

describe("getLocalRuntimeDiagnostics — web mode", () => {
  it("returns runtime: browser with userAgent/language/platform/online", async () => {
    const diag = await readDiagnostics()
    expect(diag).toBeTruthy()
    expect(diag?.status).toBe("ok")
    expect(diag?.isTauri).toBe(false)
    expect(diag?.runtime).toBe("browser")
    expect(typeof diag?.userAgent).toBe("string")
    expect(typeof diag?.language).toBe("string")
    expect(typeof diag?.capturedAt).toBe("string")
  })

  it("aggregates real subsystem health without retaining raw failure messages", async () => {
    const diag = await readDiagnostics({
      readSyncStates: async () => ({
        messages: { lastSyncAt: 10, since: 4, lastError: "token secret leaked" },
        sessions: { lastSyncAt: 20, since: 5, lastError: null },
      }),
      readPluginStatuses: async () => ["enabled", "error", "disabled"],
      readMcpTransports: async () => ["stdio", "http", "stdio"],
      readRecentErrorCount: async () => 3,
    })

    expect(diag?.status).toBe("error")
    expect(diag?.health).toMatchObject({
      sidecar: { status: "not-applicable" },
      sync: { status: "error", trackedTables: 2, failedTables: 1 },
      plugins: { status: "error", total: 3, enabled: 1, failed: 1 },
      mcp: { status: "ok", enabled: 3, transports: { stdio: 2, http: 1 } },
      recentErrors: { status: "error", count: 3 },
    })
    expect(JSON.stringify(diag)).not.toContain("token secret leaked")
  })

  it("marks a failed health reader unavailable instead of losing the whole snapshot", async () => {
    const diag = await readDiagnostics({
      readPluginStatuses: async () => {
        throw new Error("private plugin path")
      },
    })
    expect(diag?.status).toBe("error")
    expect(diag?.health).toEqual(
      expect.objectContaining({ plugins: { status: "unavailable", code: "plugins_unavailable" } })
    )
    expect(JSON.stringify(diag)).not.toContain("private plugin path")
  })

  it("returns runtime: server when navigator is undefined", async () => {
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    })
    try {
      const diag = await readDiagnostics()
      expect(diag?.runtime).toBe("server")
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      })
    }
  })
})

describe("getLocalRuntimeDiagnostics — Tauri mode", () => {
  beforeEach(() => {
    isTauriValue = true
  })

  it("reads OS + app metadata via the Tauri plugins", async () => {
    platformMock.mockReturnValue("macos")
    versionMock.mockReturnValue("14.5")
    archMock.mockReturnValue("arm64")
    familyMock.mockReturnValue("unix")
    localeMock.mockResolvedValue("en-US")
    hostnameMock.mockResolvedValue("macbook")
    getNameMock.mockResolvedValue("cognia-next")
    getVersionMock.mockResolvedValue("1.0.0")
    getTauriVersionMock.mockResolvedValue("2.9.0")

    const diag = await readDiagnostics()
    expect(diag).toMatchObject({
      status: "ok",
      isTauri: true,
      platform: "macos",
      osVersion: "14.5",
      arch: "arm64",
      family: "unix",
      locale: "en-US",
      hostname: "macbook",
      appName: "cognia-next",
      appVersion: "1.0.0",
      tauriVersion: "2.9.0",
    })
  })

  it("tolerates synchronous OS-plugin failures", async () => {
    platformMock.mockImplementation(() => {
      throw new Error("unsupported")
    })
    versionMock.mockImplementation(() => {
      throw new Error("unsupported")
    })
    archMock.mockImplementation(() => {
      throw new Error("unsupported")
    })
    familyMock.mockImplementation(() => {
      throw new Error("unsupported")
    })
    localeMock.mockRejectedValue(new Error("no locale"))
    hostnameMock.mockRejectedValue(new Error("no hostname"))
    getNameMock.mockRejectedValue(new Error("app missing"))
    getVersionMock.mockRejectedValue(new Error("app missing"))
    getTauriVersionMock.mockRejectedValue(new Error("app missing"))

    const diag = await readDiagnostics()
    expect(diag?.status).toBe("ok")
    expect(diag?.isTauri).toBe(true)
    // platform comes from webEnv in jsdom (navigator.platform); the Tauri
    // override is undefined, so the web value (possibly an empty string) is
    // preserved. We only assert it is not the Tauri value.
    expect(diag?.platform).not.toBe("macos")
    expect(diag?.locale).toBeUndefined()
    expect(diag?.appName).toBeUndefined()
  })

  // Make `navigator.userAgent` throw for the duration of `run`. Replacing the
  // whole `navigator` global with a throwing getter no longer works: from Node
  // 26 on, `typeof navigator` does not invoke that getter, so `readWebEnv`'s
  // `typeof navigator === "undefined"` guard simply took the server branch and
  // nothing ever threw. Poisoning the field the code actually reads is both
  // Node-version-independent and closer to the real failure mode.
  function withThrowingUserAgent(thrown: unknown, run: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "userAgent")
    Object.defineProperty(globalThis.navigator, "userAgent", {
      configurable: true,
      get() {
        throw thrown
      },
    })
    return run().finally(() => {
      if (original) Object.defineProperty(globalThis.navigator, "userAgent", original)
      else delete (globalThis.navigator as { userAgent?: unknown }).userAgent
    })
  }

  it("records an error status when readWebEnv itself throws", async () => {
    isTauriValue = true
    await withThrowingUserAgent(new Error("navigator gone"), async () => {
      const diag = await readDiagnostics()
      expect(diag?.status).toBe("error")
      expect(diag?.lastError).toMatch(/navigator gone/)
    })
  })

  it("coerces non-Error throws to a string in lastError", async () => {
    isTauriValue = true
    await withThrowingUserAgent("string-thrown", async () => {
      const diag = await readDiagnostics()
      expect(diag?.status).toBe("error")
      expect(diag?.lastError).toBe("string-thrown")
    })
  })
})
