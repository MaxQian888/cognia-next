const getSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: (...a: unknown[]) => getSettings(...a),
}))

import { loadPlanConfigDefaults } from "./plan-settings"

beforeEach(() => {
  getSettings.mockReset()
})

describe("loadPlanConfigDefaults", () => {
  it("projects both knobs when configured", async () => {
    getSettings.mockResolvedValue({
      planSettings: { requireApproval: false, maxAutoRefinements: 4, interactiveHtmlView: true },
    })
    await expect(loadPlanConfigDefaults()).resolves.toEqual({
      requireApproval: false,
      maxAutoRefinements: 4,
    })
  })

  it("projects only the configured knob", async () => {
    getSettings.mockResolvedValue({ planSettings: { maxAutoRefinements: 0 } })
    await expect(loadPlanConfigDefaults()).resolves.toEqual({ maxAutoRefinements: 0 })
  })

  it("returns undefined when planSettings is absent", async () => {
    getSettings.mockResolvedValue({})
    await expect(loadPlanConfigDefaults()).resolves.toBeUndefined()
  })

  it("returns undefined when planSettings carries only unrelated keys", async () => {
    getSettings.mockResolvedValue({ planSettings: { interactiveHtmlStyle: "cards" } })
    await expect(loadPlanConfigDefaults()).resolves.toBeUndefined()
  })

  it("returns undefined when there is no settings row", async () => {
    getSettings.mockResolvedValue(undefined)
    await expect(loadPlanConfigDefaults()).resolves.toBeUndefined()
  })

  it("fails soft when the settings read throws", async () => {
    getSettings.mockRejectedValue(new Error("dexie down"))
    await expect(loadPlanConfigDefaults()).resolves.toBeUndefined()
  })
})
