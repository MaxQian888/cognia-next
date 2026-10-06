import {
  detectPiSession,
  isSupportedPiHeader,
  parsePiSessionFile,
  PI_HISTORY_FORMAT,
  readPiSession,
  summarizePiSession,
} from "./history"

const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n")
const header = (extra: Record<string, unknown> = {}) => ({
  type: "session",
  version: 3,
  id: "pi-1",
  timestamp: "2026-08-01T00:00:00.000Z",
  cwd: "/repo",
  ...extra,
})
const at = (second: number) => `2026-08-01T00:00:${String(second).padStart(2, "0")}.000Z`

describe("parsePiSessionFile", () => {
  it("keeps the header apart and counts unparseable or non-object lines", () => {
    const parsed = parsePiSessionFile(
      [
        JSON.stringify(header()),
        "{truncated",
        "[1,2]",
        "null",
        JSON.stringify({ type: "label" }),
        "",
      ].join("\n")
    )
    expect(parsed.header?.id).toBe("pi-1")
    expect(parsed.entries).toEqual([{ type: "label" }])
    expect(parsed.corruptLines).toBe(3)
  })

  it("accepts the three format versions and a header that predates the field", () => {
    expect(isSupportedPiHeader(null)).toBe(false)
    expect(isSupportedPiHeader({ type: "session" })).toBe(true)
    for (const version of [1, 2, 3])
      expect(isSupportedPiHeader({ type: "session", version })).toBe(true)
    expect(isSupportedPiHeader({ type: "session", version: 4 })).toBe(false)
  })
})

