/**
 * @jest-environment jsdom
 */
import { openAppSettings } from "./app-settings"

describe("openAppSettings", () => {
  it("opens the app's native settings screen via NativeSettings.open", async () => {
    const open = jest.fn(async () => ({ status: true }))
    const out = await openAppSettings(async () => ({ open }))
    expect(out).toEqual({ kind: "ok" })
    expect(open).toHaveBeenCalledWith({
      optionAndroid: "application_details",
      optionIOS: "app",
    })
  })

  it("returns unsupported when the loader rejects (web / Tauri)", async () => {
    const out = await openAppSettings(async () => {
      throw new Error("not native")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error when open throws", async () => {
    const out = await openAppSettings(async () => ({
      open: async () => {
        throw new Error("system denied")
      },
    }))
    expect(out).toEqual({ kind: "error", message: "system denied" })
  })
})
