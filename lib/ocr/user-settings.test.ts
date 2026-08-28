/** @jest-environment jsdom */
/**
 * The contract is the failure half: an unreadable settings row must read as
 * "OCR is unconfigured" so a caller falls back to `DEFAULT_OCR_SETTINGS`
 * rather than failing a tool call.
 */

const getSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))

import { loadUserOcrSettings } from "./user-settings"

beforeEach(() => {
  getSettings.mockReset()
})

describe("loadUserOcrSettings", () => {
  it("returns the ocrSettings slice, not the whole settings row", async () => {
    getSettings.mockResolvedValue({ ocrSettings: { defaultProviderId: "mock" }, apiKeys: {} })
    await expect(loadUserOcrSettings()).resolves.toEqual({ defaultProviderId: "mock" })
  })

  it("is undefined when the row has no ocrSettings", async () => {
    getSettings.mockResolvedValue({})
    await expect(loadUserOcrSettings()).resolves.toBeUndefined()
  })

  it("is undefined when there is no settings row at all", async () => {
    getSettings.mockResolvedValue(undefined)
    await expect(loadUserOcrSettings()).resolves.toBeUndefined()
  })

  it("swallows a read failure rather than propagating it into a tool call", async () => {
    getSettings.mockRejectedValue(new Error("db closed"))
    await expect(loadUserOcrSettings()).resolves.toBeUndefined()
  })
})
