import {
  safeActivityTarget,
  safeStableActivityId,
  safeToolActivityMetadata,
  sanitizeActivityLabel,
} from "./run-activity"

describe("safeStableActivityId", () => {
  it("preserves ordinary generated ids but hashes PII-shaped or malformed ids", () => {
    expect(safeStableActivityId("run_01JABCDEF")).toBe("run_01JABCDEF")
    expect(safeStableActivityId("13800138000")).toMatch(/^opaque-[0-9a-f]{8}$/)
    expect(safeStableActivityId("private.person@example.com")).toMatch(/^opaque-[0-9a-f]{8}$/)
    expect(safeStableActivityId("../../private")).toMatch(/^opaque-[0-9a-f]{8}$/)
  })
})

describe("safeToolActivityMetadata", () => {
  it("keeps a normalized tool name and workspace-relative path without retaining raw input", () => {
    const metadata = safeToolActivityMetadata(
      "tool-mcp__cognia-tools__Read",
      {
        file_path: "/workspace/project/src/secrets.ts",
        command: "curl https://user:pass@example.com?token=secret",
        query: "private query",
      },
      { workspaceRoot: "/workspace/project" }
    )

    expect(metadata).toEqual({
      toolName: "Read",
      category: "read",
      target: { kind: "workspace_path", label: "src/secrets.ts" },
    })
    expect(JSON.stringify(metadata)).not.toContain("curl")
    expect(JSON.stringify(metadata)).not.toContain("private query")
    expect(JSON.stringify(metadata)).not.toContain("/workspace/project")
  })

  it("omits commands, searches, URLs, malformed paths, and paths outside the workspace", () => {
    expect(
      safeToolActivityMetadata("Bash", { command: "printenv SECRET" }, { workspaceRoot: "/repo" })
    ).toEqual({ toolName: "Bash", category: "command" })
    expect(
      safeToolActivityMetadata(
        "WebSearch",
        { query: "customer@example.com" },
        { workspaceRoot: "/repo" }
      )
    ).toEqual({ toolName: "WebSearch", category: "search" })
    expect(
      safeToolActivityMetadata(
        "Read",
        { file_path: "/another/private.txt" },
        { workspaceRoot: "/repo" }
      )
    ).toEqual({ toolName: "Read", category: "read" })
    expect(
      safeToolActivityMetadata(
        "Read",
        { file_path: "../../private.txt" },
        { workspaceRoot: "/repo" }
      )
    ).toEqual({ toolName: "Read", category: "read" })
  })
})

describe("safeActivityTarget", () => {
  it("accepts only normalized relative workspace paths and explicit resource titles", () => {
    expect(safeActivityTarget({ kind: "workspace_path", label: "src/index.ts" })).toEqual({
      kind: "workspace_path",
      label: "src/index.ts",
    })
    expect(safeActivityTarget({ kind: "resource", label: "Release notes", safe: true })).toEqual({
      kind: "resource",
      label: "Release notes",
      safe: true,
    })
    expect(safeActivityTarget({ kind: "resource", label: "Unmarked title" })).toBeUndefined()
    expect(safeActivityTarget({ kind: "workspace_path", label: "/etc/passwd" })).toBeUndefined()
    expect(
      safeActivityTarget({ kind: "resource", label: "https://example.com?token=secret" })
    ).toBeUndefined()
  })
})

describe("sanitizeActivityLabel", () => {
  it("removes control characters, collapses whitespace, and clamps labels", () => {
    expect(sanitizeActivityLabel("  Read\u0000\n  file  ", "Activity")).toBe("Read file")
    expect(sanitizeActivityLabel("x".repeat(200), "Activity")).toBe(`${"x".repeat(119)}…`)
    expect(sanitizeActivityLabel("\u0000\n", "Activity")).toBe("Activity")
  })

  it("redacts PII and replaces command, query, and URL-shaped labels", () => {
    expect(sanitizeActivityLabel("Email alice@example.com", "Activity")).not.toContain(
      "alice@example.com"
    )
    expect(sanitizeActivityLabel("curl https://example.com?token=secret", "Activity")).toBe(
      "Activity"
    )
    expect(sanitizeActivityLabel("SELECT password FROM users", "Activity")).toBe("Activity")
  })
})
