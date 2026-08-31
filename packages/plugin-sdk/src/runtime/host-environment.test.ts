/** @jest-environment jsdom */

import { createPluginLogger, readHostCapabilities } from "./host-environment"

describe("host environment runtime", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    delete (window as unknown as { Capacitor?: unknown }).Capacitor
    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
  })

  it("detects Tauri before mobile and web", () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    ;(window as unknown as { Capacitor: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }

    expect(readHostCapabilities()).toMatchObject({ tauri: true, mobile: false, platform: "tauri" })
  })

  it("detects a native Capacitor shell", () => {
    ;(window as unknown as { Capacitor: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }

    expect(readHostCapabilities()).toMatchObject({ tauri: false, mobile: true, platform: "mobile" })
  })

  it("creates a plugin-prefixed fallback logger", () => {
    const info = jest.spyOn(console, "info").mockImplementation()

    createPluginLogger("ocr").info("ready", { count: 1 })

    expect(info).toHaveBeenCalledWith("[plugin:ocr] ready", { count: 1 })
    info.mockRestore()
  })
})
