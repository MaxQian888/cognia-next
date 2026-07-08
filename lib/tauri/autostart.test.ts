/** @jest-environment jsdom */
import { isAutostartEnabled, enableAutostart, disableAutostart, setAutostart } from "./autostart"

jest.mock("@tauri-apps/plugin-autostart", () => ({
  enable: jest.fn(),
  disable: jest.fn(),
  isEnabled: jest.fn(),
}))

import {
  enable as enableNative,
  disable as disableNative,
  isEnabled as isEnabledNative,
} from "@tauri-apps/plugin-autostart"

const mockedEnable = enableNative as jest.MockedFunction<typeof enableNative>
const mockedDisable = disableNative as jest.MockedFunction<typeof disableNative>
const mockedIsEnabled = isEnabledNative as jest.MockedFunction<typeof isEnabledNative>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/autostart", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    setTauri(false)
    warnSpy.mockRestore()
  })

  describe("isAutostartEnabled", () => {
    it("returns false outside Tauri without invoking the native helper", async () => {
      const result = await isAutostartEnabled()
      expect(result).toBe(false)
      expect(mockedIsEnabled).not.toHaveBeenCalled()
    })

    it("returns the native value when in Tauri", async () => {
      setTauri(true)
      mockedIsEnabled.mockResolvedValue(true)
      await expect(isAutostartEnabled()).resolves.toBe(true)
      expect(mockedIsEnabled).toHaveBeenCalledTimes(1)
    })

    it("logs and returns false when the native helper rejects", async () => {
      setTauri(true)
      mockedIsEnabled.mockRejectedValue(new Error("boom"))
      await expect(isAutostartEnabled()).resolves.toBe(false)
      expect(warnSpy).toHaveBeenCalledWith("isAutostartEnabled failed", expect.any(Error))
    })
  })

  describe("enableAutostart", () => {
    it("is a no-op outside Tauri", async () => {
      await enableAutostart()
      expect(mockedEnable).not.toHaveBeenCalled()
    })

    it("calls native enable in Tauri", async () => {
      setTauri(true)
      mockedEnable.mockResolvedValue(undefined)
      await enableAutostart()
      expect(mockedEnable).toHaveBeenCalledTimes(1)
    })
  })

  describe("disableAutostart", () => {
    it("is a no-op outside Tauri", async () => {
      await disableAutostart()
      expect(mockedDisable).not.toHaveBeenCalled()
    })

    it("calls native disable in Tauri", async () => {
      setTauri(true)
      mockedDisable.mockResolvedValue(undefined)
      await disableAutostart()
      expect(mockedDisable).toHaveBeenCalledTimes(1)
    })
  })

  describe("setAutostart", () => {
    it("is a no-op outside Tauri (true)", async () => {
      await setAutostart(true)
      expect(mockedEnable).not.toHaveBeenCalled()
      expect(mockedDisable).not.toHaveBeenCalled()
    })

    it("is a no-op outside Tauri (false)", async () => {
      await setAutostart(false)
      expect(mockedEnable).not.toHaveBeenCalled()
      expect(mockedDisable).not.toHaveBeenCalled()
    })

    it("calls enable when on=true in Tauri", async () => {
      setTauri(true)
      mockedEnable.mockResolvedValue(undefined)
      await setAutostart(true)
      expect(mockedEnable).toHaveBeenCalledTimes(1)
      expect(mockedDisable).not.toHaveBeenCalled()
    })

    it("calls disable when on=false in Tauri", async () => {
      setTauri(true)
      mockedDisable.mockResolvedValue(undefined)
      await setAutostart(false)
      expect(mockedDisable).toHaveBeenCalledTimes(1)
      expect(mockedEnable).not.toHaveBeenCalled()
    })
  })
})
