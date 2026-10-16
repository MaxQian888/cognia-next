import { SESSION_KEYS, STORAGE_KEYS } from "./browser-api"

describe("STORAGE_KEYS", () => {
  it("names only things that are safe on disk in a browser profile", () => {
    // `chrome.storage.local` is readable by anything that can read the profile
    // directory. The whole list is asserted rather than spot-checked, so a key
    // added for page text or a token fails here instead of shipping.
    expect(Object.keys(STORAGE_KEYS).sort()).toEqual([
      "appearance",
      "appearanceOverride",
      "lastWorkspaceId",
      "pairing",
      "pendingSubmission",
      "preferences",
      "savedPrompts",
    ])
  })

  it("carries no key that could hold content, a token, or a private key", () => {
    const names = Object.keys(STORAGE_KEYS).join(" ").toLowerCase()
    for (const forbidden of [
      "token",
      "key",
      "secret",
      "text",
      "selection",
      "instruction",
      "page",
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it("versions every key, so an older build's value is never half-read", () => {
    for (const value of Object.values(STORAGE_KEYS)) {
      expect(value).toMatch(/^cognia\.[a-zA-Z]+\.v\d+$/)
    }
  })

  it("keeps the values distinct", () => {
    const values = Object.values(STORAGE_KEYS)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe("SESSION_KEYS", () => {
  it("is the only place a draft may live, and never overlaps local keys", () => {
    expect(Object.keys(SESSION_KEYS).sort()).toEqual(["draft", "socketState", "statusHint"])
    for (const value of Object.values(SESSION_KEYS)) {
      expect(value).toMatch(/^cognia\.[a-zA-Z]+\.v\d+$/)
      expect(Object.values(STORAGE_KEYS)).not.toContain(value)
    }
  })
})
