/**
 * @jest-environment jsdom
 */
// Stable device identity for backup provenance. Mirrors the backup-key tests:
// web (localStorage) path is exercised directly; the desktop branch falls
// through to web storage when the plugin store isn't available.

import {
  __TESTING__,
  getDeviceId,
  getDeviceMetadata,
  getDevicePlatformKind,
  getFriendlyDeviceLabel,
} from "./device-identity"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

import { isTauri } from "@/lib/tauri"

const mockIsTauri = isTauri as jest.Mock

const { WEB_DEVICE_ID_STORAGE } = __TESTING__

const setUserAgent = (value: string) => {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true })
}

const setCapacitorPlatform = (platform: string | null) => {
  const w = window as { Capacitor?: { getPlatform?: () => string } }
  if (platform === null) delete w.Capacitor
  else w.Capacitor = { getPlatform: () => platform }
}

beforeEach(() => {
  localStorage.clear()
  mockIsTauri.mockReturnValue(false)
  setCapacitorPlatform(null)
})

describe("getDeviceId", () => {
  it("generates and persists a fresh id on first call (web)", async () => {
    expect(localStorage.getItem(WEB_DEVICE_ID_STORAGE)).toBeNull()
    const id = await getDeviceId()
    expect(id).toBeTruthy()
    expect(localStorage.getItem(WEB_DEVICE_ID_STORAGE)).toBe(id)
  })

  it("returns the same id on subsequent calls (idempotent)", async () => {
    const a = await getDeviceId()
    const b = await getDeviceId()
    expect(a).toBe(b)
  })

  it("falls back to web storage when Tauri's plugin store is unavailable", async () => {
    // jest moduleNameMapper shims @tauri-apps/plugin-store with a null-get
    // store on some suites; here the import itself may fail — either way the
    // call must still resolve to a persisted id.
    mockIsTauri.mockReturnValue(true)
    const id = await getDeviceId()
    expect(id).toBeTruthy()
  })

  it("generates an id even without crypto.randomUUID (old WebViews)", async () => {
    const cryptoObj = globalThis.crypto as { randomUUID?: () => string }
    const original = cryptoObj.randomUUID

    delete cryptoObj.randomUUID
    try {
      const id = await getDeviceId()
      expect(id).toBeTruthy()
      expect(id!.startsWith("dev-")).toBe(true)
    } finally {
      if (original) cryptoObj.randomUUID = original
    }
  })
})

describe("getFriendlyDeviceLabel", () => {
  it("labels Capacitor platforms generically", () => {
    setCapacitorPlatform("ios")
    expect(getFriendlyDeviceLabel()).toBe("iOS device")
    setCapacitorPlatform("android")
    expect(getFriendlyDeviceLabel()).toBe("Android device")
  })

  it("labels desktop by OS, never the raw userAgent", () => {
    mockIsTauri.mockReturnValue(true)
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Secret/1.0")
    const label = getFriendlyDeviceLabel()
    expect(label).toBe("Windows desktop")
    expect(label).not.toContain("Secret")
  })

  it("labels browsers by OS", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) X/1.0")
    expect(getFriendlyDeviceLabel()).toBe("macOS browser")
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64) X/1.0")
    expect(getFriendlyDeviceLabel()).toBe("Linux browser")
  })

  it("degrades gracefully for unknown user agents", () => {
    setUserAgent("Opaque/1.0")
    expect(getFriendlyDeviceLabel()).toBe("Web browser")
    mockIsTauri.mockReturnValue(true)
    expect(getFriendlyDeviceLabel()).toBe("Desktop")
  })
})

describe("getDevicePlatformKind", () => {
  it("maps Tauri to desktop and Capacitor to its platform", () => {
    mockIsTauri.mockReturnValue(true)
    expect(getDevicePlatformKind()).toBe("desktop")
    mockIsTauri.mockReturnValue(false)
    setCapacitorPlatform("android")
    expect(getDevicePlatformKind()).toBe("android")
    setCapacitorPlatform(null)
    expect(getDevicePlatformKind()).toBe("web")
  })
})

describe("getDeviceMetadata", () => {
  it("returns id + friendly label + platform", async () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0) X/1.0")
    const meta = await getDeviceMetadata()
    expect(meta).not.toBeNull()
    expect(meta!.id).toBe(localStorage.getItem(WEB_DEVICE_ID_STORAGE))
    expect(meta!.label).toBe("Windows browser")
    expect(meta!.platform).toBe("web")
  })
})
