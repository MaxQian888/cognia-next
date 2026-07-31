import { shellEscape } from "./shell-escape"

describe("shellEscape", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellEscape("https://example.com")).toBe("'https://example.com'")
    expect(shellEscape("./local-app")).toBe("'./local-app'")
  })

  it("neutralizes shell metacharacters", () => {
    expect(shellEscape("a; rm -rf /")).toBe("'a; rm -rf /'")
    expect(shellEscape("$(whoami)")).toBe("'$(whoami)'")
    expect(shellEscape("a && b || c `d`")).toBe("'a && b || c `d`'")
  })

  it("escapes embedded single quotes via the '\\'' idiom", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'")
    expect(shellEscape("'")).toBe("''\\'''")
  })

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''")
  })
})
