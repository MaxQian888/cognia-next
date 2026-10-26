import {
  compileCommandPattern,
  compileMatcher,
  describeMatcher,
  globToRegExp,
  MAX_PATTERN_CHARS,
  parseMatcher,
  pathMatchesGlob,
  UnsafePatternError,
} from "./checks"

describe("compileCommandPattern", () => {
  it("compiles simple patterns", () => {
    expect(compileCommandPattern("^pnpm (test|vitest)").test("pnpm test --run")).toBe(true)
  })

  it("refuses nested quantifiers, back-references, lookbehind, long and broken patterns", () => {
    for (const pattern of [
      "(a+)+$",
      "(.*)*x",
      "(\\w+){2,}",
      "(a)\\1",
      "(?<=x)y",
      "x".repeat(MAX_PATTERN_CHARS + 1),
      "(",
      "",
    ]) {
      expect(() => compileCommandPattern(pattern)).toThrow(UnsafePatternError)
    }
  })
})

describe("globs", () => {
  it("translates ** across directories and * within one", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true)
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true)
    expect(globToRegExp("src/*.ts").test("src/a/c.ts")).toBe(false)
    expect(globToRegExp("a?.md").test("ab.md")).toBe(true)
    expect(globToRegExp("a.md").test("aXmd")).toBe(false)
  })

  it("matches base names, root-relative paths and suffixes of foreign paths", () => {
    expect(pathMatchesGlob("/repo/src/x.generated.ts", "*.generated.ts")).toBe(true)
    expect(pathMatchesGlob("/repo/src/x.ts", "src/**", ["/repo"])).toBe(true)
    expect(pathMatchesGlob("/repo/lib/x.ts", "src/**", ["/repo"])).toBe(false)
    expect(pathMatchesGlob("/elsewhere/proj/src/x.ts", "src/*.ts")).toBe(true)
    expect(pathMatchesGlob("C:\\repo\\src\\x.ts", "src/*.ts")).toBe(true)
    expect(pathMatchesGlob("./src/x.ts", "src/*.ts")).toBe(true)
  })
})

describe("matchers", () => {
  it("matches family, command and path together", () => {
    const matcher = compileMatcher({ family: "shell", command: "^git push" })
    expect(
      matcher.matches({ family: "shell", tool: "bash", command: "git push origin", paths: [] })
    ).toBe(true)
    expect(matcher.matches({ family: "shell", tool: "bash", paths: [] })).toBe(false)
    expect(matcher.matches({ family: "edit", tool: "edit", command: "git push", paths: [] })).toBe(
      false
    )
    const edits = compileMatcher({ family: "edit", pathGlob: "*.lock" })
    expect(edits.matches({ family: "edit", tool: "edit", paths: ["a/pnpm-lock.lock"] })).toBe(true)
    expect(edits.matches({ family: "edit", tool: "edit", paths: ["a.ts"] })).toBe(false)
  })

  it("parses untrusted matchers and rejects unusable ones", () => {
    expect(parseMatcher({ family: "shell", command: " ^npm " })).toEqual({
      family: "shell",
      command: "^npm",
    })
    expect(parseMatcher({ family: "any" })).toBeUndefined()
    expect(parseMatcher({ family: "network", command: "x" })).toBeUndefined()
    expect(parseMatcher({ family: "shell", command: "(a+)+" })).toBeUndefined()
    expect(parseMatcher(null)).toBeUndefined()
    expect(parseMatcher({ command: "^make" })).toEqual({ family: "any", command: "^make" })
  })

  it("describes matchers", () => {
    expect(describeMatcher({ family: "edit", pathGlob: "src/**", command: "x" })).toBe(
      "edit src/** /x/"
    )
    expect(describeMatcher({ family: "shell" }, (family) => `[${family}]`)).toBe("[shell]")
  })
})
