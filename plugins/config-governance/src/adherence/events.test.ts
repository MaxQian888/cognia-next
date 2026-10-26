import { baseToolName, extractSessionEvents, normalizeToolCall, toolFamily } from "./events"

describe("tool names", () => {
  it("reduces MCP and dotted names and maps families across runtimes", () => {
    expect(baseToolName("mcp__fs__read_file")).toBe("read_file")
    expect(baseToolName("server.Bash")).toBe("bash")
    expect(toolFamily("Bash")).toBe("shell")
    expect(toolFamily("local_shell")).toBe("shell")
    expect(toolFamily("MultiEdit")).toBe("edit")
    expect(toolFamily("apply_patch")).toBe("edit")
    expect(toolFamily("Read")).toBe("read")
    expect(toolFamily("web_search")).toBe("other")
  })
})

describe("normalizeToolCall", () => {
  it("reads commands, argv and paths", () => {
    expect(normalizeToolCall("bash", { command: "pnpm test" })).toEqual({
      family: "shell",
      tool: "bash",
      command: "pnpm test",
      paths: [],
    })
    expect(normalizeToolCall("shell", { command: ["bash", "-lc", "git status"] }).command).toBe(
      "git status"
    )
    expect(normalizeToolCall("shell", { command: ["ls", "-la"] }).command).toBe("ls -la")
    expect(normalizeToolCall("Edit", { file_path: "/r/a.ts" }).paths).toEqual(["/r/a.ts"])
    expect(
      normalizeToolCall("MultiEdit", { edits: [{ file_path: "a.ts" }, { path: "b.ts" }] }).paths
    ).toEqual(["a.ts", "b.ts"])
    expect(
      normalizeToolCall("apply_patch", {
        input: "*** Begin Patch\n*** Update File: src/x.ts\n*** Add File: src/y.ts\n",
      }).paths
    ).toEqual(["src/x.ts", "src/y.ts"])
    expect(normalizeToolCall("write", "not an object")).toEqual({
      family: "edit",
      tool: "write",
      paths: [],
    })
  })
})

describe("extractSessionEvents", () => {
  it("orders tool calls and splits turns at user messages", () => {
    const events = extractSessionEvents("s", [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "ok" },
          { type: "tool-edit", input: { file_path: "a.ts" } },
          { type: "dynamic-tool", toolName: "Bash", input: { command: "pnpm test" } },
        ],
      },
      { id: "u2", role: "user", parts: [] },
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "tool-bash", args: { command: "git commit" } }],
      },
      { id: "sys", role: "system", parts: [{ type: "tool-bash", input: { command: "ignored" } }] },
    ])
    expect(events.turns).toBe(2)
    expect(
      events.events.map((event) => [
        event.turn,
        event.order,
        event.family,
        event.command ?? event.paths[0],
      ])
    ).toEqual([
      [0, 0, "edit", "a.ts"],
      [0, 1, "shell", "pnpm test"],
      [1, 2, "shell", "git commit"],
    ])
  })

  it("counts a session without user messages as one turn when it has calls", () => {
    expect(
      extractSessionEvents("s", [
        { id: "a", role: "assistant", parts: [{ type: "tool-read", input: { path: "x" } }] },
      ]).turns
    ).toBe(1)
    expect(extractSessionEvents("s", []).turns).toBe(0)
  })
})
