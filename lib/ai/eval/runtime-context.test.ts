/** @jest-environment jsdom */
/**
 * The contract is the `null` half: an eval caller must be able to tell
 * "not unlocked yet" from "broken", so a missing account or missing settings
 * resolves to `null` rather than throwing.
 */

const settingsState: { settings: unknown } = { settings: null }
const accountState: { unlockedAccountId: string | null } = { unlockedAccountId: null }

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => settingsState },
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: () => accountState },
}))

import { loadEvalAppSettings, loadEvalRuntimeContext } from "./runtime-context"

beforeEach(() => {
  settingsState.settings = null
  accountState.unlockedAccountId = null
})

describe("eval runtime context", () => {
  it("returns null settings rather than undefined when the store has none", async () => {
    await expect(loadEvalAppSettings()).resolves.toBeNull()
  })

  it("returns the settings once the store has them", async () => {
    settingsState.settings = { theme: "dark" }
    await expect(loadEvalAppSettings()).resolves.toEqual({ theme: "dark" })
  })

  it("is null while the account is locked, even with settings present", async () => {
    settingsState.settings = { theme: "dark" }
    await expect(loadEvalRuntimeContext()).resolves.toBeNull()
  })

  it("is null when an account is unlocked but settings have not loaded", async () => {
    accountState.unlockedAccountId = "acct-1"
    await expect(loadEvalRuntimeContext()).resolves.toBeNull()
  })

  it("pairs the settings with the unlocked account id", async () => {
    settingsState.settings = { theme: "dark" }
    accountState.unlockedAccountId = "acct-1"
    await expect(loadEvalRuntimeContext()).resolves.toEqual({
      settings: { theme: "dark" },
      localAccountId: "acct-1",
    })
  })
})
