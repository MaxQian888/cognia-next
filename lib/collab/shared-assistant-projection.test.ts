import {
  createSharedAssistantProjector,
  SHARED_STREAMING_WINDOW,
} from "./shared-assistant-projection"

const ROOT = "/Users/alice/work/repo"
const settled = (parts: unknown[], options = {}) =>
  createSharedAssistantProjector(options).project("m", parts, "settled")

const tool = (toolName: string, input: unknown, state = "input-available") => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: "call",
  state,
  input,
})

describe("text", () => {
  it("redacts a secret that is split across two text parts", () => {
    const parts = settled([
      { type: "text", text: "mail alice@exa" },
      { type: "text", text: "mple.com now" },
    ])
    const json = JSON.stringify(parts)
    expect(json).not.toContain("alice@")
    expect(json).not.toContain("mple.com")
    expect(json).toContain("now")
  })

  it("holds back the streaming tail and releases it at settle", () => {
    const projector = createSharedAssistantProjector()
    const text = `${"a".repeat(300)}TAIL`
    const streaming = projector.project("m", [{ type: "text", text }], "streaming")
    expect(streaming).toEqual([
      { type: "text", text: "a".repeat(300 + 4 - SHARED_STREAMING_WINDOW) },
    ])
    expect(projector.project("m", [{ type: "text", text }], "settled")).toEqual([
      { type: "text", text },
    ])
  })

  it("never releases half a placeholder when the cut falls inside a secret", () => {
    const projector = createSharedAssistantProjector()
    const secret = "alice@example.com"
    // The cut lands in the middle of the address.
    const text = `${"x".repeat(9)} ${secret} ${"y".repeat(SHARED_STREAMING_WINDOW - 6)}`
    const [part] = projector.project("m", [{ type: "text", text }], "streaming") as Array<{
      text: string
    }>
    expect(part!.text).toBe(`${"x".repeat(9)} `)
  })

  it("never releases the prefix of a secret hidden by an escape sequence", () => {
    const projector = createSharedAssistantProjector()
    const key = `sk-\u001b[0m${"a".repeat(40)}`
    // The cut lands five characters into the key: a prefix too short for
    // the gate to recognise on its own.
    const before = "use "
    const cut = before.length + "sk-\u001b[0m".length + 5
    const text = `${before}${key} `
    const padded = text + "z".repeat(cut + SHARED_STREAMING_WINDOW - text.length)
    const parts = projector.project("m", [{ type: "text", text: padded }], "streaming")
    expect(parts).toEqual([{ type: "text", text: before }])
    expect(JSON.stringify(parts)).not.toContain("sk-")
    expect(JSON.stringify(parts)).not.toContain("aaaa")
  })

  it("withholds an unbounded secret from its opener, even after settle", () => {
    const text = `before -----BEGIN PRIVATE KEY-----\nMIIabc${"z".repeat(400)}`
    const parts = settled([{ type: "text", text }])
    expect(parts).toEqual([
      { type: "text", text: "before " },
      { type: "data-shared-withheld", data: { reason: "pii" } },
    ])
  })

  it("does not hold back a URL's port as if it were a credential", () => {
    const projector = createSharedAssistantProjector()
    const text = `open https://host:8080/a ${"z".repeat(SHARED_STREAMING_WINDOW)}`
    const [part] = projector.project("m", [{ type: "text", text }], "streaming") as Array<{
      text: string
    }>
    expect(part!.text).toBe("open https://host:8080/a ")
  })

  it("withholds a text part quoting a URL credential, even once redacted", () => {
    // The gate refuses `user:<placeholder>@` on purpose (packages/redact).
    const parts = settled([{ type: "text", text: "use postgres://bob:hunter2-long@db.local/x" }])
    expect(parts).toEqual([{ type: "data-shared-withheld", data: { reason: "pii" } }])
  })

  it("keeps the identity of parts that did not change", () => {
    const projector = createSharedAssistantProjector()
    const first = { type: "text", text: "one" }
    const call = tool("Read", { file_path: `${ROOT}/a.ts` })
    const a = projector.project("m", [first, call], "settled")
    const b = projector.project("m", [first, call, { type: "text", text: "two" }], "settled")
    expect(b[0]).toBe(a[0])
    expect(b[1]).toBe(a[1])
  })

  it("drops reasoning, files and data parts", () => {
    expect(
      settled([
        { type: "reasoning", text: "hidden" },
        { type: "file", url: "data:x" },
        { type: "data-x", data: {} },
      ])
    ).toEqual([])
  })
})

describe("tools, summary tier", () => {
  it("shares a workspace-relative path and diff stats, never the edit", () => {
    const [part] = settled(
      [tool("Edit", { file_path: `${ROOT}/src/a.ts`, old_string: "a\nb", new_string: "c" })],
      { workspaceRoot: ROOT }
    ) as Array<{ input: Record<string, unknown> }>
    expect(part!.input).toEqual({
      file_path: "src/a.ts",
      sharedDiffStats: { added: 1, removed: 2 },
    })
  })

  it("drops a path outside the workspace and an absolute path with no root", () => {
    const outside = settled([tool("Read", { file_path: "/etc/passwd" })], { workspaceRoot: ROOT })
    const noRoot = settled([tool("Read", { file_path: `${ROOT}/a.ts` })])
    expect((outside[0] as { input: unknown }).input).toEqual({})
    expect((noRoot[0] as { input: unknown }).input).toEqual({})
  })

  it("shares a patch's stats and file count, and a fetch's origin", () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"
    const [applied, fetched] = settled(
      [tool("apply_patch", { patch }), tool("WebFetch", { url: "https://u:p@h.test/p?q=1" })],
      { workspaceRoot: ROOT }
    ) as Array<{ input: Record<string, unknown> }>
    expect(applied!.input).toEqual({
      sharedDiffStats: { added: 2, removed: 1, files: 1 },
      paths: ["x.ts"],
    })
    expect(fetched!.input).toEqual({ url: "https://h.test" })
  })

  it("never shares a command in the summary tier", () => {
    const [part] = settled([tool("Bash", { command: "ls -la" })]) as Array<{ input: unknown }>
    expect(part!.input).toEqual({})
  })

  it("shares no input before the arguments are complete, nor for MCP tools", () => {
    const streaming = settled([tool("Read", { file_path: "a.ts" }, "input-streaming")])
    const mcp = settled([tool("mcp__github__create_issue", { title: "x" })])
    expect((streaming[0] as { input: unknown }).input).toEqual({})
    expect((mcp[0] as { input: unknown }).input).toEqual({})
  })
})

