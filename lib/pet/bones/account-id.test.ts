import { petAccountIdFrom, ensurePetAccountId } from "./account-id"
import type { AppSettings } from "@cognia/agent-config-types"

function settings(partial: Partial<AppSettings>): AppSettings {
  return partial as AppSettings
}

describe("petAccountIdFrom", () => {
  it("prefers the provider account id", () => {
    expect(
      petAccountIdFrom(
        settings({
          defaultProvider: "codex",
          defaultAccountIds: { anthropic: "claude", codex: "codex" },
          installUuid: "uuid",
        })
      )
    ).toBe("codex")
  })

  it("retains legacy singular-default compatibility", () => {
    expect(
      petAccountIdFrom(
        settings({ defaultProvider: "anthropic", defaultAccountId: "acct", installUuid: "uuid" })
      )
    ).toBe("acct")
  })

  it("falls back to the install uuid", () => {
    expect(petAccountIdFrom(settings({ installUuid: "uuid" }))).toBe("uuid")
  })

  it("ignores non-subscription default providers", () => {
    expect(
      petAccountIdFrom(
        settings({
          defaultProvider: "openai",
          defaultAccountIds: { codex: "codex-account" },
          defaultAccountId: "stale-legacy-account",
          installUuid: "uuid",
        })
      )
    ).toBe("uuid")
  })

  it("normalizes an OpenCode Go legacy default", () => {
    expect(
      petAccountIdFrom(settings({ defaultProvider: "opencode-go", defaultAccountId: "go-account" }))
    ).toBe("go-account")
  })

  it("returns null when neither is present", () => {
    expect(petAccountIdFrom(settings({}))).toBeNull()
    expect(petAccountIdFrom(null)).toBeNull()
  })
})

describe("ensurePetAccountId", () => {
  it("returns the existing id without saving", async () => {
    const save = jest.fn()
    expect(
      await ensurePetAccountId(
        settings({ defaultProvider: "anthropic", defaultAccountIds: { anthropic: "acct" } }),
        save
      )
    ).toBe("acct")
    expect(save).not.toHaveBeenCalled()
  })

  it("generates and persists an install uuid when none exists", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    const id = await ensurePetAccountId(settings({}), save)
    expect(id).toMatch(/[0-9a-f-]{36}/)
    expect(save).toHaveBeenCalledWith({ installUuid: id })
  })
})
