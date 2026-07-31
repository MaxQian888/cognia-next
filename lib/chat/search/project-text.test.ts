import {
  PROJECTED_TEXT_MAX_CHARS,
  TOOL_INPUT_FIELD_MAX_CHARS,
  projectSearchText,
} from "./project-text"

describe("projectSearchText", () => {
  it("returns an empty string for non-array input", () => {
    expect(projectSearchText(undefined)).toBe("")
    expect(projectSearchText(null)).toBe("")
    expect(projectSearchText("not parts")).toBe("")
    expect(projectSearchText({})).toBe("")
  })

  it("returns an empty string for an empty parts array", () => {
    expect(projectSearchText([])).toBe("")
  })

  // ---- delegated to extractPlainText (do not re-test its full matrix) ----

  it("delegates text parts to extractPlainText", () => {
    expect(projectSearchText([{ type: "text", text: "hello world" }])).toBe("hello world")
  })

  it("keeps the code-block projection extractPlainText already provides", () => {
    expect(projectSearchText([{ type: "code", text: "const x = 1", language: "ts" }])).toBe(
      "[ts] const x = 1"
    )
  })

  it("keeps the a2ui plain-text mirror extractPlainText already provides", () => {
    expect(projectSearchText([{ type: "a2ui", plainTextMirror: "mirrored surface" }])).toBe(
      "mirrored surface"
    )
  })

  // ---- part types extractPlainText drops, which search needs ----

  it("includes reasoning text, which extractPlainText drops", () => {
    expect(projectSearchText([{ type: "reasoning", text: "weighing the options" }])).toBe(
      "weighing the options"
    )
  })

  it("ignores a reasoning part with no text", () => {
    expect(projectSearchText([{ type: "reasoning" }])).toBe("")
    expect(projectSearchText([{ type: "reasoning", text: 42 }])).toBe("")
  })

  it("includes a file part's filename", () => {
    expect(
      projectSearchText([
        { type: "file", filename: "quarterly-report.pdf", mediaType: "application/pdf" },
      ])
    ).toBe("quarterly-report.pdf")
  })

  it("ignores a file part with no filename", () => {
    expect(projectSearchText([{ type: "file", url: "blob:x", mediaType: "image/png" }])).toBe("")
  })

  it("includes each source's title and url", () => {
    const text = projectSearchText([
      {
        type: "sources",
        sources: [
          { id: "1", title: "Dexie docs", url: "https://dexie.org/docs", origin: "anthropic" },
          { id: "2", title: "内部 wiki", origin: "twin-rag" },
        ],
      },
    ])
    expect(text).toContain("Dexie docs")
    expect(text).toContain("https://dexie.org/docs")
    expect(text).toContain("内部 wiki")
  })

  it("tolerates a sources part whose sources array is missing or malformed", () => {
    expect(projectSearchText([{ type: "sources" }])).toBe("")
    expect(projectSearchText([{ type: "sources", sources: "nope" }])).toBe("")
    expect(projectSearchText([{ type: "sources", sources: [null, 7] }])).toBe("")
  })

  // ---- tool calls: name + input, so "that command I ran" is findable ----

  it("includes the normalized tool name", () => {
    expect(projectSearchText([{ type: "tool-Bash", input: {} }])).toBe("Bash")
  })

  it("strips the mcp server namespace from the tool name", () => {
    expect(projectSearchText([{ type: "tool-mcp__cognia-tools__bash", input: {} }])).toBe("bash")
  })

  it("includes a dynamic-tool's toolName", () => {
    expect(projectSearchText([{ type: "dynamic-tool", toolName: "customLookup", input: {} }])).toBe(
      "customLookup"
    )
  })

  it("includes string-valued tool input fields", () => {
    const text = projectSearchText([
      { type: "tool-Bash", input: { command: "pnpm test -- lib/chat/search", timeout: 5000 } },
    ])
    expect(text).toBe("Bash pnpm test -- lib/chat/search")
  })

  it("keeps a long command searchable past the 72-char UI clamp", () => {
    // `summarizeToolCall` clamps its `target` to 72 chars for single-line rows.
    // Search must not inherit that clamp, or a flag late in a long command
    // would be unfindable.
    const command = `pnpm test -- ${"a".repeat(80)} --reporters=default`
    const text = projectSearchText([{ type: "tool-Bash", input: { command } }])
    expect(text).toContain("--reporters=default")
  })

  it("caps a single tool input field so one part cannot dominate", () => {
    const command = "x".repeat(TOOL_INPUT_FIELD_MAX_CHARS + 500)
    const text = projectSearchText([{ type: "tool-Bash", input: { command } }])
    expect(text.length).toBeLessThanOrEqual("Bash ".length + TOOL_INPUT_FIELD_MAX_CHARS)
  })

  it("collects strings from nested tool input objects and arrays", () => {
    const text = projectSearchText([
      {
        type: "tool-Edit",
        input: { file_path: "lib/db/schema.ts", edits: [{ old_string: "needle-in-nest" }] },
      },
    ])
    expect(text).toContain("lib/db/schema.ts")
    expect(text).toContain("needle-in-nest")
  })

  it("does not recurse past the nesting depth limit", () => {
    const text = projectSearchText([
      { type: "tool-X", input: { a: { b: { c: { d: { e: "too-deep-to-index" } } } } } },
    ])
    expect(text).not.toContain("too-deep-to-index")
  })

  it("ignores a tool part with no input", () => {
    expect(projectSearchText([{ type: "tool-Read" }])).toBe("Read")
  })

  it("never throws on a tool input holding a circular reference", () => {
    const input: Record<string, unknown> = { file_path: "a.ts" }
    input.self = input
    expect(() => projectSearchText([{ type: "tool-Read", input }])).not.toThrow()
  })

  // ---- ordering, normalization, bounds ----

  it("preserves document order across delegated and extra part types", () => {
    expect(
      projectSearchText([
        { type: "text", text: "alpha" },
        { type: "reasoning", text: "bravo" },
        { type: "text", text: "charlie" },
      ])
    ).toBe("alpha bravo charlie")
  })

  it("collapses whitespace and trims", () => {
    expect(projectSearchText([{ type: "text", text: "  spread   \n\n out  " }])).toBe("spread out")
  })

  it("skips unknown part types without throwing", () => {
    expect(
      projectSearchText([
        { type: "agent-team-dispatch", anything: "ignored" },
        { type: "text", text: "kept" },
      ])
    ).toBe("kept")
  })

  it("skips non-object entries", () => {
    expect(projectSearchText([null, 3, "raw", { type: "text", text: "kept" }])).toBe("kept")
  })

  it("truncates the projection at PROJECTED_TEXT_MAX_CHARS", () => {
    const long = "a".repeat(PROJECTED_TEXT_MAX_CHARS + 100)
    const text = projectSearchText([{ type: "text", text: long }])
    expect(text).toHaveLength(PROJECTED_TEXT_MAX_CHARS)
  })

  it("stops walking once the cap is reached", () => {
    const long = "a".repeat(PROJECTED_TEXT_MAX_CHARS)
    const text = projectSearchText([
      { type: "text", text: long },
      { type: "text", text: "never-reached" },
    ])
    expect(text).not.toContain("never-reached")
  })
})
