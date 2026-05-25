import { currentRuntimeProfile, isAvailableOnProfile } from "./platform-availability"

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

beforeEach(() => {
  isTauriMock.mockReset()
})

describe("currentRuntimeProfile", () => {
  it("returns tauri inside the desktop shell", () => {
    isTauriMock.mockReturnValue(true)
    expect(currentRuntimeProfile()).toBe("tauri")
  })

  it("returns browser outside Tauri (web / Capacitor)", () => {
    isTauriMock.mockReturnValue(false)
    expect(currentRuntimeProfile()).toBe("browser")
  })
})

describe("isAvailableOnProfile", () => {
  it("is available when no restriction is set", () => {
    expect(isAvailableOnProfile(undefined, "browser")).toBe(true)
    expect(isAvailableOnProfile([], "tauri")).toBe(true)
  })

  it("respects the restriction list against the given profile", () => {
    expect(isAvailableOnProfile(["tauri"], "tauri")).toBe(true)
    expect(isAvailableOnProfile(["tauri"], "browser")).toBe(false)
    expect(isAvailableOnProfile(["browser", "tauri"], "browser")).toBe(true)
  })

  it("defaults to the current runtime profile", () => {
    isTauriMock.mockReturnValue(false)
    expect(isAvailableOnProfile(["tauri"])).toBe(false)
    isTauriMock.mockReturnValue(true)
    expect(isAvailableOnProfile(["tauri"])).toBe(true)
  })
})
