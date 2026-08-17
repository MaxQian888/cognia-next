import { claudeCodeSessionSource, parseClaudeTranscript, summarizeClaudeFile } from "./claude-code"
import type { SessionScanInput } from "../types"

const LINES = [
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId: "sess-1",
    cwd: "/proj",
    timestamp: "2025-01-01T00:00:00Z",
    message: { role: "user", content: "Hello world" },
  },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    sessionId: "sess-1",
    timestamp: "2025-01-01T00:00:01Z",
    message: {
      role: "assistant",
      model: "claude-opus",
      content: [
        { type: "thinking", thinking: "let me look" },
        { type: "text", text: "Running a command" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { cmd: "ls" } },
      ],
    },
  },
  {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    sessionId: "sess-1",
    timestamp: "2025-01-01T00:00:02Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "file.txt", is_error: false },
      ],
    },
  },
]

const CONTENT = LINES.map((l) => JSON.stringify(l)).join("\n") + "\n{bad json\n"

describe("parseClaudeTranscript", () => {
  it("parses turns, folds tool_result into the tool part, and skips corrupt lines", () => {
    const parsed = parseClaudeTranscript(CONTENT, "/proj/sess-1.jsonl")
    expect(parsed.originalSessionId).toBe("sess-1")
    expect(parsed.cwd).toBe("/proj")
    expect(parsed.model).toBe("claude-opus")
    expect(parsed.title).toBe("Hello world")
    // user + assistant only; the tool_result-only user row is folded.
    expect(parsed.messages).toHaveLength(2)

    const assistant = parsed.messages[1]
    const parts = assistant.parts as Array<Record<string, unknown>>
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "text", "tool-Bash"])
    const tool = parts[2]
    expect(tool.state).toBe("output-available")
    expect(tool.output).toBe("file.txt")
    expect(assistant.id).toBe("import:claude-code:sess-1:m1")
  })

  it("maps a base64 image block to a file part", () => {
    const line = JSON.stringify({
      type: "user",
      sessionId: "s",
      timestamp: "2025-01-01T00:00:00Z",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    })
    const parsed = parseClaudeTranscript(line, "s.jsonl")
    const part = (parsed.messages[0].parts as Array<Record<string, unknown>>)[0]
    expect(part.type).toBe("file")
    expect(part.url).toBe("data:image/png;base64,AAAA")
  })

  it("marks an errored tool_result on the tool part", () => {
    const lines = [
      {
        type: "assistant",
        sessionId: "s",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
        },
      },
      {
        type: "user",
        sessionId: "s",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "denied", is_error: true }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseClaudeTranscript(lines, "s.jsonl")
    const tool = (parsed.messages[0].parts as Array<Record<string, unknown>>)[0]
    expect(tool.state).toBe("output-error")
    expect(tool.errorText).toBe("denied")
  })

  it("captures assistant usage + model into metadata", () => {
    const lines = [
      {
        type: "user",
        sessionId: "s",
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant",
        sessionId: "s",
        timestamp: "2025-01-01T00:00:01Z",
        costUSD: 0.03,
        durationMs: 1200,
        message: {
          role: "assistant",
          model: "claude-opus",
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 200,
          },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseClaudeTranscript(lines, "s.jsonl")
    const meta = parsed.messages[1].metadata as {
      usage?: Record<string, number>
      model?: string
    }
    expect(meta.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 200,
      totalCostUsd: 0.03,
      durationMs: 1200,
    })
    expect(meta.model).toBe("claude-opus")
    // A user turn carries no usage metadata.
    expect(parsed.messages[0].metadata).toBeUndefined()
  })

  it("omits usage metadata for an all-zero usage block", () => {
    const line = JSON.stringify({
      type: "assistant",
      sessionId: "s",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    const parsed = parseClaudeTranscript(line, "s.jsonl")
    expect(parsed.messages[0].metadata).toBeUndefined()
  })

  it("linearizes to the active leaf, dropping an abandoned edit branch", () => {
    const lines = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:01Z",
        message: { role: "user", content: "first" },
      },
      // Abandoned re-run of the answer (older).
      {
        type: "assistant",
        uuid: "a_old",
        parentUuid: "u1",
        sessionId: "s",
        timestamp: "2025-01-01T00:00:02Z",
        message: { role: "assistant", content: [{ type: "text", text: "ABANDONED" }] },
      },
      // The kept answer (newer) → the active leaf.
      {
        type: "assistant",
        uuid: "a_new",
        parentUuid: "u1",
        sessionId: "s",
        timestamp: "2025-01-01T00:00:05Z",
        message: { role: "assistant", content: [{ type: "text", text: "KEPT" }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseClaudeTranscript(lines, "s.jsonl")
    const texts = parsed.messages.flatMap((m) =>
      (m.parts as Array<Record<string, unknown>>).map((p) => p.text)
    )
    expect(texts).toContain("KEPT")
    expect(texts).not.toContain("ABANDONED")
  })

  it("includes system records (previously dropped)", () => {
    const lines = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "hi" },
      },
      {
        type: "system",
        uuid: "sys1",
        parentUuid: "u1",
        sessionId: "s",
        timestamp: "2025-01-01T00:00:01Z",
        content: "Hook ran: format.sh",
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseClaudeTranscript(lines, "s.jsonl")
    const sys = parsed.messages.find((m) => m.role === "system")
    expect(sys).toBeTruthy()
    expect((sys!.parts as Array<Record<string, unknown>>)[0].text).toBe("Hook ran: format.sh")
  })

  it("falls back to structured toolUseResult when the result block is empty", () => {
    const lines = [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: null,
        sessionId: "s",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "Read", input: {} }],
        },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        sessionId: "s",
        toolUseResult: { filePath: "/x.ts", lines: 42 },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "" }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseClaudeTranscript(lines, "s.jsonl")
    const tool = (parsed.messages[0].parts as Array<Record<string, unknown>>)[0]
    expect(tool.state).toBe("output-available")
    expect(tool.output).toEqual({ filePath: "/x.ts", lines: 42 })
  })

  it("extracts subagent sidechains out of the main thread", () => {
    const lines = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "do it" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s",
        timestamp: "2025-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "task-1", name: "Task", input: { prompt: "sub" } }],
        },
      },
      // Sidechain (subagent) turns — must NOT appear in the main thread.
      {
        type: "user",
        uuid: "sc1",
        parentUuid: "a1",
        isSidechain: true,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:02Z",
        message: { role: "user", content: "sub prompt" },
      },
      {
        type: "assistant",
        uuid: "sc2",
        parentUuid: "sc1",
        isSidechain: true,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:03Z",
        message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT OUTPUT" }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseClaudeTranscript(lines, "s.jsonl")
    // Main thread has the user turn + the assistant Task turn only.
    const mainTexts = parsed.messages.flatMap((m) =>
      (m.parts as Array<Record<string, unknown>>).map((p) => p.text ?? p.type)
    )
    expect(mainTexts).not.toContain("SUBAGENT OUTPUT")
    // The sidechain is captured for reconstruction.
    expect(parsed.sidechains).toHaveLength(1)
    expect(parsed.sidechains[0].spawnParentUuid).toBe("a1")
    expect(parsed.sidechains[0].records.map((r) => r.uuid)).toEqual(["sc1", "sc2"])
  })

  it("reconstructs a subagent snapshot on the spawning turn + a nested session", () => {
    const lines = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:00Z",
        message: { role: "user", content: "do it" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: "s",
        timestamp: "2025-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "task-1",
              name: "Task",
              input: { subagent_type: "researcher", prompt: "sub" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "sc1",
        parentUuid: "a1",
        isSidechain: true,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:02Z",
        message: { role: "user", content: "sub prompt" },
      },
      {
        type: "assistant",
        uuid: "sc2",
        parentUuid: "sc1",
        isSidechain: true,
        sessionId: "s",
        timestamp: "2025-01-01T00:00:03Z",
        message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT DONE" }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseClaudeTranscript(lines, "s.jsonl")

    // The spawning assistant turn now carries a subagent part.
    const spawnTurn = parsed.messages.find((m) =>
      (m.parts as Array<Record<string, unknown>>).some((p) => p.type === "subagent")
    )
    expect(spawnTurn).toBeTruthy()
    const subPart = (spawnTurn!.parts as Array<Record<string, unknown>>).find(
      (p) => p.type === "subagent"
    )!
    expect(subPart.name).toBe("researcher")
    expect(subPart.status).toBe("completed")
    expect(subPart.nestedSessionId).toBe("import:claude-code:s:sub:sc1")

    // A hidden nested session with the full inner transcript is produced.
    expect(parsed.nestedConversations).toHaveLength(1)
    const nested = parsed.nestedConversations[0]
    expect(nested.session.kind).toBe("subagent")
    expect(nested.session.branchSeed).toBeUndefined() // read-only, no continuation
    expect(nested.session.id).toBe("import:claude-code:s:sub:sc1")
    const nestedTexts = nested.messages.flatMap((m) =>
      (m.parts as Array<Record<string, unknown>>).map((p) => p.text)
    )
    expect(nestedTexts).toContain("SUBAGENT DONE")
  })
})

