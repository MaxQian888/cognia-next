import { claudeCodeSessionSource, parseClaudeTranscript } from "./claude-code"
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
