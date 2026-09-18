/**
 * Tests for the RE2-subset validator and cached evaluator used by the `regex`
 * trigger rule. The contract that matters: anything `validateSafePattern`
 * accepts must be evaluable in polynomial time on capped input; anything it
 * rejects must fail closed (never match, never throw).
 */

import {
  compileSafePattern,
  REGEX_INPUT_CAP,
  REGEX_PATTERN_CAP,
  safePatternTest,
  validateSafePattern,
} from "./safe-pattern"

describe("validateSafePattern — accepts", () => {
  it.each([
    "deploy",
    "deploy.*(failed|succeeded)",
    "\\bbug\\b",
    "(a|b)+",
    "a{2,5}",
    "x[a-z0-9]+y",
    "^urgent|^p0",
    "\\d+ errors?",
    "(?i:DEPLOY)",
    "(?<word>foo)\\w*",
    "\\p{L}+",
    "a\\x20b",
    "(a?)+", // bounded inner quantifier — empty-match loops end in one pass
    "(a{2,4})+",
    "a.*b.*c", // sequential unbounded quantifiers are linear, not nested
    "\\w+\\s\\w+",
  ])("accepts %j", (source) => {
    expect(validateSafePattern(source)).toBeNull()
  })

  it("accepts a pattern at the length cap exactly", () => {
    expect(validateSafePattern("a".repeat(REGEX_PATTERN_CAP))).toBeNull()
  })
})

describe("validateSafePattern — rejects", () => {
  it("rejects a pattern over the length cap", () => {
    expect(validateSafePattern("a".repeat(REGEX_PATTERN_CAP + 1))).toBe("too-long")
  })

  it.each(["(", "a**", "[a-", "*x"])("rejects invalid syntax %j", (source) => {
    expect(validateSafePattern(source)).toBe("invalid-syntax")
  })

  it.each(["foo(?=bar)", "(?!x)y", "(?<=x)y", "(?<!x)y"])("rejects lookaround %j", (source) => {
    expect(validateSafePattern(source)).toBe("lookaround")
  })

  it.each(["(a)\\1", "(?<n>a)\\k<n>", "\\2"])("rejects backreference %j", (source) => {
    expect(validateSafePattern(source)).toBe("backreference")
  })

  it.each([
    "(a+)+",
    "(a*)*",
    "(\\w+\\s?)*",
    "(a|b+)*",
    "((a+))+",
    "(?:a+)*",
    "(a+){2,}",
    "((x)|(y+))+",
  ])("rejects nested unbounded quantifier %j", (source) => {
    expect(validateSafePattern(source)).toBe("nested-quantifier")
  })

  it("rejects a quantified group containing an unbounded class quantifier", () => {
    expect(validateSafePattern("([a-z]+\\d)*")).toBe("nested-quantifier")
  })
})

describe("safePatternTest", () => {
  it("matches a substring by default", () => {
    expect(safePatternTest("deploy", false, "the deploy finished")).toBe(true)
    expect(safePatternTest("deploy", false, "nothing here")).toBe(false)
  })

  it("honours caseInsensitive", () => {
    expect(safePatternTest("DEPLOY", true, "the deploy finished")).toBe(true)
    expect(safePatternTest("DEPLOY", false, "the deploy finished")).toBe(false)
  })

  it("evaluates full pattern semantics", () => {
    expect(safePatternTest("^p[012]\\b", false, "p1 — disk full")).toBe(true)
    expect(safePatternTest("^p[012]\\b", false, "a p1 issue")).toBe(false)
  })

  it("fails closed on a rejected pattern", () => {
    expect(safePatternTest("(a+)+", false, "aaaaaaaaaa")).toBe(false)
    expect(safePatternTest("foo(?=bar)", false, "foobar")).toBe(false)
  })

  it("fails closed on invalid syntax", () => {
    expect(safePatternTest("(", false, "anything")).toBe(false)
  })

  it("sees only the first REGEX_INPUT_CAP characters", () => {
    const text = `${"x".repeat(REGEX_INPUT_CAP)}needle`
    // `needle` sits beyond the cap — the rule under-matches rather than
    // scanning unbounded text.
    expect(safePatternTest("needle$", false, text)).toBe(false)
    expect(safePatternTest("x+", false, text)).toBe(true)
  })
})

describe("compileSafePattern", () => {
  it("caches compiled patterns and rejections", () => {
    const a = compileSafePattern("cache-me", false)
    const b = compileSafePattern("cache-me", false)
    expect(a).toBe(b)
    expect(compileSafePattern("(a+)+", false)).toBeNull()
  })

  it("keys the cache by case sensitivity", () => {
    expect(compileSafePattern("caseflag", false)).not.toBe(compileSafePattern("caseflag", true))
  })
})