describe("claudeCodeSessionSource", () => {
  const fs = {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  }

  it("advertises the projects scan root", () => {
    expect(claudeCodeSessionSource.scanRoots("/home/u")).toEqual([
      expect.stringContaining(".claude"),
    ])
    expect(claudeCodeSessionSource.scanRoots("")).toEqual([])
  })

  it("prefers the resolved $CLAUDE_CONFIG_DIR root over <home>/.claude", () => {
    const roots = {
      claudeConfigDir: "/relocated/claude",
      codexHome: "",
      opencodeConfigDir: "",
      opencodeDataDir: "",
      piAgentDir: "",
      piSessionDir: "",
    }
    expect(claudeCodeSessionSource.scanRoots("/home/u", roots)).toEqual([
      "/relocated/claude/projects",
    ])
    // A blank override falls back to the home-relative default.
    expect(claudeCodeSessionSource.scanRoots("/home/u", { ...roots, claudeConfigDir: "" })).toEqual(
      ["/home/u/.claude/projects"]
    )
  })

  it("detects by path hint and content sniff", () => {
    expect(
      claudeCodeSessionSource.detect([
        { name: "s.jsonl", path: "/home/.claude/projects/x/s.jsonl", content: "" },
      ])
    ).toBe("match")
    expect(
      claudeCodeSessionSource.detect([
        { name: "s.jsonl", path: "/tmp/s.jsonl", content: JSON.stringify(LINES[1]) },
      ])
    ).toBe("maybe")
    expect(claudeCodeSessionSource.detect([])).toBe("no")
  })

  it("lists and parses from picked files", async () => {
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [{ name: "sess-1.jsonl", path: "/p/sess-1.jsonl", content: CONTENT }],
    }
    const list = await claudeCodeSessionSource.listSessions(input)
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Hello world")
    const conv = await claudeCodeSessionSource.parseSession(list[0].ref, input)
    expect(conv.session.id).toBe("import:claude-code:sess-1")
    expect(conv.session.workingDir).toBe("/proj")
    expect(conv.messages).toHaveLength(2)
  })
})

