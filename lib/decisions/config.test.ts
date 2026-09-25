const getSettings = jest.fn()
const getSecret = jest.fn()
const setSecret = jest.fn()
const clearSecret = jest.fn()

jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))
jest.mock("@/lib/keyring", () => ({
  getSecret: (...args: unknown[]) => getSecret(...args),
  setSecret: (...args: unknown[]) => setSecret(...args),
  clearSecret: (...args: unknown[]) => clearSecret(...args),
}))

import {
  decisionKeyRef,
  getDecisionHttpKey,
  hasDecisionHttpKey,
  loadDecisionSettings,
  setDecisionHttpKey,
} from "./config"

beforeEach(() => {
  jest.clearAllMocks()
})

describe("decisions config", () => {
  it("keys one keyring entry per preset", () => {
    expect(decisionKeyRef("openrouter")).toEqual({ namespace: "decisions", key: "http:openrouter" })
    expect(decisionKeyRef("custom")).toEqual({ namespace: "decisions", key: "http:custom" })
  })

  it("reads settings.decisions with an empty default", async () => {
    getSettings.mockResolvedValueOnce({ decisions: { providerId: "builtin:decisions-http" } })
    await expect(loadDecisionSettings()).resolves.toEqual({ providerId: "builtin:decisions-http" })
    getSettings.mockResolvedValueOnce(undefined)
    await expect(loadDecisionSettings()).resolves.toEqual({})
  })

  it("stores trimmed keys and clears on empty", async () => {
    await setDecisionHttpKey("bocha", "  sk-1  ")
    expect(setSecret).toHaveBeenCalledWith({ namespace: "decisions", key: "http:bocha" }, "sk-1")
    await setDecisionHttpKey("bocha", "   ")
    expect(clearSecret).toHaveBeenCalledWith({ namespace: "decisions", key: "http:bocha" })
  })

  it("propagates keyring write failures to the caller", async () => {
    setSecret.mockRejectedValueOnce(new Error("Keyring web fallback requires a passphrase"))
    await expect(setDecisionHttpKey("zen", "k")).rejects.toThrow(/passphrase/)
  })

  it("reports key presence", async () => {
    getSecret.mockResolvedValueOnce("k").mockResolvedValueOnce(null)
    await expect(hasDecisionHttpKey("zen")).resolves.toBe(true)
    await expect(getDecisionHttpKey("zen")).resolves.toBeNull()
  })
})
