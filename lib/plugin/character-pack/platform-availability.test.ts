import { currentRuntimeProfile, isAvailableOnProfile } from "./platform-availability"

const detectPlatformMock = jest.fn()
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => detectPlatformMock(),
}))

beforeEach(() => {
  detectPlatformMock.mockReset()
  detectPlatformMock.mockReturnValue("web")
})

describe("currentRuntimeProfile", () => {
  it("returns tauri inside the desktop shell", () => {
    detectPlatformMock.mockReturnValue("tauri")
    expect(currentRuntimeProfile()).toBe("tauri")
  })

  it("returns mobile inside the Capacitor shell", () => {
    detectPlatformMock.mockReturnValue("mobile")
    expect(currentRuntimeProfile()).toBe("mobile")
  })

  it("returns browser on the web (platform detector reports 'web')", () => {
    detectPlatformMock.mockReturnValue("web")
    expect(currentRuntimeProfile()).toBe("browser")
  })
})

describe("isAvailableOnProfile", () => {
  it("is available when no restriction is set", () => {
    expect(isAvailableOnProfile(undefined, "browser")).toBe(true)
    expect(isAvailableOnProfile([], "tauri")).toBe(true)
    expect(isAvailableOnProfile([], "mobile")).toBe(true)
  })

  it("respects the restriction list against the given profile", () => {
    expect(isAvailableOnProfile(["tauri"], "tauri")).toBe(true)
    expect(isAvailableOnProfile(["tauri"], "browser")).toBe(false)
    expect(isAvailableOnProfile(["browser", "tauri"], "browser")).toBe(true)
  })

  it("treats mobile as browser-class: a browser-targeted pack also shows on mobile", () => {
    expect(isAvailableOnProfile(["browser"], "mobile")).toBe(true)
    expect(isAvailableOnProfile(["browser", "tauri"], "mobile")).toBe(true)
    expect(isAvailableOnProfile(["mobile"], "mobile")).toBe(true)
  })

  it("keeps a desktop-only pack hidden on mobile", () => {
    expect(isAvailableOnProfile(["tauri"], "mobile")).toBe(false)
  })

  it("keeps a mobile-only pack hidden on the desktop / web", () => {
    expect(isAvailableOnProfile(["mobile"], "tauri")).toBe(false)
    expect(isAvailableOnProfile(["mobile"], "browser")).toBe(false)
  })

  it("defaults to the current runtime profile", () => {
    detectPlatformMock.mockReturnValue("web")
    expect(isAvailableOnProfile(["tauri"])).toBe(false)
    detectPlatformMock.mockReturnValue("tauri")
    expect(isAvailableOnProfile(["tauri"])).toBe(true)
    detectPlatformMock.mockReturnValue("mobile")
    expect(isAvailableOnProfile(["browser"])).toBe(true)
  })
})
