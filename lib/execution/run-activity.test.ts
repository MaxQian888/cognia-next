import {
  safeActivityTarget,
  safeStableActivityId,
  safeToolActivityMetadata,
  sanitizeActivityCommentary,
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

describe("sanitizeActivityCommentary", () => {
  it("preserves narration with code spans and tool names as plain text", () => {
    expect(
      sanitizeActivityCommentary(
        "I’m checking `code` and git history before reviewing node and npm configuration.",
        "Agent progress"
      )
    ).toBe("I’m checking code and git history before reviewing node and npm configuration.")
    expect(sanitizeActivityCommentary("I will update the files from the plan.", "Progress")).toBe(
      "I will update the files from the plan."
    )
  })

  it.each([
    "Node dependencies are ready",
    "npm configuration needs review",
    "git history explains this change",
    "curl documentation describes the API",
    "Checking `node` dependencies and `npm` configuration",
  ])("preserves prose that names an executable: %s", (value) => {
    expect(sanitizeActivityCommentary(value, "Agent progress")).toBe(value.replace(/`/g, ""))
  })

  it("reduces URLs to their host without retaining credentials, paths, or query tokens", () => {
    expect(
      sanitizeActivityCommentary(
        "Checking https://alice:password@example.com/private?token=secret#details now.",
        "Agent progress"
      )
    ).toBe("Checking example.com now.")
    expect(
      sanitizeActivityCommentary("Checking https://example.com?token=$(secret)", "Progress")
    ).toBe("Checking example.com")
  })

  it.each([
    "curl https://example.com?token=secret",
    "I ran curl example.com",
    "Command: rm -rf /tmp/demo",
    "Inspecting `curl example.com` now",
    "Command: cat src/private.txt",
    "printenv SECRET",
    "export MODE=private",
    "git log -S secret -- docs/plans",
    "echo hello world",
    "node script",
    "I ran `node script with arguments` next.",
    "Checking files\n$ npm run test -- --token=secret",
    "I will run `node script.js --token=secret` next.",
    "Inspecting $(printenv SECRET)",
    "SELECT password FROM users",
    "Reviewing `SELECT password FROM users` next.",
    "Found password=short-secret",
  ])("falls back for unsafe execution text: %s", (value) => {
    expect(sanitizeActivityCommentary(value, "Agent progress")).toBe("Agent progress")
  })

  it("retains useful narration after redacting PII and secret values", () => {
    const output = sanitizeActivityCommentary(
      "Checking alice@example.com and key sk-proj-abc123def456ghi789jkl012.",
      "Agent progress"
    )
    expect(output).toContain("Checking")
    expect(output).not.toContain("alice@example.com")
    expect(output).not.toContain("sk-proj-abc123def456ghi789jkl012")
    expect(output).not.toBe("Agent progress")
  })

  it("normalizes obfuscated secrets before redaction and bounds the resulting label", () => {
    const output = sanitizeActivityCommentary(
      "Checking sk-proj-abc123\u001b[0mdef456ghi789jkl012",
      "Agent progress"
    )
    expect(output).toContain("Checking")
    expect(output).not.toContain("abc123")
    expect(sanitizeActivityCommentary(" ` ` \u0000 ", "Agent progress")).toBe("Agent progress")
    expect(sanitizeActivityCommentary("x".repeat(200), "Agent progress")).toHaveLength(120)
  })

  it("does not relax the strict sanitizer used by tool labels", () => {
    expect(sanitizeActivityLabel("Checking `code` with git history", "Tool")).toBe("Tool")
  })

  it("keeps an already safe commentary fallback when a later delta becomes unsafe", () => {
    expect(sanitizeActivityCommentary("git log -S secret", "Checking code with git history")).toBe(
      "Checking code with git history"
    )
  })
})
