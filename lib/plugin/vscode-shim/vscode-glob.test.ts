import { MAX_GLOB_LENGTH, matchesGlob, matchesGlobOrParent } from "./vscode-glob"

describe("VS Code globs", () => {
  it.each([
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "src/deep/a.ts", true],
    ["**/*.ts", "/abs/path/a.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/x/y/a.ts", true],
    ["src/**/*.ts", "lib/a.ts", false],
    ["src/**", "src", true],
    ["src/**", "src/a/b", true],
    ["src/**", "srcx/a", false],
    ["**", "anything/at/all", true],
    ["a?c", "abc", true],
    ["a?c", "a/c", false],
    ["*.{ts,tsx}", "a.tsx", true],
    ["*.{ts,tsx}", "a.js", false],
    ["{src,lib}/**/*.js", "lib/x/a.js", true],
    ["{**/node_modules/**,*.log}", "pkg/node_modules/x/y.js", true],
    ["{**/node_modules/**,*.log}", "a.log", true],
    ["file.[jt]s", "file.js", true],
    ["file.[!jt]s", "file.js", false],
    ["file.[!jt]s", "file.cs", true],
    ["[a-c]x", "bx", true],
    ["a[/]b", "a/b", false],
    ["a.b+c(1)", "a.b+c(1)", true],
    ["a.b", "axb", false],
    ["unclosed[", "unclosed[", true],
    ["Case.ts", "case.ts", false],
  ])("%s against %s → %s", (glob, path, expected) => {
    expect(matchesGlob(glob, path)).toBe(expected)
  })

  it("accepts Windows separators", () => {
    expect(matchesGlob("**\\*.ts", "src\\a.ts")).toBe(true)
  })

  it("matches a path whose parent directory matches, for excludes", () => {
    expect(matchesGlobOrParent("**/.git", "repo/.git/objects/ab")).toBe(true)
    expect(matchesGlobOrParent("**/.git", "repo/.github/workflow.yml")).toBe(false)
    expect(matchesGlobOrParent("node_modules", "node_modules/x/index.js")).toBe(true)
  })

  it("refuses over-long patterns", () => {
    expect(() => matchesGlob("a".repeat(MAX_GLOB_LENGTH + 1), "a")).toThrow(/longer than/)
  })
})
