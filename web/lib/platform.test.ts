import { detectPlatform } from "@web/lib/platform"

const UA = {
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  ubuntuFirefox: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
}

describe("detectPlatform", () => {
  it("recognises the three desktop platforms the build targets", () => {
    expect(detectPlatform(UA.macChrome)).toBe("macos")
    expect(detectPlatform(UA.macSafari)).toBe("macos")
    expect(detectPlatform(UA.windows)).toBe("windows")
    expect(detectPlatform(UA.linux)).toBe("linux")
    expect(detectPlatform(UA.ubuntuFirefox)).toBe("linux")
  })

  it("declines to guess on mobile, where there is no build to point at", () => {
    // Android's UA contains "Linux"; naming the Linux desktop build for a phone
    // reader is worse than saying nothing.
    expect(detectPlatform(UA.android)).toBeNull()
    expect(detectPlatform(UA.iphone)).toBeNull()
  })

  it("declines to guess on Chrome OS, whose UA also contains X11", () => {
    expect(detectPlatform(UA.chromeOs)).toBeNull()
  })

  it("returns null rather than a wrong guess for an unknown agent", () => {
    expect(detectPlatform("")).toBeNull()
    expect(detectPlatform("curl/8.7.1")).toBeNull()
    expect(detectPlatform("some-bot/1.0")).toBeNull()
  })

  it("is case-insensitive", () => {
    expect(detectPlatform("MOZILLA/5.0 (WINDOWS NT 10.0)")).toBe("windows")
  })

  // iPadOS 13+ reports a desktop Safari UA on purpose. This used to be
  // documented as the caller's problem and no caller ever solved it, so an
  // iPad was told it was running macOS.
  describe("iPad, which reports a Mac-like agent", () => {
    const IPAD_DESKTOP_UA =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

    it("declines a Mac-shaped agent that reports touch points", () => {
      expect(detectPlatform(IPAD_DESKTOP_UA, { maxTouchPoints: 5 })).toBeNull()
    })

    it("still names a real Mac, which reports none", () => {
      expect(detectPlatform(IPAD_DESKTOP_UA, { maxTouchPoints: 0 })).toBe("macos")
    })

    it("assumes no touch points when the caller supplies no signals", () => {
      expect(detectPlatform(IPAD_DESKTOP_UA)).toBe("macos")
      expect(detectPlatform(IPAD_DESKTOP_UA, {})).toBe("macos")
    })

    it("declines an agent that names the iPad outright", () => {
      expect(
        detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15")
      ).toBeNull()
    })

    // The touch check is scoped to the ambiguous Mac case — a touchscreen
    // Windows laptop is still a Windows machine.
    it("keeps naming Windows and Linux regardless of touch points", () => {
      expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64)", { maxTouchPoints: 10 })).toBe(
        "windows"
      )
      expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)", { maxTouchPoints: 10 })).toBe(
        "linux"
      )
    })
  })
})
