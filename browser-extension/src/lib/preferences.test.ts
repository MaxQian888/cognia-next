import {
  DEFAULT_PREFERENCES,
  MAX_PROMPT_BYTES,
  MAX_SAVED_PROMPTS,
  isBlockedUrl,
  normalizeHost,
  parsePreferences,
  parseSavedPrompts,
  upsertSavedPrompt,
} from "./preferences"

describe("preferences", () => {
  it("defaults everything off", () => {
    expect(parsePreferences(undefined)).toEqual(DEFAULT_PREFERENCES)
    expect(parsePreferences({ notifications: "yes", agentMode: 1 })).toEqual(DEFAULT_PREFERENCES)
  })

  it("normalizes and de-duplicates blocked hosts", () => {
    expect(
      parsePreferences({
        notifications: true,
        blockedHosts: [
          "Bank.Example.com",
          "https://bank.example.com/login",
          "*.corp.test",
          "not a host",
          5,
        ],
      })
    ).toEqual({
      notifications: true,
      agentMode: false,
      blockedHosts: ["bank.example.com", "corp.test"],
    })
  })

  it("normalizes typed hosts", () => {
    expect(normalizeHost(" localhost ")).toBe("localhost")
    expect(normalizeHost("example.com.")).toBe("example.com")
    expect(normalizeHost("")).toBeNull()
    expect(normalizeHost("nodot")).toBeNull()
  })

  it("blocks a host and its subdomains, not look-alikes", () => {
    const blocked = ["bank.example.com"]
    expect(isBlockedUrl("https://bank.example.com/a", blocked)).toBe(true)
    expect(isBlockedUrl("https://eu.bank.example.com/a", blocked)).toBe(true)
    expect(isBlockedUrl("https://notbank.example.com/a", blocked)).toBe(false)
    expect(isBlockedUrl("not a url", blocked)).toBe(false)
  })
})

describe("saved prompts", () => {
  it("parses defensively", () => {
    expect(
      parseSavedPrompts([
        { id: "a", title: " Sum ", instruction: "Summarize" },
        { id: "a", title: "dup", instruction: "x" },
        { id: "b", instruction: "Explain this" },
        { id: "c", title: "empty", instruction: "  " },
        { id: "d", instruction: "x".repeat(MAX_PROMPT_BYTES + 1) },
        "junk",
      ])
    ).toEqual([
      { id: "a", title: "Sum", instruction: "Summarize" },
      { id: "b", title: "Explain this", instruction: "Explain this" },
    ])
    expect(parseSavedPrompts({})).toEqual([])
  })

  it("adds, replaces and refuses", () => {
    const added = upsertSavedPrompt([], { id: "a", title: "", instruction: "Summarize" })
    expect(added).toEqual({
      ok: true,
      prompts: [{ id: "a", title: "Summarize", instruction: "Summarize" }],
    })
    if (!added.ok) throw new Error("unreachable")
    expect(
      upsertSavedPrompt(added.prompts, { id: "a", title: "S", instruction: "Sum up" })
    ).toEqual({
      ok: true,
      prompts: [{ id: "a", title: "S", instruction: "Sum up" }],
    })
    expect(upsertSavedPrompt([], { id: "x", title: "", instruction: " " })).toEqual({
      ok: false,
      reason: "empty",
    })
    expect(
      upsertSavedPrompt([], {
        id: "x",
        title: "",
        instruction: "é".repeat(MAX_PROMPT_BYTES / 2 + 1),
      })
    ).toEqual({
      ok: false,
      reason: "too_long",
    })
    const full = Array.from({ length: MAX_SAVED_PROMPTS }, (_, index) => ({
      id: String(index),
      title: "t",
      instruction: "i",
    }))
    expect(upsertSavedPrompt(full, { id: "new", title: "", instruction: "i" })).toEqual({
      ok: false,
      reason: "full",
    })
  })
})
