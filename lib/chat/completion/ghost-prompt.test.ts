import { buildGhostPrompt, sanitizeGhost, MAX_GHOST_LEN } from "./ghost-prompt"

describe("buildGhostPrompt", () => {
  it("includes the draft and a system prompt", () => {
    const { system, prompt } = buildGhostPrompt({ draft: "write a function that" })
    expect(system).toMatch(/inline autocomplete/i)
    expect(prompt).toContain("Partial message to continue:")
    expect(prompt).toContain("write a function that")
  })

  it("adds recent conversation context with role labels", () => {
    const { prompt } = buildGhostPrompt({
      draft: "and then",
      recentMessages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
      ],
    })
    expect(prompt).toContain("Recent conversation:")
    expect(prompt).toContain("User: hello")
    expect(prompt).toContain("Assistant: hi there")
  })

  it("keeps only the most recent messages and drops blanks", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      text: `msg-${i}`,
    }))
    messages.push({ role: "user", text: "   " })
    const { prompt } = buildGhostPrompt({ draft: "x", recentMessages: messages })
    expect(prompt).not.toContain("msg-0")
    expect(prompt).toContain("msg-9")
  })

  it("omits the conversation block when there is no usable history", () => {
    const { prompt } = buildGhostPrompt({
      draft: "x",
      recentMessages: [{ role: "user", text: "" }],
    })
    expect(prompt).not.toContain("Recent conversation:")
  })
})

describe("sanitizeGhost", () => {
  it("returns the continuation verbatim", () => {
    expect(sanitizeGhost(" returns the sum", "add two numbers that")).toBe(" returns the sum")
  })

  it("returns null for an empty reply", () => {
    expect(sanitizeGhost("", "x")).toBeNull()
  })

  it("strips markdown fences", () => {
    expect(sanitizeGhost("```\n suffix text\n```", "draft")).toBe(" suffix text")
  })

  it("takes only the first line", () => {
    expect(sanitizeGhost(" first line\nsecond line", "draft")).toBe(" first line")
  })

  it("strips a leading newline before reading the first line", () => {
    expect(sanitizeGhost("\n the real suffix", "draft")).toBe(" the real suffix")
  })

  it("strips an echoed input prefix", () => {
    expect(sanitizeGhost("hello world and more", "hello world")).toBe(" and more")
  })

  it("returns null when the model only echoes the input", () => {
    expect(sanitizeGhost("hello", "hello")).toBeNull()
  })

  it("trims trailing whitespace but keeps a leading space", () => {
    expect(sanitizeGhost("  done   ", "draft")).toBe("  done")
  })

  it("truncates an over-long suffix to the cap", () => {
    const long = " " + "x".repeat(MAX_GHOST_LEN + 50)
    const out = sanitizeGhost(long, "draft")
    expect(out).toHaveLength(MAX_GHOST_LEN)
  })
})
