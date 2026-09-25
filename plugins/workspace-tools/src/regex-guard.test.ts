import {
  SEARCH_MAX_PATTERN_LENGTH,
  SEARCH_MAX_TESTED_LINE_CHARS,
  checkSearchPattern,
} from "./regex-guard"

describe("checkSearchPattern", () => {
  it.each([
    "foo",
    "\\bTODO\\b",
    "fn\\s+\\w+\\(",
    "(foo|bar)+",
    "(?:ab)+",
    "(a+)?",
    "(a{2,3})+",
    "[(+*)]+",
    "a\\(b+\\)+",
    "(?<name>\\d+)-x",
    "(?<=a)b+",
    "\\d{4}-\\d{2}",
  ])("accepts %s", (pattern) => {
    expect(checkSearchPattern(pattern)).toEqual({ ok: true })
  })

  it.each([
    "(a+)+",
    "(a*)*",
    "(\\w+\\s?)+$",
    "((ab)*)+",
    "(?:x+y?)*",
    "([a-z]+)*",
    "(a+){2,}",
    "(\\d{1,100})+",
    "((a+))+",
  ])("rejects the nested quantifier in %s", (pattern) => {
    expect(checkSearchPattern(pattern)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nested quantifiers/),
    })
  })

  it.each(["(a+){1,10}$", "(\\w+){1,3}$", "(.*a){8}", "(a+){2}"])(
    "rejects the bounded repeat of a quantified group in %s",
    (pattern) => {
      expect(checkSearchPattern(pattern)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/nested quantifiers/),
      })
    }
  )

  it.each(["(a|aa)+$", "(a|a)+$", "(\\w|\\d)+$", "(?:a|a)*b", "(a|)+", "(A|a)+"])(
    "rejects the overlapping repeated alternation in %s",
    (pattern) => {
      expect(checkSearchPattern(pattern)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/repeated alternation/),
      })
    }
  )

  it.each(["\\w*\\w*\\w*!", ".*.*.*.*x", ".*a.*b.*z", "\\S+[^x]*\\W+"])(
    "rejects the stacked wildcards in %s",
    (pattern) => {
      expect(checkSearchPattern(pattern)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/unbounded wildcards/),
      })
    }
  )

  it.each(["(a|b)+", ".*a.*b", "\\w+\\s*=\\s*\\w+\\s*;", "function\\s+\\w+\\s*\\("])(
    "still accepts the everyday search %s",
    (pattern) => {
      expect(checkSearchPattern(pattern)).toEqual({ ok: true })
    }
  )

  it.each(["(a)\\1", "(?<x>a)\\k<x>"])("rejects the backreference in %s", (pattern) => {
    expect(checkSearchPattern(pattern)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/backreferences/),
    })
  })

  it("rejects an over-long pattern", () => {
    expect(checkSearchPattern("a".repeat(SEARCH_MAX_PATTERN_LENGTH + 1))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/limit/),
    })
    expect(checkSearchPattern("a".repeat(SEARCH_MAX_PATTERN_LENGTH))).toEqual({ ok: true })
  })

  it("leaves syntax errors to the RegExp constructor", () => {
    expect(checkSearchPattern("(")).toEqual({ ok: true })
    expect(checkSearchPattern("[abc")).toEqual({ ok: true })
  })

  it("keeps the tested line window bounded", () => {
    expect(SEARCH_MAX_TESTED_LINE_CHARS).toBeGreaterThan(0)
    expect(SEARCH_MAX_TESTED_LINE_CHARS).toBeLessThanOrEqual(2_000)
  })
})
