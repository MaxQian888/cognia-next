import { shellUsesBackslashEscapes, tokenAtCursor, tokenize } from "./tokenize"

describe("tokenize", () => {
  it("splits on unquoted whitespace", () => {
    const tokens = tokenize("git commit -m msg")
    expect(tokens.map((t) => t.value)).toEqual(["git", "commit", "-m", "msg"])
    expect(tokens[1]).toMatchObject({ start: 4, end: 10, raw: "commit" })
  })

  it("groups double-quoted spans, preserving raw text", () => {
    const tokens = tokenize('git commit -m "fix: a bug"')
    expect(tokens[3].value).toBe("fix: a bug")
    expect(tokens[3].raw).toBe('"fix: a bug"')
  })

  it("groups single-quoted spans", () => {
    const tokens = tokenize("echo 'a b' c")
    expect(tokens.map((t) => t.value)).toEqual(["echo", "a b", "c"])
  })

  it("runs an unterminated quote to end of line", () => {
    const tokens = tokenize('cd "My F')
    expect(tokens[1].value).toBe("My F")
    expect(tokens[1].raw).toBe('"My F')
  })

  it("treats backslash as a plain char without the POSIX flag", () => {
    const tokens = tokenize("cd C:\\Users\\me")
    expect(tokens[1].value).toBe("C:\\Users\\me")
  })

  it("escapes spaces with the POSIX flag", () => {
    const tokens = tokenize("cd My\\ Folder", { backslashEscapes: true })
    expect(tokens).toHaveLength(2)
    expect(tokens[1].value).toBe("My Folder")
    expect(tokens[1].raw).toBe("My\\ Folder")
  })

  it("handles escaped quotes inside double quotes (POSIX)", () => {
    const tokens = tokenize('echo "a \\" b"', { backslashEscapes: true })
    expect(tokens[1].value).toBe('a " b')
  })

  it("returns [] for an empty line", () => {
    expect(tokenize("")).toEqual([])
    expect(tokenize("   ")).toEqual([])
  })
})

describe("tokenAtCursor", () => {
  it("finds the token containing the cursor", () => {
    const at = tokenAtCursor("git che", 7)
    expect(at?.token.value).toBe("che")
    expect(at?.index).toBe(1)
  })

  it("returns a fresh empty token on trailing whitespace", () => {
    const at = tokenAtCursor("cd ", 3)
    expect(at?.token).toEqual({ raw: "", value: "", start: 3, end: 3 })
    expect(at?.index).toBe(1)
  })

  it("returns the empty head token for an empty line", () => {
    const at = tokenAtCursor("", 0)
    expect(at?.token.value).toBe("")
    expect(at?.index).toBe(0)
  })

  it("returns null when the cursor is out of bounds", () => {
    expect(tokenAtCursor("ls", 5)).toBeNull()
    expect(tokenAtCursor("ls", -1)).toBeNull()
  })
})

describe("shellUsesBackslashEscapes", () => {
  it("is true for POSIX shells and false for Windows-style shells", () => {
    expect(shellUsesBackslashEscapes("bash")).toBe(true)
    expect(shellUsesBackslashEscapes("zsh")).toBe(true)
    expect(shellUsesBackslashEscapes("fish")).toBe(true)
    expect(shellUsesBackslashEscapes("pwsh")).toBe(false)
    expect(shellUsesBackslashEscapes("powershell")).toBe(false)
    expect(shellUsesBackslashEscapes("cmd")).toBe(false)
    expect(shellUsesBackslashEscapes("nu")).toBe(false)
  })
})
