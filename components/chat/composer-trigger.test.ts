import { detectTrigger, spliceToken } from "./composer-trigger"

describe("detectTrigger — slash mode", () => {
  it("detects `/cmd` at the very start of the textarea", () => {
    const tg = detectTrigger("/help me", 5)
    expect(tg).toEqual({ kind: "slash", tokenStart: 0, tokenEnd: 5, query: "help" })
  })

  it("does not trigger when `/` is mid-line (urls / paths)", () => {
    expect(detectTrigger("hi /world", 9)).toBeNull()
  })

  it("detects `/cmd` at the start of a non-first line (multi-command)", () => {
    const value = "first line\n/help"
    const tg = detectTrigger(value, value.length)
    expect(tg).toEqual({ kind: "slash", tokenStart: 11, tokenEnd: 16, query: "help" })
  })

  it("detects a command line with leading whitespace", () => {
    const value = "a\n  /model opus"
    // caret right after `/model`
    const tg = detectTrigger(value, 8)
    expect(tg?.kind).toBe("slash")
    expect(tg?.tokenStart).toBe(4)
    expect(tg?.query).toBe("mod")
  })

  it("does not treat `!`/`#` on a later line as a trigger (mode rule unchanged)", () => {
    expect(detectTrigger("hello\n!ls", 9)).toBeNull()
    expect(detectTrigger("hello\n#note", 11)).toBeNull()
  })
})

describe("detectTrigger — bash + memory", () => {
  it("detects `!cmd` at the start", () => {
    const tg = detectTrigger("!ls -la", 7)
    expect(tg?.kind).toBe("bash")
    expect(tg?.query).toBe("ls -la")
  })

  it("detects `#text` at the start", () => {
    const tg = detectTrigger("#remember this", 14)
    expect(tg?.kind).toBe("memory")
    expect(tg?.query).toBe("remember this")
  })
})

describe("detectTrigger — @file mode (default)", () => {
  it("detects an @file token after whitespace", () => {
    const tg = detectTrigger("look @src/foo", 13)
    expect(tg?.kind).toBe("file")
    expect(tg?.query).toBe("src/foo")
  })

  it("ignores @ inside an email address", () => {
    expect(detectTrigger("send to user@example.com", 24)).toBeNull()
  })

  it("returns null for a caret outside the token range", () => {
    // typed @foo then moved caret way past it
    expect(detectTrigger("hi @foo bar", 11)).toBeNull()
  })
})

describe("detectTrigger — @agent mode", () => {
  it("returns the agent kind when mentionMode is agents", () => {
    const tg = detectTrigger("@codex hi", 6, { mentionMode: "agents" })
    expect(tg?.kind).toBe("agent")
    expect(tg?.query).toBe("codex")
    expect(tg?.tokenStart).toBe(0)
  })

  it("respects whitespace boundary in agent mode", () => {
    expect(detectTrigger("foo@bar", 7, { mentionMode: "agents" })).toBeNull()
  })

  it("falls back to file kind when mentionMode is files (explicit)", () => {
    const tg = detectTrigger("@codex", 6, { mentionMode: "files" })
    expect(tg?.kind).toBe("file")
  })

  it("supports an empty query right after the @ char", () => {
    const tg = detectTrigger("hi @", 4, { mentionMode: "agents" })
    expect(tg?.kind).toBe("agent")
    expect(tg?.query).toBe("")
  })
})

describe("spliceToken", () => {
  it("inserts the replacement and adds a trailing space", () => {
    const result = spliceToken("hi @c", 3, 5, "@codex")
    expect(result.value).toBe("hi @codex ")
    expect(result.caret).toBe("hi @codex ".length)
  })

  it("does not double-add a trailing space when one is already present", () => {
    const result = spliceToken("hi @co rest", 3, 6, "@codex")
    expect(result.value).toBe("hi @codex rest")
  })
})