describe("readPiSession", () => {
  it("folds tool results onto their call and keeps model, usage and title", () => {
    const read = readPiSession(
      jsonl(
        header(),
        {
          type: "message",
          id: "a",
          parentId: null,
          timestamp: at(1),
          message: { role: "user", content: "Fix it" },
        },
        {
          type: "message",
          id: "b",
          parentId: "a",
          timestamp: at(2),
          message: {
            role: "assistant",
            provider: "deepseek",
            model: "chat",
            usage: {
              input: 10,
              output: 4,
              reasoning: 1,
              cacheRead: 2,
              cacheWrite: 3,
              costUsd: 0.5,
            },
            content: [
              { type: "thinking", thinking: "plan" },
              { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
              { type: "toolCall", id: "t2", name: "bash", arguments: { command: "false" } },
              { type: "image", data: "AA", mimeType: "image/jpeg" },
            ],
          },
        },
        {
          type: "message",
          id: "c",
          parentId: "b",
          timestamp: at(3),
          message: {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "read",
            content: [{ type: "text", text: "body" }],
          },
        },
        {
          type: "message",
          id: "d",
          parentId: "c",
          timestamp: at(4),
          message: {
            role: "toolResult",
            toolCallId: "t2",
            toolName: "bash",
            isError: true,
            content: "exit 1",
          },
        }
      ),
      "/sessions/file.jsonl"
    )
    const { session } = read
    expect(session.sourceId).toBe(PI_HISTORY_FORMAT.sourceId)
    expect(session.originalSessionId).toBe("pi-1")
    expect(session.title).toBe("Fix it")
    expect(session.model).toBe("deepseek/chat")
    expect(session.cwd).toBe("/repo")
    expect(session.updatedAt).toBe(Date.parse(at(2)))
    expect(session.messages).toHaveLength(2)
    expect(session.messages[1]).toEqual({
      role: "assistant",
      createdAt: Date.parse(at(2)),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 3,
        totalCostUsd: 0.5,
      },
      usageModel: "chat",
      parts: [
        { type: "reasoning", text: "plan" },
        {
          type: "tool",
          name: "read",
          toolCallId: "t1",
          input: { path: "a.ts" },
          result: { ok: true, output: "body" },
        },
        {
          type: "tool",
          name: "bash",
          toolCallId: "t2",
          input: { command: "false" },
          result: { ok: false, errorText: "exit 1" },
        },
        { type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AA" },
      ],
    })
    expect(session.losses).toEqual([])
    expect(session.messages[0]!.annotations).toBeUndefined()
    expect(read.branches).toEqual([])
    expect(read.sessionVersion).toBe(3)
  })

  it("keeps orphan results, bash runs, injected context and summaries, and reports what it cannot carry", () => {
    // A linear chain: every entry links to the one before it.
    const rows: Record<string, unknown>[] = [
      {
        type: "message",
        id: "e1",
        timestamp: at(1),
        message: { role: "toolResult", toolCallId: "x", content: "lost" },
      },
      {
        type: "message",
        id: "b1",
        timestamp: at(2),
        message: { role: "bashExecution", command: "ls", output: "a" },
      },
      { type: "message", timestamp: at(3), message: { role: "bashExecution" } },
      { type: "custom_message", timestamp: at(4), content: "context" },
      { type: "compaction", timestamp: at(5), summary: "earlier" },
      { type: "branch_summary", timestamp: at(6) },
      { type: "model_change", provider: "p", modelId: "m2", timestamp: at(7) },
      {
        type: "message",
        timestamp: at(8),
        message: { role: "assistant", model: "m3", content: "ok" },
      },
      { type: "custom", customType: "todo", timestamp: at(9) },
      { type: "custom", customType: "todo", timestamp: at(10) },
      { type: "mystery", timestamp: at(11) },
      { type: "label", timestamp: at(12) },
    ]
    let previous: string | null = null
    const chained = rows.map((row, index) => {
      const id = (row.id as string | undefined) ?? `n${index}`
      const linked = { ...row, id, parentId: previous }
      previous = id
      return linked
    })
    // The bash run without an id of its own falls back to a positional call id.
    delete (chained[2] as { id?: string }).id
    chained[3]!.parentId = null
    const read = readPiSession(
      [
        JSON.stringify(header({ version: undefined, id: undefined })),
        ...chained.slice(0, 3).map((row) => JSON.stringify(row)),
        "{cut",
      ].join("\n"),
      "/sessions/fallback.jsonl"
    )
    expect(read.session.originalSessionId).toBe("/sessions/fallback.jsonl")
    expect(read.sessionVersion).toBe(1)

    const full = readPiSession(
      [
        JSON.stringify(header()),
        ...chained.slice(3).map((row) => JSON.stringify(row)),
        "{cut",
      ].join("\n"),
      "loc"
    )
    expect(full.session.title).toBe("Pi session")
    expect(full.session.model).toBe("m3")
    expect(full.session.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "context" }],
      [{ type: "text", text: "earlier" }],
      [{ type: "text", text: "ok" }],
    ])
    // A model with no counts keeps the model; the notes ride the first message.
    expect(full.session.messages[2]!.annotations).toEqual({ model: "m3" })
    expect(full.session.messages[0]!.annotations).toEqual({
      piImport: {
        sessionVersion: 3,
        notes: { "custom:todo": 2, "unknown:mystery": 1, corrupt_lines: 1 },
      },
    })
    expect(full.session.losses.map((loss) => [loss.path, loss.kind])).toEqual([
      ["entries.custom.todo", "dropped"],
      ["entries.mystery", "dropped"],
      ["lines", "dropped"],
    ])
  })

  it("keeps an orphan tool result as text and numbers an id-less bash run by position", () => {
    const read = readPiSession(
      jsonl(
        header(),
        {
          type: "message",
          id: "a",
          parentId: null,
          timestamp: at(1),
          message: { role: "toolResult", toolCallId: "x", content: "lost" },
        },
        {
          type: "message",
          id: "b",
          parentId: "a",
          timestamp: at(2),
          message: { role: "bashExecution", command: "ls", output: "out" },
        },
        {
          type: "message",
          id: "c",
          parentId: "b",
          timestamp: at(3),
          message: { role: "bashExecution" },
        }
      ),
      "loc"
    )
    expect(read.session.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "lost" }],
      [
        {
          type: "tool",
          name: "bash",
          toolCallId: "b",
          input: { command: "ls" },
          result: { ok: true, output: "out" },
        },
      ],
      [{ type: "tool", name: "bash", toolCallId: "c", input: { command: "" } }],
    ])
    expect(read.session.losses.map((loss) => [loss.path, loss.kind])).toEqual([
      ["entries.toolResult", "approximated"],
    ])
    // A linear legacy file with no ids at all is read in file order.
    const legacy = readPiSession(
      jsonl(
        { type: "session", cwd: "/r" },
        { type: "message", timestamp: at(1), message: { role: "user", content: "q" } },
        { type: "message", timestamp: at(2), message: { role: "bashExecution", command: "pwd" } }
      ),
      "legacy.jsonl"
    )
    expect(legacy.session.messages[1]!.parts).toEqual([
      { type: "tool", name: "bash", toolCallId: "bash-2", input: { command: "pwd" } },
    ])
  })

  it("records a fork origin even for a clean file", () => {
    const read = readPiSession(
      jsonl(
        header({
          parentSession: "C:\\Users\\me\\.pi\\agent\\sessions\\--repo--\\2026_parent.jsonl",
        }),
        { type: "message", id: "a", timestamp: at(1), message: { role: "user", content: "hi" } }
      ),
      "loc"
    )
    expect(read.forkedFrom).toContain("2026_parent.jsonl")
    expect(read.session.relationKind).toBe("fork")
    expect(read.session.parentNativeSessionId).toBe("2026_parent")
    expect(read.session.messages[0]!.annotations).toEqual({
      piImport: { sessionVersion: 3, forkedFrom: read.forkedFrom },
    })
  })

  it("reads every alternate leaf as a branch, newest first, and skips empty ones", () => {
    const read = readPiSession(
      jsonl(
        header(),
        {
          type: "message",
          id: "root",
          parentId: null,
          timestamp: at(1),
          message: { role: "user", content: "start" },
        },
        {
          type: "message",
          id: "old",
          parentId: "root",
          timestamp: at(2),
          message: { role: "assistant", content: "old" },
        },
        { type: "label", id: "quiet", parentId: "root", timestamp: at(3) },
        {
          type: "message",
          id: "mid",
          parentId: "root",
          timestamp: at(4),
          message: { role: "user", content: "retry" },
        },
        { type: "custom", id: "ext", parentId: "mid", timestamp: at(5), customType: "x" },
        {
          type: "message",
          id: "new",
          parentId: "root",
          timestamp: at(6),
          message: { role: "assistant", content: "new" },
        }
      ),
      "loc"
    )
    expect(read.session.messages.map((message) => message.parts[0])).toEqual([
      { type: "text", text: "start" },
      { type: "text", text: "new" },
    ])
    expect(read.branches.map((branch) => branch.leafId)).toEqual(["ext", "quiet", "old"])
    const [ext, quiet, old] = read.branches
    expect(ext!.session).toMatchObject({
      title: "start",
      relationKind: "branch",
      parentNativeSessionId: "pi-1",
      updatedAt: Date.parse(at(4)),
    })
    expect(ext!.session.losses.map((loss) => loss.path)).toEqual(["entries.custom.x"])
    expect(quiet!.session.messages).toHaveLength(1)
    expect(old!.session.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  })
})

