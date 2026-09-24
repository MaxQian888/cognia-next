import { avatarColor, avatarGlyph, deterministicColor, initials } from "./avatar"

describe("initials", () => {
  it("returns ? for empty name", () => {
    expect(initials("")).toBe("?")
    expect(initials("   ")).toBe("?")
  })

  it("returns 2 chars for single-word names", () => {
    expect(initials("Claude")).toBe("CL")
  })

  it("uses one char for one-letter words", () => {
    expect(initials("X")).toBe("X")
  })

  it("returns first+last for multi-word names", () => {
    expect(initials("Coding Assistant")).toBe("CA")
    expect(initials("alice bob carol")).toBe("AC")
  })

  it("uppercases the result", () => {
    expect(initials("alice")).toBe("AL")
    expect(initials("alice bob")).toBe("AB")
  })

  it("treats multiple internal spaces as one delimiter", () => {
    expect(initials("Code   Reviewer  ")).toBe("CR")
  })
})

describe("deterministicColor", () => {
  it("returns the same color for the same seed", () => {
    expect(deterministicColor("hello")).toBe(deterministicColor("hello"))
  })

  it("returns different colors for different seeds", () => {
    // Not strictly guaranteed but very likely with a 360-bucket hue.
    const a = deterministicColor("alice")
    const b = deterministicColor("zoe")
    expect(a).not.toBe(b)
  })

  it("returns a valid oklch string", () => {
    const c = deterministicColor("test")
    expect(c).toMatch(/^oklch\(0\.7 0\.14 \d+(\.\d+)?\)$/)
  })

  it("handles empty seed", () => {
    expect(deterministicColor("")).toMatch(/^oklch\(/)
  })
})

describe("initials — what counts as the name", () => {
  // A title's trailing "#399" made the glyph "D#".
  it.each([
    ["Document mobile tab bar #399", "DB"],
    ["(draft) plan", "DP"],
    ["🚀 Launch plan", "LP"],
    ["Refactor: the sync layer", "RL"],
    ["#399", "39"],
    ["2026 roadmap", "RO"],
    ["修复移动端标签栏", "修复"],
    ["中文 标题", "中标"],
    ["!!!", "!!"],
    ["🚀", "🚀"],
  ])("%s → %s", (name, glyph) => {
    expect(initials(name)).toBe(glyph)
  })

  it("never splits a character outside the BMP", () => {
    expect(initials("𝒜lice 𝒞arter")).toBe("𝒜𝒞")
  })
})

describe("avatarGlyph", () => {
  it("prefers explicit emoji", () => {
    expect(avatarGlyph({ name: "Coder", avatarEmoji: "💻" })).toBe("💻")
  })

  it("falls back to initials when no emoji", () => {
    expect(avatarGlyph({ name: "Coder" })).toBe("CO")
    expect(avatarGlyph({ name: "Code Reviewer" })).toBe("CR")
  })
})

describe("avatarColor", () => {
  it("prefers explicit avatarColor", () => {
    expect(avatarColor({ name: "Coder", avatarColor: "oklch(0.5 0.2 100)" })).toBe(
      "oklch(0.5 0.2 100)"
    )
  })

  it("falls back to deterministicColor when none set", () => {
    const result = avatarColor({ name: "Coder" })
    expect(result).toBe(deterministicColor("Coder"))
  })
})
