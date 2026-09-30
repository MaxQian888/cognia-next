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
  getLocalDeviceConsoleLabel,
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

  it("names mobile browsers before the desktop OS their user agent also mentions", () => {
    // Every Android UA contains "Linux" and every iOS UA "like Mac OS X", so
    // an Android phone read "Linux browser".
    setUserAgent(
      "Mozilla/5.0 (Linux; Android 12; PLR-AL00 Build/HUAWEIPLR-AL00; wv) AppleWebKit/537.36"
    )
    expect(getFriendlyDeviceLabel()).toBe("Android browser")
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")
    expect(getFriendlyDeviceLabel()).toBe("iOS browser")
    setUserAgent("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36")
    expect(getFriendlyDeviceLabel()).toBe("ChromeOS browser")
  })

  it("tells an iPad reporting a Macintosh user agent apart by touch support", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")
    Object.defineProperty(window.navigator, "maxTouchPoints", { value: 5, configurable: true })
    try {
      expect(getFriendlyDeviceLabel()).toBe("iPadOS browser")
    } finally {
      Object.defineProperty(window.navigator, "maxTouchPoints", { value: 0, configurable: true })
    }
  })

  it("degrades gracefully for unknown user agents", () => {
    setUserAgent("Opaque/1.0")
    expect(getFriendlyDeviceLabel()).toBe("Web browser")
    mockIsTauri.mockReturnValue(true)
    expect(getFriendlyDeviceLabel()).toBe("Desktop")
  })
})

describe("getLocalDeviceConsoleLabel", () => {
  const info = (value: { model?: string; manufacturer?: string }) =>
    jest.fn(async () => ({ kind: "ok" as const, value }))

  it("names the hardware on the native shell", async () => {
    setCapacitorPlatform("android")
    const read = info({ model: "PLR-AL00", manufacturer: "HUAWEI" })
    await expect(getLocalDeviceConsoleLabel(read)).resolves.toBe("HUAWEI PLR-AL00")
  })

  it("does not repeat a manufacturer the model already carries", async () => {
    setCapacitorPlatform("android")
    const read = info({ model: "Pixel 8", manufacturer: "pixel" })
    await expect(getLocalDeviceConsoleLabel(read)).resolves.toBe("Pixel 8")
  })

  it("falls back to the generic label without a model or off the native shell", async () => {
    setCapacitorPlatform("ios")
    await expect(getLocalDeviceConsoleLabel(info({ model: " " }))).resolves.toBe("iOS device")
    const unsupported = jest.fn(async () => ({ kind: "unsupported" as const }))
    await expect(getLocalDeviceConsoleLabel(unsupported)).resolves.toBe("iOS device")

    setCapacitorPlatform(null)
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) X/1.0")
    const read = info({ model: "never read" })
    await expect(getLocalDeviceConsoleLabel(read)).resolves.toBe("macOS browser")
    expect(read).not.toHaveBeenCalled()
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
