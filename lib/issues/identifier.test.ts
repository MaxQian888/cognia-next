import {
  deriveProjectKey,
  extractIssueIdentifiers,
  formatIssueIdentifier,
  isValidProjectKey,
  parseIssueIdentifier,
  PROJECT_KEY_MAX_LENGTH,
  suggestProjectKey,
} from "./identifier"

describe("isValidProjectKey", () => {
  it.each(["AB", "COG", "COGN", "MERC1", "A1B2C"])("accepts %s", (key) => {
    expect(isValidProjectKey(key)).toBe(true)
  })

  it.each([
    ["A", "too short"],
    ["ABCDEF", "too long"],
    ["1AB", "leading digit"],
    ["ab", "lowercase"],
    ["A-B", "punctuation"],
    ["", "empty"],
  ])("rejects %s (%s)", (key) => {
    expect(isValidProjectKey(key)).toBe(false)
  })
})

describe("suggestProjectKey", () => {
  it("takes initials when the name has several words", () => {
    expect(suggestProjectKey("Mobile Rewrite")).toBe("MR")
    expect(suggestProjectKey("Q3 Launch Plan")).toBe("QLP")
  })

  it("caps initials at the max key length", () => {
    expect(suggestProjectKey("A B C D E F G")).toHaveLength(PROJECT_KEY_MAX_LENGTH)
  })

  it("takes a prefix for a single word", () => {
    expect(suggestProjectKey("Cognia")).toBe("COGN")
    expect(suggestProjectKey("Q3")).toBe("Q3")
  })

  it("ignores punctuation and casing", () => {
    expect(suggestProjectKey("  cognia-next  ")).toBe("CN")
  })

  it("falls back when the name yields no usable latin letters", () => {
    expect(suggestProjectKey("认知")).toBe("PRJ")
    expect(suggestProjectKey("")).toBe("PRJ")
  })

  it("falls back when the derived candidate would start with a digit", () => {
    expect(suggestProjectKey("2026")).toBe("PRJ")
  })

  it("falls back when the derived candidate is a single character", () => {
    expect(suggestProjectKey("A")).toBe("PRJ")
  })

  it("always returns a valid key", () => {
    for (const name of ["Cognia", "Mobile Rewrite", "认知", "2026", "A", ""]) {
      expect(isValidProjectKey(suggestProjectKey(name))).toBe(true)
    }
  })
})

describe("deriveProjectKey", () => {
  it("returns the suggestion when it is free", () => {
    expect(deriveProjectKey("Cognia", new Set())).toBe("COGN")
  })

  it("appends a discriminator on collision, staying within the length cap", () => {
    const key = deriveProjectKey("Cognia", new Set(["COGN"]))
    expect(key).toBe("COGN2")
    expect(isValidProjectKey(key)).toBe(true)
  })

  it("keeps walking past several collisions", () => {
    const key = deriveProjectKey("Cognia", new Set(["COGN", "COGN2", "COGN3"]))
    expect(key).toBe("COGN4")
  })

  it("truncates the base so a two-digit discriminator still fits", () => {
    const taken = new Set(["COGN"])
    for (let i = 2; i <= 9; i += 1) taken.add(`COGN${i}`)
    const key = deriveProjectKey("Cognia", taken)
    expect(key).toBe("COG10")
    expect(key.length).toBeLessThanOrEqual(PROJECT_KEY_MAX_LENGTH)
  })

  it("never returns a key that is already taken", () => {
    const taken = new Set(["MR"])
    expect(taken.has(deriveProjectKey("Mobile Rewrite", taken))).toBe(false)
  })
})

describe("formatIssueIdentifier / parseIssueIdentifier", () => {
  it("round-trips", () => {
    const identifier = formatIssueIdentifier("MERC", 2)
    expect(identifier).toBe("MERC-2")
    expect(parseIssueIdentifier(identifier)).toEqual({ projectKey: "MERC", issueNumber: 2 })
  })

  it("tolerates surrounding whitespace", () => {
    expect(parseIssueIdentifier("  COG-11 ")).toEqual({ projectKey: "COG", issueNumber: 11 })
  })

  it.each([
    ["owner/repo#123", "a GitHub ref must not parse as a local identifier"],
    ["merc-2", "lowercase"],
    ["MERC-0", "numbers start at 1"],
    ["MERC-", "missing number"],
    ["-2", "missing key"],
    ["MERCURY-2", "key too long"],
  ])("rejects %s (%s)", (input) => {
    expect(parseIssueIdentifier(input)).toBeUndefined()
  })
})

describe("extractIssueIdentifiers", () => {
  it("finds every distinct identifier in order of appearance", () => {
    const text = "fix MERC-2 then COG-11; MERC-2 again"
    expect(extractIssueIdentifiers(text)).toEqual(["MERC-2", "COG-11"])
  })

  it("returns an empty list when there is nothing to find", () => {
    expect(extractIssueIdentifiers("no identifiers here")).toEqual([])
  })

  it("does not match GitHub refs", () => {
    expect(extractIssueIdentifiers("see owner/repo#123")).toEqual([])
  })
})