describe("summarizePiSession", () => {
  it("counts message entries, titles from the first user text and keeps the newest timestamp", () => {
    const summary = summarizePiSession(
      jsonl(
        header(),
        {
          type: "message",
          timestamp: at(3),
          message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        },
        { type: "message", timestamp: at(9), message: { role: "assistant", content: "Hi" } },
        { type: "label", timestamp: at(12) }
      ),
      "/s/a.jsonl"
    )
    expect(summary).toEqual({
      sourceId: "pi",
      originalSessionId: "pi-1",
      title: "Hello",
      messageCount: 2,
      updatedAt: Date.parse(at(12)),
      cwd: "/repo",
    })
  })

  it("skips unsupported, headerless and empty files", () => {
    expect(summarizePiSession(jsonl(header({ version: 9 })), "x")).toBeNull()
    expect(
      summarizePiSession(jsonl({ type: "message", message: { role: "user", content: "hi" } }), "x")
    ).toBeNull()
    expect(summarizePiSession(jsonl(header()), "x")).toBeNull()
  })
})

describe("detectPiSession", () => {
  const file = (path: string, content: string) => ({ path, name: path, content })
  it("matches Pi paths or a session header with a cwd", () => {
    expect(detectPiSession([file("/home/u/.pi/agent/sessions/a.jsonl", "")])).toBe("match")
    expect(detectPiSession([file("C:\\Users\\u\\.pi\\agent\\s.jsonl", "")])).toBe("match")
    expect(detectPiSession([file("/tmp/a.jsonl", `\n${JSON.stringify(header())}`)])).toBe("match")
    expect(detectPiSession([file("/tmp/a.jsonl", JSON.stringify({ type: "session" }))])).toBe("no")
    expect(detectPiSession([file("/tmp/a.jsonl", "not json")])).toBe("no")
    expect(detectPiSession([file("/tmp/a.jsonl", "")])).toBe("no")
  })
})
