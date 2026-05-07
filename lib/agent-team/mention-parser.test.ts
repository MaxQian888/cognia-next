import { parseLeadingMention, type MentionCandidate } from "./mention-parser"

const candidates: MentionCandidate[] = [
  { id: "v-claude", name: "claude" },
  { id: "v-codex", name: "codex" },
  { id: "tm-1", name: "Alice" },
  { id: "tm-2", name: "BobBackend" },
]

describe("parseLeadingMention", () => {
  it("matches a virtual mention at the start", () => {
    const result = parseLeadingMention("@codex write me a sort", candidates)
    expect(result.matchedName).toBe("codex")
    expect(result.matchedId).toBe("v-codex")
    expect(result.remainder).toBe("write me a sort")
    expect(result.unknownMention).toBe(false)
    expect(result.rawToken).toBe("@codex")
  })

  it("matches a teammate mention case-insensitively", () => {
    const result = parseLeadingMention("@alice review this PR", candidates)
    expect(result.matchedName).toBe("Alice")
    expect(result.matchedId).toBe("tm-1")
    expect(result.remainder).toBe("review this PR")
  })

  it("returns unknownMention when the name isn't in the list", () => {
    const result = parseLeadingMention("@nobody hi", candidates)
    expect(result.matchedName).toBeNull()
    expect(result.matchedId).toBeNull()
    expect(result.unknownMention).toBe(true)
    expect(result.rawToken).toBe("@nobody")
    expect(result.remainder).toBe("hi")
  })

  it("ignores leading whitespace before the mention", () => {
    const result = parseLeadingMention("   @claude what's up", candidates)
    expect(result.matchedName).toBe("claude")
    expect(result.remainder).toBe("what's up")
  })

  it("does not match a mention in the middle of a message", () => {
    const result = parseLeadingMention("hello @codex", candidates)
    expect(result.matchedName).toBeNull()
    expect(result.unknownMention).toBe(false)
    expect(result.remainder).toBe("hello @codex")
    expect(result.rawToken).toBeNull()
  })

  it("treats only the first @ as the mention; following @s become prompt content", () => {
    const result = parseLeadingMention("@alice @bob both look at this", candidates)
    expect(result.matchedName).toBe("Alice")
    expect(result.remainder).toBe("@bob both look at this")
  })

  it("handles a mention with no remainder", () => {
    const result = parseLeadingMention("@codex", candidates)
    expect(result.matchedName).toBe("codex")
    expect(result.remainder).toBe("")
  })

  it("returns the no-match shape for empty text", () => {
    const result = parseLeadingMention("", candidates)
    expect(result.matchedName).toBeNull()
    expect(result.matchedId).toBeNull()
    expect(result.remainder).toBe("")
    expect(result.unknownMention).toBe(false)
    expect(result.rawToken).toBeNull()
  })

  it("returns the no-match shape for whitespace-only text", () => {
    const result = parseLeadingMention("   \n  ", candidates)
    expect(result.matchedName).toBeNull()
    expect(result.remainder).toBe("")
    expect(result.unknownMention).toBe(false)
  })

  it("returns no match when the leading char isn't @", () => {
    const result = parseLeadingMention("hi", candidates)
    expect(result.matchedName).toBeNull()
    expect(result.remainder).toBe("hi")
    expect(result.unknownMention).toBe(false)
  })

  it("treats a bare @ as a no-mention", () => {
    const result = parseLeadingMention("@ what?", candidates)
    expect(result.matchedName).toBeNull()
    expect(result.unknownMention).toBe(false)
    expect(result.rawToken).toBeNull()
  })

  it("preserves multi-line content in the remainder", () => {
    const result = parseLeadingMention("@alice line1\nline2\nline3", candidates)
    expect(result.matchedName).toBe("Alice")
    expect(result.remainder).toBe("line1\nline2\nline3")
  })

  it("returns the first candidate when names collide (callers should de-dup)", () => {
    const dupes: MentionCandidate[] = [
      { id: "first", name: "Same" },
      { id: "second", name: "same" },
    ]
    const result = parseLeadingMention("@same hi", dupes)
    expect(result.matchedId).toBe("first")
  })
})