describe("tools, full tier", () => {
  const full = { tier: "full" as const, workspaceRoot: ROOT }

  it("shares a redacted, root-relative command", () => {
    const [part] = settled(
      [tool("Bash", { command: `cat ${ROOT}/a.ts && curl -H 'Authorization: Bearer abcdefghij'` })],
      full
    ) as Array<{ input: { command: string } }>
    expect(part!.input.command).toContain("cat a.ts")
    expect(part!.input.command).not.toContain("abcdefghij")
    expect(part!.input.command).not.toContain("/Users/alice")
  })

  it("reads an argv command the way the approval card does", () => {
    const [part] = settled(
      [tool("exec_command", { cmd: ["bash", "-lc", "echo hi"] })],
      full
    ) as Array<{ input: { command: string } }>
    expect(part!.input.command).toBe("bash -lc 'echo hi'")
  })

  it("drops a command that still names a home directory outside the root", () => {
    const [part] = settled([tool("Bash", { command: "cat /Users/bob/notes" })], full) as Array<{
      input: unknown
    }>
    expect(part!.input).toEqual({})
  })

  it("shares edits, patterns, queries and todos, and nothing it does not list", () => {
    const parts = settled(
      [
        tool("Edit", { file_path: `${ROOT}/a.ts`, old_string: "a", new_string: "b", extra: "x" }),
        tool("Grep", { pattern: "TODO", path: `${ROOT}/src` }),
        tool("WebSearch", { query: "jest timers" }),
        tool("TodoWrite", { todos: [{ content: "ship", status: "pending", id: "1" }] }),
      ],
      full
    ) as Array<{ input: Record<string, unknown> }>
    expect(parts.map((part) => part.input)).toEqual([
      {
        file_path: "a.ts",
        sharedDiffStats: { added: 1, removed: 1 },
        old_string: "a",
        new_string: "b",
      },
      { pattern: "TODO", path: "src" },
      { query: "jest timers" },
      { todos: [{ content: "ship", status: "pending" }] },
    ])
  })

  it("caps a long command", () => {
    const [part] = settled([tool("Bash", { command: "a".repeat(5_000) })], full) as Array<{
      input: { command: string }
    }>
    expect(part!.input.command.length).toBe(2_048)
  })

  it("shares only the patched files inside the workspace", () => {
    const patch = [
      `--- a/src/in.ts`,
      `+++ b/src/in.ts`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "--- a/../../sibling/private.conf",
      "+++ b/../../sibling/private.conf",
      "@@ -1 +1 @@",
      "-secret-old",
      "+secret-new",
      "--- /etc/private.conf",
      "+++ /etc/private.conf",
      "@@ -1 +1 @@",
      "-etc-old",
      "+etc-new",
    ].join("\n")
    const [part] = settled([tool("apply_patch", { patch })], full) as Array<{
      input: { patch: string; paths: string[] }
    }>
    expect(part!.input.patch).toContain("+new")
    expect(part!.input.patch).not.toContain("secret")
    expect(part!.input.patch).not.toContain("etc-")
    expect(part!.input.paths).toEqual(["src/in.ts"])
  })

  it("keeps a full fetch URL without its credentials", () => {
    const [part] = settled([tool("WebFetch", { url: "https://u:p@h.test/p" })], full) as Array<{
      input: { url: string }
    }>
    expect(part!.input.url).toBe("https://h.test/p")
  })
})

describe("tool results and the PII gate", () => {
  it("shares tool status while removing credentials and private tool input", () => {
    const parts = settled([
      {
        type: "tool-read",
        toolCallId: "call",
        state: "output-available",
        input: { password: "private" },
        output: { apiKey: "opaque-secret", result: "ok" },
      },
    ])
    expect(JSON.stringify(parts)).not.toContain("opaque-secret")
    expect(JSON.stringify(parts)).not.toContain("private")
    expect(JSON.stringify(parts)).toContain("ok")
  })

  it("keeps a failed tool's redacted error", () => {
    expect(
      settled([
        { type: "dynamic-tool", toolName: "read", state: "output-error", errorText: "failed" },
      ])
    ).toEqual([
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "",
        state: "output-error",
        input: {},
        errorText: "failed",
      },
    ])
  })

  it("withholds only the part that fails the PII gate and keeps the rest", () => {
    const parts = settled([
      { type: "text", text: "the build passed" },
      {
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "alice@example.com",
        state: "output-available",
        output: "ok",
      },
    ])
    expect(parts).toEqual([
      { type: "text", text: "the build passed" },
      { type: "data-shared-withheld", data: { reason: "pii" } },
    ])
  })
})
