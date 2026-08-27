import {
  detectDesktopOsFamily,
  detectOsFamily,
  isLinuxOs,
  isMacOs,
  osFamilyFrom,
  readOsProbe,
} from "./os"

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
const IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

describe("osFamilyFrom", () => {
  it("names an Apple Silicon Mac macos rather than its frozen MacIntel string", () => {
    expect(osFamilyFrom({ userAgent: MAC_UA, legacyPlatform: "MacIntel", maxTouchPoints: 0 })).toBe(
      "macos"
    )
  })

  it("names an iPad ios even though it reports MacIntel and a Macintosh UA", () => {
    expect(
      osFamilyFrom({ userAgent: IPAD_UA, legacyPlatform: "MacIntel", maxTouchPoints: 5 })
    ).toBe("ios")
  })

  it("names an iPhone ios", () => {
    expect(
      osFamilyFrom({ userAgent: IPHONE_UA, legacyPlatform: "iPhone", maxTouchPoints: 5 })
    ).toBe("ios")
  })

  it("names Android android, not linux, despite the Linux token in its UA", () => {
    expect(
      osFamilyFrom({ userAgent: ANDROID_UA, legacyPlatform: "Linux armv8l", maxTouchPoints: 5 })
    ).toBe("android")
  })

  it("names Windows windows", () => {
    expect(osFamilyFrom({ userAgent: WINDOWS_UA, legacyPlatform: "Win32" })).toBe("windows")
  })

  it("names Linux linux", () => {
    expect(osFamilyFrom({ userAgent: LINUX_UA, legacyPlatform: "Linux x86_64" })).toBe("linux")
  })

  it("prefers userAgentData over the legacy string", () => {
    // A spoofed/stale legacy value must not beat the structured answer.
    expect(
      osFamilyFrom({ uaDataPlatform: "Windows", userAgent: MAC_UA, legacyPlatform: "MacIntel" })
    ).toBe("windows")
  })

  it.each([
    ["macOS", "macos"],
    ["Windows", "windows"],
    ["Linux", "linux"],
    ["Chrome OS", "linux"],
    ["Android", "android"],
    ["iOS", "ios"],
  ] as const)("maps userAgentData.platform %s to %s", (uaDataPlatform, expected) => {
    expect(osFamilyFrom({ uaDataPlatform })).toBe(expected)
  })

  it("falls through to the sniffs when userAgentData reports a family it cannot name", () => {
    expect(osFamilyFrom({ uaDataPlatform: "Unknown", userAgent: LINUX_UA })).toBe("linux")
  })

  it("answers unknown on an empty probe", () => {
    expect(osFamilyFrom({})).toBe("unknown")
  })
})

describe("readOsProbe / detectOsFamily", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")

  function setNavigator(value: unknown): void {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value })
  }

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else delete (globalThis as { navigator?: unknown }).navigator
  })

  it("returns an empty probe with no navigator", () => {
    setNavigator(undefined)
    // `typeof navigator === "undefined"` is false for an explicit `undefined`
    // value, so this also pins the optional-chaining path inside readOsProbe.
    expect(readOsProbe()).toEqual({})
  })

  it("reads every field off navigator", () => {
    setNavigator({
      userAgentData: { platform: "macOS" },
      userAgent: MAC_UA,
      platform: "MacIntel",
      maxTouchPoints: 0,
    })
    expect(readOsProbe()).toEqual({
      uaDataPlatform: "macOS",
      userAgent: MAC_UA,
      legacyPlatform: "MacIntel",
      maxTouchPoints: 0,
    })
    expect(detectOsFamily()).toBe("macos")
    expect(isMacOs()).toBe(true)
    expect(isLinuxOs()).toBe(false)
  })

  it("tolerates a navigator missing every field", () => {
    setNavigator({})
    expect(readOsProbe()).toEqual({
      uaDataPlatform: undefined,
      userAgent: undefined,
      legacyPlatform: undefined,
      maxTouchPoints: 0,
    })
    expect(detectOsFamily()).toBe("unknown")
  })

  it("narrows mobile families to unknown for desktop-only vocabularies", () => {
    setNavigator({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 })
    expect(detectOsFamily()).toBe("ios")
    expect(detectDesktopOsFamily()).toBe("unknown")

    setNavigator({ userAgent: LINUX_UA, platform: "Linux x86_64", maxTouchPoints: 0 })
    expect(detectDesktopOsFamily()).toBe("linux")
    expect(isLinuxOs()).toBe(true)
  })
})
