import {
  aggregateToolStatus,
  clampTarget,
  countErroredTools,
  isContextFoldPart,
  normalizeToolName,
  resolveProvidedToolTitle,
  resolveToolPartName,
  summarizeContextCounts,
  resolveToolDisplayTitle,
  summarizeToolCall,
  tallyToolNames,
  toolIconKeyForName,
  type ToolPartLike,
} from "./tool-summary"

function tool(type: string, input?: unknown, state = "output-available"): ToolPartLike {
  return { type, input, state } as unknown as ToolPartLike
}

describe("normalizeToolName", () => {
  it("strips the tool- prefix", () => {
    expect(normalizeToolName(tool("tool-Read"))).toBe("Read")
  })

  it("folds mcp__server__name down to the bare tool name", () => {
    expect(normalizeToolName(tool("tool-mcp__cognia-tools__bash"))).toBe("bash")
  })

  it("handles dynamic-tool parts via toolName", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "Custom",
      state: "output-available",
    } as unknown as ToolPartLike
    expect(normalizeToolName(part)).toBe("Custom")
  })

  it("falls back to tool for nameless dynamic tools", () => {
    const part = { type: "dynamic-tool", state: "input-available" } as unknown as ToolPartLike
    expect(normalizeToolName(part)).toBe("tool")
  })
})

describe("toolIconKeyForName", () => {
  it("reuses the canonical tool-name classification without requiring a UI part", () => {
    expect(toolIconKeyForName("tool-mcp__cognia-tools__bash")).toBe("terminal")
    expect(toolIconKeyForName("Read")).toBe("read")
    expect(toolIconKeyForName("custom_tool")).toBe("generic")
  })
})

describe("clampTarget", () => {
  it("collapses whitespace", () => {
    expect(clampTarget("a   b\nc")).toBe("a b c")
  })

  it("truncates with an ellipsis", () => {
    expect(clampTarget("x".repeat(100), 10)).toBe("xxxxxxxxx…")
  })
})

