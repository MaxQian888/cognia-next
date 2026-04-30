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
    const diag = await getLocalRuntimeDiagnostics()
    expect(diag).toBeTruthy()
    expect(diag?.status).toBe("ok")
    expect(diag?.isTauri).toBe(false)
    expect(diag?.runtime).toBe("browser")
    expect(typeof diag?.userAgent).toBe("string")
    expect(typeof diag?.language).toBe("string")
    expect(typeof diag?.capturedAt).toBe("string")
  })

  it("returns runtime: server when navigator is undefined", async () => {
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    })
    try {
      const diag = await getLocalRuntimeDiagnostics()
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

    const diag = await getLocalRuntimeDiagnostics()
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

    const diag = await getLocalRuntimeDiagnostics()
    expect(diag?.status).toBe("ok")
    expect(diag?.isTauri).toBe(true)
    // platform comes from webEnv in jsdom (navigator.platform); the Tauri
    // override is undefined, so the web value (possibly an empty string) is
    // preserved. We only assert it is not the Tauri value.
    expect(diag?.platform).not.toBe("macos")
    expect(diag?.locale).toBeUndefined()
    expect(diag?.appName).toBeUndefined()
  })

  it("records an error status when readWebEnv itself throws", async () => {
    isTauriValue = true
    // Force the navigator.userAgent getter to throw, propagating to
    // readWebEnv, which then bubbles into the outer try/catch.
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      get() {
        throw new Error("navigator gone")
      },
    })
    try {
      const diag = await getLocalRuntimeDiagnostics()
      expect(diag?.status).toBe("error")
      expect(diag?.lastError).toMatch(/navigator gone/)
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      })
    }
  })

  it("coerces non-Error throws to a string in lastError", async () => {
    isTauriValue = true
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      get() {
        throw "string-thrown"
      },
    })
    try {
      const diag = await getLocalRuntimeDiagnostics()
      expect(diag?.status).toBe("error")
      expect(diag?.lastError).toBe("string-thrown")
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        configurable: true,
      })
    }
  })
})
