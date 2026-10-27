/** @jest-environment jsdom */
import {
  AutostartStateMismatchError,
  isAutostartEnabled,
  enableAutostart,
  disableAutostart,
  setAutostart,
} from "./autostart"
import { onAutostartChanged, toggleTrayAutostart } from "@/lib/tray/autostart-control"

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
  let nativeEnabled: boolean

  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
    nativeEnabled = false
    mockedEnable.mockImplementation(async () => {
      nativeEnabled = true
    })
    mockedDisable.mockImplementation(async () => {
      nativeEnabled = false
    })
    mockedIsEnabled.mockImplementation(async () => nativeEnabled)
  })

  afterEach(() => {
    setTauri(false)
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

    it("preserves a native read failure instead of reporting disabled", async () => {
      setTauri(true)
      mockedIsEnabled.mockRejectedValue(new Error("boom"))
      await expect(isAutostartEnabled()).rejects.toThrow("boom")
    })
  })

  describe("enableAutostart", () => {
    it("is a no-op outside Tauri", async () => {
      await enableAutostart()
      expect(mockedEnable).not.toHaveBeenCalled()
    })

    it("calls native enable in Tauri", async () => {
      setTauri(true)
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
      await disableAutostart()
      expect(mockedDisable).toHaveBeenCalledTimes(1)
    })
  })

  describe("setAutostart", () => {
    it("keeps tray toggles inert outside Tauri", async () => {
      await expect(toggleTrayAutostart()).resolves.toBe(false)
      expect(mockedIsEnabled).not.toHaveBeenCalled()
      expect(mockedEnable).not.toHaveBeenCalled()
      expect(mockedDisable).not.toHaveBeenCalled()
    })

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
      await setAutostart(true)
      expect(mockedEnable).toHaveBeenCalledTimes(1)
      expect(mockedDisable).not.toHaveBeenCalled()
    })

    it("calls disable when on=false in Tauri", async () => {
      setTauri(true)
      await setAutostart(false)
      expect(mockedDisable).toHaveBeenCalledTimes(1)
      expect(mockedEnable).not.toHaveBeenCalled()
    })
  })

  describe("verified, serialized changes", () => {
    beforeEach(() => setTauri(true))

    it("broadcasts changes made outside the tray after reading them back", async () => {
      const seen: boolean[] = []
      const off = onAutostartChanged((on) => seen.push(on))
      try {
        await enableAutostart()
        await disableAutostart()
        expect(seen).toEqual([true, false])
        expect(mockedIsEnabled).toHaveBeenCalledTimes(2)
      } finally {
        off()
      }
    })

    it("rejects a registration that did not take effect", async () => {
      mockedEnable.mockResolvedValue(undefined)
      await expect(setAutostart(true)).rejects.toThrow(AutostartStateMismatchError)
    })

    it("does not invent a broadcast when readback fails and recovers on the next write", async () => {
      const listener = jest.fn()
      const off = onAutostartChanged(listener)
      mockedIsEnabled.mockRejectedValueOnce(new Error("readback failed"))
      try {
        await expect(setAutostart(true)).rejects.toThrow("readback failed")
        expect(nativeEnabled).toBe(true)
        expect(listener).not.toHaveBeenCalled()
        await setAutostart(false)
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith(false)
      } finally {
        off()
      }
    })

    it("does not overlap writes and lets a later write recover after failure", async () => {
      let rejectFirst!: (error: Error) => void
      mockedEnable.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectFirst = reject
          })
      )
      const first = setAutostart(true)
      const firstResult = expect(first).rejects.toThrow("registration failed")
      const second = setAutostart(false)
      await Promise.resolve()
      expect(mockedEnable).toHaveBeenCalledTimes(1)
      expect(mockedDisable).not.toHaveBeenCalled()
      rejectFirst(new Error("registration failed"))
      await firstResult
      await second
      expect(mockedDisable).toHaveBeenCalledTimes(1)
    })

    it("applies two concurrent tray toggles in order", async () => {
      const results = await Promise.all([toggleTrayAutostart(), toggleTrayAutostart()])
      expect(results).toEqual([true, false])
      expect(nativeEnabled).toBe(false)
    })

    it("never enables autostart when the tray cannot read its current state", async () => {
      mockedIsEnabled.mockRejectedValue(new Error("permission denied"))
      await expect(toggleTrayAutostart()).rejects.toThrow("permission denied")
      expect(mockedEnable).not.toHaveBeenCalled()
      expect(mockedDisable).not.toHaveBeenCalled()
    })
  })
})
