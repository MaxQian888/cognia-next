import { suggest } from "./autosuggest"

const sources = {
  history: ["git status", "git push origin main", "npm test"],
  commands: ["/clear", "/copy", "/compact"],
}

describe("autosuggest.suggest", () => {
  it("returns the remaining suffix of the most-recent history match", () => {
    expect(suggest("git ", true, sources)).toBe("status")
  })

  it("matches recency order (first matching entry wins)", () => {
    // both "git status" and "git push…" match "git "; the earlier (more recent)
    // entry is chosen.
    const recent = { ...sources, history: ["git push origin main", "git status"] }
    expect(suggest("git ", true, recent)).toBe("push origin main")
  })

  it("suggests slash command names once the buffer starts with /", () => {
    expect(suggest("/co", true, sources)).toBe("py")
  })

  it("does not cross sources (text buffer ignores commands)", () => {
    expect(suggest("/cl", true, { history: ["/clearly nope"], commands: ["/clear"] })).toBe("ear")
  })

  it("returns null when nothing matches", () => {
    expect(suggest("xyz", true, sources)).toBeNull()
  })

  it("returns null for an exact match (no remaining suffix)", () => {
    expect(suggest("npm test", true, sources)).toBeNull()
  })

  it("is suppressed when the cursor is not at the line end", () => {
    expect(suggest("git ", false, sources)).toBeNull()
  })

  it("is suppressed for an empty buffer", () => {
    expect(suggest("", true, sources)).toBeNull()
  })

  it("is suppressed for a multiline buffer", () => {
    expect(suggest("git \nstatus", true, sources)).toBeNull()
  })
})
