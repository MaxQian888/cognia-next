/**
 * @jest-environment jsdom
 */
import { openAppSettings } from "./app-settings"

describe("openAppSettings", () => {
  it("returns ok when the plugin opens settings", async () => {
    const openSettings = jest.fn(async () => undefined)
    const out = await openAppSettings(async () => ({ openSettings }))
    expect(out).toEqual({ kind: "ok" })
    expect(openSettings).toHaveBeenCalled()
  })

  it("returns unsupported when the loader rejects (web / Tauri)", async () => {
    const out = await openAppSettings(async () => {
      throw new Error("not native")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error when openSettings throws", async () => {
    const out = await openAppSettings(async () => ({
      openSettings: async () => {
        throw new Error("system denied")
      },
    }))
    expect(out).toEqual({ kind: "error", message: "system denied" })
  })
})