describe("summarizeToolCall", () => {
  it("uses the file basename for Read/Write/Edit", () => {
    expect(summarizeToolCall(tool("tool-Read", { file_path: "/a/b/c.ts" }))).toEqual({
      name: "Read",
      target: "c.ts",
      iconKey: "read",
    })
    expect(summarizeToolCall(tool("tool-Edit", { file_path: "x\\y\\z.tsx" })).target).toBe("z.tsx")
    expect(summarizeToolCall(tool("tool-Write", { file_path: "/p/q.md" })).iconKey).toBe("write")
  })

  it("uses the command for Bash", () => {
    const s = summarizeToolCall(tool("tool-Bash", { command: "pnpm test --run" }))
    expect(s).toMatchObject({ name: "Bash", target: "pnpm test --run", iconKey: "terminal" })
  })

  it("uses the pattern for Grep/Glob", () => {
    expect(summarizeToolCall(tool("tool-Grep", { pattern: "foo.*bar" })).target).toBe("foo.*bar")
    expect(summarizeToolCall(tool("tool-Glob", { pattern: "**/*.ts" })).iconKey).toBe("glob")
  })

  it("uses the notebook path basename for NotebookEdit (with file_path fallback)", () => {
    expect(
      summarizeToolCall(tool("tool-NotebookEdit", { notebook_path: "/n/book.ipynb" }))
    ).toMatchObject({ name: "NotebookEdit", target: "book.ipynb", iconKey: "notebook" })
    expect(summarizeToolCall(tool("tool-NotebookEdit", { file_path: "/n/alt.ipynb" })).target).toBe(
      "alt.ipynb"
    )
  })

  it("uses the path basename for ls, falling back to the raw path", () => {
    expect(summarizeToolCall(tool("tool-ls", { path: "/a/b/dir" }))).toMatchObject({
      name: "ls",
      target: "dir",
      iconKey: "folder",
    })
    // Trailing separator → basename is empty → falls back to the cleaned path.
    expect(summarizeToolCall(tool("tool-ls", { path: "/" })).target).toBe("/")
  })

  it("uses the host for WebFetch and query for WebSearch", () => {
    expect(summarizeToolCall(tool("tool-WebFetch", { url: "https://example.com/x" })).target).toBe(
      "example.com"
    )
    expect(summarizeToolCall(tool("tool-WebSearch", { query: "react 19" })).target).toBe("react 19")
  })

  it("falls back to a generic best-effort target", () => {
    const s = summarizeToolCall(tool("tool-Unknown", { name: "thing" }))
    expect(s).toEqual({ name: "Unknown", target: "thing", iconKey: "generic" })
  })

  it("returns a null target when nothing usable is present", () => {
    expect(summarizeToolCall(tool("tool-Read", {})).target).toBeNull()
    expect(summarizeToolCall(tool("tool-Bash")).target).toBeNull()
  })

  it("falls back to ACP kind when the compatibility tool name is only a title", () => {
    expect(
      summarizeToolCall({
        ...tool("tool-Reading configuration"),
        toolMetadata: { kind: "file_read" },
      } as ToolPartLike)
    ).toMatchObject({ name: "Reading configuration", iconKey: "read" })
    expect(
      summarizeToolCall({
        ...tool("tool-Run checks"),
        toolMetadata: { kind: "execute" },
      } as ToolPartLike)
    ).toMatchObject({ iconKey: "terminal" })
  })

  it("does not throw on a malformed url", () => {
    expect(summarizeToolCall(tool("tool-WebFetch", { url: "not a url" })).target).toBe("not a url")
  })

  it("supports Codex shell, web_search, and fileChange input shapes", () => {
    expect(summarizeToolCall(tool("tool-shell", { command: "pnpm test" }))).toMatchObject({
      target: "pnpm test",
      iconKey: "terminal",
    })
    expect(summarizeToolCall(tool("tool-web_search", { query: "ACP titles" }))).toMatchObject({
      target: "ACP titles",
      iconKey: "web",
    })
    expect(
      summarizeToolCall(tool("tool-edit", { changes: [{ path: "/repo/src/a.ts" }] }))
    ).toMatchObject({ target: "a.ts", iconKey: "edit" })
  })

  it("prefers an upstream title and otherwise builds a deterministic display title", () => {
    expect(
      resolveToolDisplayTitle({
        ...tool("tool-Read", { file_path: "/repo/a.ts" }),
        title: "Reading configuration",
      })
    ).toBe("Reading configuration")
    expect(resolveToolDisplayTitle(tool("tool-shell", { command: "pnpm test" }))).toBe(
      "Shell · pnpm test"
    )
    expect(resolveToolDisplayTitle(tool("tool-web_search", {}))).toBe("Web search")
  })

  it("uses Codex app context after an upstream title and never exposes internal ids", () => {
    const appContextPart = {
      ...tool("tool-create_event", {}),
      toolMetadata: {
        appContext: {
          appName: "Calendar",
          actionName: "create_event",
          connectorId: "calendar-prod",
          linkId: "primary-account",
        },
      },
    } as ToolPartLike

    expect(resolveProvidedToolTitle(appContextPart)).toBe("Calendar · Create event")
    expect(resolveToolDisplayTitle(appContextPart)).toBe("Calendar · Create event")
    expect(
      resolveProvidedToolTitle({ ...appContextPart, title: "Create team event" } as ToolPartLike)
    ).toBe("Create team event")
  })
})

describe("tallyToolNames", () => {
  it("counts by case-insensitive name, preserving first-seen order + casing", () => {
    expect(
      tallyToolNames([
        tool("tool-Read"),
        tool("tool-Grep"),
        tool("tool-read"),
        tool("tool-Read"),
        tool("tool-Edit"),
      ])
    ).toEqual([
      { name: "Read", count: 3 },
      { name: "Grep", count: 1 },
      { name: "Edit", count: 1 },
    ])
  })

  it("folds mcp-namespaced names into the bare tool", () => {
    expect(tallyToolNames([tool("tool-mcp__cognia-tools__bash"), tool("tool-bash")])).toEqual([
      { name: "bash", count: 2 },
    ])
  })

  it("returns an empty array for no parts", () => {
    expect(tallyToolNames([])).toEqual([])
  })
})

describe("aggregateToolStatus", () => {
  it("prioritizes error over everything", () => {
    expect(aggregateToolStatus(["output-available", "output-error", "input-available"])).toBe(
      "error"
    )
  })

  it("reports running when a call is in flight", () => {
    expect(aggregateToolStatus(["output-available", "input-available"])).toBe("running")
    expect(aggregateToolStatus(["approval-requested"])).toBe("running")
  })

  it("reports pending while only streaming input", () => {
    expect(aggregateToolStatus(["input-streaming"])).toBe("pending")
  })

  it("reports complete when all calls resolved", () => {
    expect(aggregateToolStatus(["output-available", "output-available"])).toBe("complete")
  })
})

