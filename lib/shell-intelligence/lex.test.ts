import { isEnvAssignment, lexCommandLine } from "./lex"

/** Compact shape for assertions: kind, value, and the exact source range. */
const shape = (line: string, opts?: Parameters<typeof lexCommandLine>[1]) =>
  lexCommandLine(line, opts).map((t) => [t.kind, t.value, t.start, t.end] as const)

describe("lexCommandLine", () => {
  it("lexes a plain command with arguments and exact ranges", () => {
    expect(shape("ls -la src")).toEqual([
      ["word", "ls", 0, 2],
      ["word", "-la", 3, 6],
      ["word", "src", 7, 10],
    ])
  })

  it("keeps a quoted span as one word and unquotes the value", () => {
    expect(shape(`echo "hello world"`)).toEqual([
      ["word", "echo", 0, 4],
      ["word", "hello world", 5, 18],
    ])
    expect(shape(`echo 'a b'`)).toEqual([
      ["word", "echo", 0, 4],
      ["word", "a b", 5, 10],
    ])
  })

  it("honours backslash escapes for POSIX shells and not otherwise", () => {
    expect(shape(String.raw`cat My\ File`)).toEqual([
      ["word", "cat", 0, 3],
      ["word", "My File", 4, 12],
    ])
    // Windows shells: `\` is a path separator, so the space still splits.
    expect(shape(String.raw`cat My\ File`, { backslashEscapes: false })).toEqual([
      ["word", "cat", 0, 3],
      ["word", "My\\", 4, 7],
      ["word", "File", 8, 12],
    ])
  })

  it("splits a pipeline on the pipe operator", () => {
    expect(shape("cat foo | grep bar")).toEqual([
      ["word", "cat", 0, 3],
      ["word", "foo", 4, 7],
      ["operator", "|", 8, 9],
      ["word", "grep", 10, 14],
      ["word", "bar", 15, 18],
    ])
  })

  it("reads && and || as single operators, never as two chars", () => {
    expect(shape("a && b || c")).toEqual([
      ["word", "a", 0, 1],
      ["operator", "&&", 2, 4],
      ["word", "b", 5, 6],
      ["operator", "||", 7, 9],
      ["word", "c", 10, 11],
    ])
  })

  it("lexes `;` and a background `&` as separators", () => {
    expect(shape("a; b &")).toEqual([
      ["word", "a", 0, 1],
      ["operator", ";", 1, 2],
      ["word", "b", 3, 4],
      ["operator", "&", 5, 6],
    ])
  })

  it("recognises redirects, including a leading file descriptor", () => {
    expect(shape("cmd > out.txt 2>> err.log")).toEqual([
      ["word", "cmd", 0, 3],
      ["redirect", ">", 4, 5],
      ["word", "out.txt", 6, 13],
      ["redirect", "2>>", 14, 17],
      ["word", "err.log", 18, 25],
    ])
  })

  it("prefers `&>` over the background `&`", () => {
    expect(shape("cmd &> all.log")).toEqual([
      ["word", "cmd", 0, 3],
      ["redirect", "&>", 4, 6],
      ["word", "all.log", 7, 14],
    ])
  })

  it("opens a nested context for `$(`, backticks and subshells", () => {
    expect(shape("echo $(date)")).toEqual([
      ["word", "echo", 0, 4],
      ["open", "$(", 5, 7],
      ["word", "date", 7, 11],
      ["close", ")", 11, 12],
    ])
    expect(shape("echo `date`")).toEqual([
      ["word", "echo", 0, 4],
      ["open", "`", 5, 6],
      ["word", "date", 6, 10],
      ["close", "`", 10, 11],
    ])
    expect(shape("(cd /tmp && ls)")).toEqual([
      ["open", "(", 0, 1],
      ["word", "cd", 1, 3],
      ["word", "/tmp", 4, 8],
      ["operator", "&&", 9, 11],
      ["word", "ls", 12, 14],
      ["close", ")", 14, 15],
    ])
  })

  it("tracks nesting depth through a substitution", () => {
    const depths = lexCommandLine("echo $(git log)").map((t) => [t.value, t.depth])
    expect(depths).toEqual([
      ["echo", 0],
      ["$(", 0],
      ["git", 1],
      ["log", 1],
      [")", 0],
    ])
  })

  it("sees a substitution that starts inside double quotes", () => {
    const kinds = lexCommandLine(`echo "$(gre`).map((t) => t.kind)
    expect(kinds).toEqual(["word", "word", "open", "word"])
  })

  it("flags an unterminated quote with its source range", () => {
    const tokens = lexCommandLine(`cat "unclosed`)
    expect(tokens[1].unterminated).toBe('"')
    expect([tokens[1].start, tokens[1].end]).toEqual([4, 13])
    expect(lexCommandLine(`cat 'x`)[1].unterminated).toBe("'")
    expect(lexCommandLine("cat closed")[1].unterminated).toBeUndefined()
  })

  it("flags a trailing backslash as an unterminated escape", () => {
    expect(lexCommandLine("cat foo\\")[1].unterminated).toBe("\\")
  })

  it("never loses or duplicates a character's position", () => {
    const line = `a "b c" | d > e && f $(g)`
    for (const token of lexCommandLine(line)) {
      expect(line.slice(token.start, token.end)).toBe(token.raw)
    }
  })

  it("terminates on every prefix of a substitution-heavy line", () => {
    // `$(` once broke the word loop without consuming it, and the outer loop
    // handed it straight back — an infinite loop on a single keystroke.
    const line = `echo "$(git log)" | grep $(x) > $(f)`
    for (let i = 0; i <= line.length; i++) {
      expect(() => lexCommandLine(line.slice(0, i))).not.toThrow()
    }
  })

  it("returns nothing for an empty or whitespace-only line", () => {
    expect(lexCommandLine("")).toEqual([])
    expect(lexCommandLine("   \t ")).toEqual([])
  })
})

describe("isEnvAssignment", () => {
  const first = (line: string) => lexCommandLine(line)[0]

  it("recognises a leading assignment", () => {
    expect(isEnvAssignment(first("FOO=bar cmd"))).toBe(true)
    expect(isEnvAssignment(first("_x1=2 cmd"))).toBe(true)
  })

  it("rejects anything that is not one", () => {
    expect(isEnvAssignment(first("cmd"))).toBe(false)
    expect(isEnvAssignment(first("1FOO=bar"))).toBe(false)
    expect(isEnvAssignment(first("--flag=value"))).toBe(false)
    // Quoted: the raw text does not start with a bare NAME=, so it is an arg.
    expect(isEnvAssignment(first(`"FOO=bar"`))).toBe(false)
  })
})
