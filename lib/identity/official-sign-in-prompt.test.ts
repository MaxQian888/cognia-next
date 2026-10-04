/** @jest-environment jsdom */
import {
  OFFICIAL_PROMPT_KEY_PREFIX,
  forgetOfficialPromptDecision,
  readOfficialPromptDecision,
  recordOfficialPromptDecision,
  shouldOfferOfficialSignIn,
} from "./official-sign-in-prompt"

beforeEach(() => localStorage.clear())

describe("the official sign-in prompt decision", () => {
  it("offers the screen until the profile answers, then never again", () => {
    expect(shouldOfferOfficialSignIn("acct_a")).toBe(true)
    recordOfficialPromptDecision("acct_a", "offline")
    expect(shouldOfferOfficialSignIn("acct_a")).toBe(false)
    expect(readOfficialPromptDecision("acct_a")).toBe("offline")
  })

  it("is kept per profile and survives what a tab forgets", () => {
    recordOfficialPromptDecision("acct_a", "signed-in")
    expect(shouldOfferOfficialSignIn("acct_b")).toBe(true)
    expect(localStorage.getItem(`${OFFICIAL_PROMPT_KEY_PREFIX}.acct_a`)).toBe("signed-in")
    sessionStorage.clear()
    expect(readOfficialPromptDecision("acct_a")).toBe("signed-in")
  })

  it("treats an unknown stored value as no answer, and can be forgotten", () => {
    localStorage.setItem(`${OFFICIAL_PROMPT_KEY_PREFIX}.acct_a`, "maybe")
    expect(readOfficialPromptDecision("acct_a")).toBeNull()
    recordOfficialPromptDecision("acct_a", "offline")
    forgetOfficialPromptDecision("acct_a")
    expect(shouldOfferOfficialSignIn("acct_a")).toBe(true)
  })

  it("survives a storage that throws", () => {
    const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied")
    })
    expect(() => recordOfficialPromptDecision("acct_a", "offline")).not.toThrow()
    expect(readOfficialPromptDecision("acct_a")).toBeNull()
    get.mockRestore()
    set.mockRestore()
  })
})
