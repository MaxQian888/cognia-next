import {
  isToolDenied,
  isToolExplicitlyDenied,
  isToolPattern,
  isToolRuleTightening,
  matchesToolPattern,
  matchingToolPatterns,
  normalizeToolRuleList,
  resolveDeniedToolNames,
  toolDenyReason,
  toolPatternToRegExp,
} from "./tool-rules"

describe("normalizeToolRuleList", () => {
  it("trims, drops blanks, de-duplicates and sorts", () => {
    expect(normalizeToolRuleList([" b ", "a", "", "  ", "a"])).toEqual(["a", "b"])
  })

  it("treats undefined as empty", () => {
    expect(normalizeToolRuleList(undefined)).toEqual([])
  })
})

describe("isToolPattern", () => {
  it.each([
    ["write_*", true],
    ["browser_?", true],
    ["browser_evaluate", false],
  ])("%s -> %s", (value, expected) => {
    expect(isToolPattern(value)).toBe(expected)
  })
})

describe("toolPatternToRegExp", () => {
  it("anchors the pattern so a substring does not match", () => {
    expect(toolPatternToRegExp("write").test("overwrite_file")).toBe(false)
  })

  it("escapes regexp metacharacters so a pasted rule cannot inject syntax", () => {
    expect(toolPatternToRegExp("a.b").test("axb")).toBe(false)
    expect(toolPatternToRegExp("a.b").test("a.b")).toBe(true)
    expect(toolPatternToRegExp("a+b").test("a+b")).toBe(true)
  })
})

describe("matchesToolPattern", () => {
  it("expands * across any run and ? across one character", () => {
    expect(matchesToolPattern("write_file", "write_*")).toBe(true)
    expect(matchesToolPattern("write_file", "write_????")).toBe(true)
    expect(matchesToolPattern("write_file", "write_???")).toBe(false)
  })

  it("matches case-insensitively", () => {
    expect(matchesToolPattern("Browser_Evaluate", "browser_*")).toBe(true)
  })

  it("never matches on a blank pattern", () => {
    expect(matchesToolPattern("anything", "   ")).toBe(false)
  })
})

describe("matchingToolPatterns / toolDenyReason", () => {
  const rules = {
    disallowedTools: ["browser_evaluate"],
    disallowedToolPatterns: ["write_*", "*_unsafe"],
  }

  it("reports every pattern that denies the tool", () => {
    expect(matchingToolPatterns("write_unsafe", rules)).toEqual(["*_unsafe", "write_*"])
  })

  it("prefers the explicit reason when both axes deny", () => {
    expect(toolDenyReason("browser_evaluate", rules)).toBe("explicit")
    expect(toolDenyReason("write_file", rules)).toBe("pattern")
    expect(toolDenyReason("read_file", rules)).toBe("allowed")
  })

  it("distinguishes explicit from pattern denial", () => {
    expect(isToolExplicitlyDenied("browser_evaluate", rules)).toBe(true)
    expect(isToolExplicitlyDenied("write_file", rules)).toBe(false)
    expect(isToolDenied("write_file", rules)).toBe(true)
  })
})

describe("resolveDeniedToolNames", () => {
  it("unions pinned names with every known tool a pattern matches", () => {
    expect(
      resolveDeniedToolNames(
        { disallowedTools: ["browser_evaluate"], disallowedToolPatterns: ["write_*"] },
        ["write_file", "write_dir", "read_file", "browser_evaluate"]
      )
    ).toEqual(["browser_evaluate", "write_dir", "write_file"])
  })

  it("expands nothing when no tools have been discovered yet", () => {
    expect(resolveDeniedToolNames({ disallowedToolPatterns: ["write_*"] })).toEqual([])
  })

  it("still returns pinned names without a capability list", () => {
    expect(resolveDeniedToolNames({ disallowedTools: [" danger "] })).toEqual(["danger"])
  })
})

describe("isToolRuleTightening", () => {
  const known = ["write_file", "read_file", "browser_evaluate"]

  it("accepts adding an exact denial", () => {
    expect(isToolRuleTightening({}, { disallowedTools: ["write_file"] }, known)).toBe(true)
  })

  it("rejects removing an exact denial", () => {
    expect(isToolRuleTightening({ disallowedTools: ["write_file"] }, {}, known)).toBe(false)
  })

  it("accepts replacing pinned names with a pattern that still covers them", () => {
    expect(
      isToolRuleTightening(
        { disallowedTools: ["write_file"] },
        { disallowedToolPatterns: ["write_*"] },
        known
      )
    ).toBe(true)
  })

  it("rejects dropping a pattern even when no known tool matched it", () => {
    expect(isToolRuleTightening({ disallowedToolPatterns: ["future_*"] }, {}, known)).toBe(false)
  })

  it("accepts a no-op edit", () => {
    const rules = { disallowedTools: ["a"], disallowedToolPatterns: ["b_*"] }
    expect(isToolRuleTightening(rules, rules, known)).toBe(true)
  })
})