describe("resolveToolPartName", () => {
  it("resolves both tool encodings and folds the mcp namespace", () => {
    expect(resolveToolPartName({ type: "tool-Read" })).toBe("Read")
    expect(resolveToolPartName({ type: "tool-mcp__cognia-tools__grep" })).toBe("grep")
    expect(resolveToolPartName({ type: "dynamic-tool", toolName: "Read" })).toBe("Read")
    expect(resolveToolPartName({ type: "dynamic-tool", toolName: "mcp__x__grep" })).toBe("grep")
  })

  it("is null for anything that is not a named tool call", () => {
    expect(resolveToolPartName({ type: "text" })).toBeNull()
    expect(resolveToolPartName({ type: "dynamic-tool" })).toBeNull()
    expect(resolveToolPartName({ type: "dynamic-tool", toolName: "   " })).toBeNull()
    expect(resolveToolPartName({})).toBeNull()
    expect(resolveToolPartName(undefined)).toBeNull()
  })
})

describe("isContextFoldPart", () => {
  it("is true for read/search/glob/list/web context tools", () => {
    expect(isContextFoldPart({ type: "tool-Read" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-Grep" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-Glob" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-ls" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-WebFetch" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-WebSearch" })).toBe(true)
  })

  it("is false for actions (edit/write/bash), tasks and non-tools", () => {
    expect(isContextFoldPart({ type: "tool-Edit" })).toBe(false)
    expect(isContextFoldPart({ type: "tool-Write" })).toBe(false)
    expect(isContextFoldPart({ type: "tool-Bash" })).toBe(false)
    expect(isContextFoldPart({ type: "tool-TodoWrite" })).toBe(false)
    expect(isContextFoldPart({ type: "tool-mcp__x__frobnicate" })).toBe(false)
    expect(isContextFoldPart({ type: "text" })).toBe(false)
    expect(isContextFoldPart(undefined)).toBe(false)
  })

  it("folds mcp-namespaced context tools by their bare name", () => {
    expect(isContextFoldPart({ type: "tool-mcp__cognia-tools__grep" })).toBe(true)
  })

  // Third-party MCP servers name their readers `search` / `list` / `view` just
  // as often as `Grep` / `LS` / `Read`; the CLI's context set covers both.
  it("folds the common third-party aliases the CLI recognizes", () => {
    expect(isContextFoldPart({ type: "tool-mcp__docs__search" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-mcp__docs__list" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-mcp__docs__view" })).toBe(true)
    expect(isContextFoldPart({ type: "tool-mcp__docs__cat" })).toBe(true)
  })

  // Imported transcripts and CLI handoff sessions carry `dynamic-tool` parts,
  // whose name lives on `toolName` — a type-only check refused to fold them.
  it("classifies dynamic-tool parts by their toolName", () => {
    expect(isContextFoldPart({ type: "dynamic-tool", toolName: "Read" })).toBe(true)
    expect(isContextFoldPart({ type: "dynamic-tool", toolName: "mcp__x__grep" })).toBe(true)
    expect(isContextFoldPart({ type: "dynamic-tool", toolName: "Edit" })).toBe(false)
    expect(isContextFoldPart({ type: "dynamic-tool" })).toBe(false)
  })
})

describe("countErroredTools", () => {
  it("counts only output-error states", () => {
    expect(
      countErroredTools(["output-available", "output-error", "input-available", "output-error"])
    ).toBe(2)
    expect(countErroredTools(["output-available", "input-available"])).toBe(0)
    expect(countErroredTools([])).toBe(0)
  })
})

describe("summarizeContextCounts", () => {
  it("keeps read/search/glob/list/web distinct, first-seen order, with counts", () => {
    expect(
      summarizeContextCounts([
        tool("tool-Read"),
        tool("tool-Grep"),
        tool("tool-Read"),
        tool("tool-Glob"),
        tool("tool-ls"),
        tool("tool-WebFetch"),
      ])
    ).toEqual([
      { category: "read", count: 2 },
      { category: "search", count: 1 },
      { category: "glob", count: 1 },
      { category: "list", count: 1 },
      { category: "web", count: 1 },
    ])
  })

  it("buckets non-context tools as other", () => {
    expect(summarizeContextCounts([tool("tool-Edit"), tool("tool-Bash")])).toEqual([
      { category: "other", count: 2 },
    ])
  })

  it("returns an empty array for no parts", () => {
    expect(summarizeContextCounts([])).toEqual([])
  })
})
