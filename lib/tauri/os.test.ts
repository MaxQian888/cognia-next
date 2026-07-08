/** @jest-environment jsdom */
import { getOsInfo, isLinuxPlatform, isMacPlatform } from "./os"

jest.mock("@tauri-apps/plugin-os", () => ({
  arch: jest.fn(),
  family: jest.fn(),
  hostname: jest.fn(),
  locale: jest.fn(),
  platform: jest.fn(),
  type: jest.fn(),
  version: jest.fn(),
}))

import {
  arch as archNative,
  family as familyNative,
  hostname as hostnameNative,
  locale as localeNative,
  platform as platformNative,
  type as typeNative,
  version as versionNative,
} from "@tauri-apps/plugin-os"

const mockedArch = archNative as jest.MockedFunction<typeof archNative>
const mockedFamily = familyNative as jest.MockedFunction<typeof familyNative>
const mockedHostname = hostnameNative as jest.MockedFunction<typeof hostnameNative>
const mockedLocale = localeNative as jest.MockedFunction<typeof localeNative>
const mockedPlatform = platformNative as jest.MockedFunction<typeof platformNative>
const mockedType = typeNative as jest.MockedFunction<typeof typeNative>
const mockedVersion = versionNative as jest.MockedFunction<typeof versionNative>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/os", () => {
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

  describe("getOsInfo", () => {
    it("returns null outside Tauri", async () => {
      await expect(getOsInfo()).resolves.toBeNull()
      expect(mockedPlatform).not.toHaveBeenCalled()
    })

    it("aggregates all OS facts when in Tauri", async () => {
      setTauri(true)
      mockedPlatform.mockReturnValue("macos" as ReturnType<typeof platformNative>)
      mockedType.mockReturnValue("macos" as ReturnType<typeof typeNative>)
      mockedFamily.mockReturnValue("unix" as ReturnType<typeof familyNative>)
      mockedArch.mockReturnValue("aarch64" as ReturnType<typeof archNative>)
      mockedVersion.mockReturnValue("14.5.0")
      mockedHostname.mockResolvedValue("my-host")
      mockedLocale.mockResolvedValue("en-US")

      await expect(getOsInfo()).resolves.toEqual({
        platform: "macos",
        osType: "macos",
        family: "unix",
        arch: "aarch64",
        version: "14.5.0",
        hostname: "my-host",
        locale: "en-US",
      })
    })

    it("logs and returns null if any underlying call rejects", async () => {
      setTauri(true)
      mockedPlatform.mockImplementation(() => {
        throw new Error("plat boom")
      })
      await expect(getOsInfo()).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalledWith("getOsInfo failed", expect.any(Error))
    })

    it("logs and returns null when hostname rejects", async () => {
      setTauri(true)
      mockedPlatform.mockReturnValue("linux" as ReturnType<typeof platformNative>)
      mockedType.mockReturnValue("linux" as ReturnType<typeof typeNative>)
      mockedFamily.mockReturnValue("unix" as ReturnType<typeof familyNative>)
      mockedArch.mockReturnValue("x86_64" as ReturnType<typeof archNative>)
      mockedVersion.mockReturnValue("6.0.0")
      mockedHostname.mockRejectedValue(new Error("hn boom"))
      mockedLocale.mockResolvedValue(null)
      await expect(getOsInfo()).resolves.toBeNull()
    })
  })

  describe("isMacPlatform", () => {
    it("uses navigator.platform outside Tauri (mac match)", () => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: "MacIntel",
      })
      expect(isMacPlatform()).toBe(true)
    })

    it("uses navigator.platform outside Tauri (non-mac)", () => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: "Win32",
      })
      expect(isMacPlatform()).toBe(false)
    })

    it("returns true when native platform is 'macos' in Tauri", () => {
      setTauri(true)
      mockedPlatform.mockReturnValue("macos" as ReturnType<typeof platformNative>)
      expect(isMacPlatform()).toBe(true)
    })

    it("returns false when native platform is not 'macos'", () => {
      setTauri(true)
      mockedPlatform.mockReturnValue("windows" as ReturnType<typeof platformNative>)
      expect(isMacPlatform()).toBe(false)
    })

    it("returns false when native platform throws", () => {
      setTauri(true)
      mockedPlatform.mockImplementation(() => {
        throw new Error("plat boom")
      })
      expect(isMacPlatform()).toBe(false)
    })
  })

  describe("isLinuxPlatform", () => {
    it("uses navigator.platform outside Tauri (linux match)", () => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: "Linux x86_64",
      })
      expect(isLinuxPlatform()).toBe(true)
    })

    it("uses navigator.platform outside Tauri (non-linux)", () => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: "Win32",
      })
      expect(isLinuxPlatform()).toBe(false)
    })

    it("returns true when native platform is 'linux' in Tauri", () => {
      setTauri(true)
      mockedPlatform.mockReturnValue("linux" as ReturnType<typeof platformNative>)
      expect(isLinuxPlatform()).toBe(true)
    })

    it("returns false when native platform is not 'linux'", () => {
      setTauri(true)
      mockedPlatform.mockReturnValue("macos" as ReturnType<typeof platformNative>)
      expect(isLinuxPlatform()).toBe(false)
    })

    it("returns false when native platform throws", () => {
      setTauri(true)
      mockedPlatform.mockImplementation(() => {
        throw new Error("plat boom")
      })
      expect(isLinuxPlatform()).toBe(false)
    })
  })
})
