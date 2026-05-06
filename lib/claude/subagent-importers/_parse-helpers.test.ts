import {
  parseFrontmatter,
  stringOrUndef,
  parseList,
  slugify,
  nameFromFilename,
  fileMatchesAnyExt,
  ensureMinimum,
  buildDraft,
} from "./_parse-helpers"

describe("parseFrontmatter", () => {
  it("returns data + trimmed body", () => {
    const r = parseFrontmatter("---\nname: foo\n---\n\nHello world\n")
    expect(r.data.name).toBe("foo")
    expect(r.body).toBe("Hello world")
  })

  it("returns empty data when frontmatter is absent", () => {
    const r = parseFrontmatter("Just body, no fence")
    expect(r.data).toEqual({})
    expect(r.body).toBe("Just body, no fence")
  })

  it("throws on malformed YAML", () => {
    expect(() => parseFrontmatter("---\n: bad: yaml: : :\n---\nbody")).toThrow()
  })
})

describe("stringOrUndef", () => {
  it.each([
    ["foo", "foo"],
    ["  foo  ", "foo"],
    ["", undefined],
    ["   ", undefined],
    [42, undefined],
    [null, undefined],
    [undefined, undefined],
  ])("(%j) -> %j", (input, expected) => {
    expect(stringOrUndef(input)).toBe(expected)
  })
})

describe("parseList", () => {
  it("array of strings — trims and drops empties", () => {
    expect(parseList(["a", " b ", "", "c"])).toEqual(["a", "b", "c"])
  })

  it("comma-separated string", () => {
    expect(parseList("Read, Write, Bash")).toEqual(["Read", "Write", "Bash"])
  })

  it("newline-separated string", () => {
    expect(parseList("Read\nWrite\n\nBash")).toEqual(["Read", "Write", "Bash"])
  })

  it("returns undefined for empty / non-list", () => {
    expect(parseList([])).toBeUndefined()
    expect(parseList("")).toBeUndefined()
    expect(parseList(42)).toBeUndefined()
    expect(parseList(undefined)).toBeUndefined()
  })

  it("array with non-string entries — keeps strings only", () => {
    expect(parseList(["a", 42, null, "b"])).toEqual(["a", "b"])
  })
})

describe("slugify", () => {
  it.each([
    ["Code Reviewer", "code-reviewer"],
    ["  Foo--Bar  ", "foo-bar"],
    ["a@b#c", "a-b-c"],
    ["", "subagent"],
    ["!!!", "subagent"],
  ])("(%j) -> %j", (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })
})

describe("nameFromFilename", () => {
  it.each([
    ["code-reviewer.md", "code reviewer"],
    ["my_agent.markdown", "my agent"],
    ["foo.mdc", "foo"],
    ["already nice", "already nice"],
  ])("(%j) -> %j", (input, expected) => {
    expect(nameFromFilename(input)).toBe(expected)
  })
})

describe("fileMatchesAnyExt", () => {
  it("matches case-insensitively", () => {
    expect(fileMatchesAnyExt("FOO.MD", [".md"])).toBe(true)
    expect(fileMatchesAnyExt("bar.mdc", [".md", ".mdc"])).toBe(true)
    expect(fileMatchesAnyExt("baz.txt", [".md", ".mdc"])).toBe(false)
  })
})

describe("ensureMinimum", () => {
  const file = { filename: "x.md", sourcePath: "x.md", content: "" }

  it("missing name", () => {
    expect(ensureMinimum(file, undefined, "body")).toEqual({
      filename: "x.md",
      error: "Missing name in x.md",
    })
  })

  it("empty body", () => {
    expect(ensureMinimum(file, "name", "")).toEqual({
      filename: "x.md",
      error: "Empty body in x.md",
    })
  })

  it("ok", () => {
    expect(ensureMinimum(file, "name", "body")).toBeNull()
  })
})

describe("buildDraft", () => {
  it("threads source + sourceKey + sourceFile, defaults warnings", () => {
    const draft = buildDraft({
      source: "claude-code",
      file: {
        filename: "code-reviewer.md",
        sourcePath: ".claude/agents/code-reviewer.md",
        content: "",
      },
      name: "Code Reviewer",
      description: "Reviews code",
      systemPrompt: "You are a reviewer.",
      tools: ["Read", "Grep"],
      model: "sonnet",
      providerHint: "anthropic",
      rawFrontmatter: { name: "code-reviewer" },
    })
    expect(draft).toEqual({
      source: "claude-code",
      sourceKey: "claude-code:code-reviewer",
      name: "Code Reviewer",
      description: "Reviews code",
      systemPrompt: "You are a reviewer.",
      tools: ["Read", "Grep"],
      model: "sonnet",
      providerHint: "anthropic",
      rawFrontmatter: { name: "code-reviewer" },
      sourceFile: ".claude/agents/code-reviewer.md",
      warnings: [],
    })
  })

  it("preserves passed-in warnings", () => {
    const d = buildDraft({
      source: "generic-md",
      file: { filename: "x.md", sourcePath: "x.md", content: "" },
      name: "X",
      systemPrompt: "body",
      warnings: ["fallback name used"],
    })
    expect(d.warnings).toEqual(["fallback name used"])
  })
})
