import { petAccountIdFrom, ensurePetAccountId } from "./account-id"
import type { AppSettings } from "@cognia/agent-config-types"

function settings(partial: Partial<AppSettings>): AppSettings {
  return partial as AppSettings
}

describe("petAccountIdFrom", () => {
  it("prefers the provider account id", () => {
    expect(petAccountIdFrom(settings({ defaultAccountId: "acct", installUuid: "uuid" }))).toBe(
      "acct"
    )
  })

  it("falls back to the install uuid", () => {
    expect(petAccountIdFrom(settings({ installUuid: "uuid" }))).toBe("uuid")
  })

  it("returns null when neither is present", () => {
    expect(petAccountIdFrom(settings({}))).toBeNull()
    expect(petAccountIdFrom(null)).toBeNull()
  })
})

describe("ensurePetAccountId", () => {
  it("returns the existing id without saving", async () => {
    const save = jest.fn()
    expect(await ensurePetAccountId(settings({ defaultAccountId: "acct" }), save)).toBe("acct")
    expect(save).not.toHaveBeenCalled()
  })

  it("generates and persists an install uuid when none exists", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    const id = await ensurePetAccountId(settings({}), save)
    expect(id).toMatch(/[0-9a-f-]{36}/)
    expect(save).toHaveBeenCalledWith({ installUuid: id })
  })
})