describe("summarizeClaudeFile (lightweight scan)", () => {
  it("pulls title/cwd/count/timestamps without a full parse", () => {
    const s = summarizeClaudeFile(CONTENT, "/p/sess-1.jsonl")
    expect(s).not.toBeNull()
    expect(s!.title).toBe("Hello world") // first user text
    expect(s!.cwd).toBe("/proj")
    expect(s!.ref.originalSessionId).toBe("sess-1")
    expect(s!.ref.locator).toBe("/p/sess-1.jsonl")
    // 3 user/assistant records in the fixture (approximate count).
    expect(s!.messageCount).toBe(3)
    expect(s!.updatedAt).toBe(Date.parse("2025-01-01T00:00:02Z"))
  })

  it("returns null for a transcript with no user/assistant records", () => {
    const only = JSON.stringify({ type: "summary", summary: "recap" })
    expect(summarizeClaudeFile(only, "/p/x.jsonl")).toBeNull()
  })

  it("falls back past a text-less first user turn when deriving the title", () => {
    const lines = [
      { type: "summary", summary: "Investigate flake" },
      // First user turn carries only a tool_result (no text) — firstText yields "".
      {
        type: "user",
        sessionId: "s9",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "" }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const s = summarizeClaudeFile(lines, "/p/s9.jsonl")
    expect(s!.title).toBe("Investigate flake") // summary used since no user text
    expect(s!.messageCount).toBe(1)
  })

  it("falls back to the summary record for the title, then the locator id", () => {
    const lines = [
      { type: "summary", summary: "Refactor the parser" },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const s = summarizeClaudeFile(lines, "/p/no-session.jsonl")
    expect(s!.title).toBe("Refactor the parser")
    expect(s!.ref.originalSessionId).toBe("/p/no-session.jsonl") // no sessionId on records
  })
})
