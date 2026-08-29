import { geminiCliSessionSource, parseGeminiChat } from "./gemini-cli"
import type { SessionScanInput } from "../types"

const LINES = [
  {
    sessionId: "gem-1",
    projectHash: "abc",
    startTime: "2025-01-01T00:00:00Z",
    directories: ["/work"],
  },
  { id: "m1", timestamp: "2025-01-01T00:00:01Z", type: "user", content: [{ text: "fix the bug" }] },
  {
    id: "m2",
    timestamp: "2025-01-01T00:00:02Z",
    type: "gemini",
    content: [{ text: "done" }],
    thoughts: [{ text: "planning" }],
    toolCalls: [
      { id: "c1", name: "shell", args: { cmd: "ls" }, result: "a.txt", status: "success" },
    ],
    tokens: { input: 100, output: 20 },
    model: "gemini-2.5",
  },
  { $set: { lastUpdated: "2025-01-01T00:00:03Z" } },
]
const CONTENT = LINES.map((l) => JSON.stringify(l)).join("\n")

describe("parseGeminiChat", () => {
  it("reconstructs user + gemini turns with thoughts, tools, and usage", () => {
    const parsed = parseGeminiChat(CONTENT, "chat.jsonl")
    expect(parsed.originalSessionId).toBe("gem-1")
    expect(parsed.cwd).toBe("/work")
    expect(parsed.model).toBe("gemini-2.5")
    expect(parsed.title).toBe("fix the bug")
    expect(parsed.messages).toHaveLength(2)

    const asst = parsed.messages[1].parts as Array<Record<string, unknown>>
    expect(asst.map((p) => p.type)).toEqual(["reasoning", "text", "tool-shell"])
    expect(asst[2].output).toBe("a.txt")
    expect(asst[2].input).toEqual({ cmd: "ls" })
    const meta = parsed.messages[1].metadata as { usage?: Record<string, number> }
    expect(meta.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 })
  })

  it("emits system markers for info/error records and skips empty content", () => {
    const lines = [
      { type: "user", content: [{ text: "hi" }] },
      { type: "info", content: [{ text: "compaction happened" }] },
      { type: "error", content: [{ text: "rate limited" }] },
      { type: "gemini", content: [] }, // empty → dropped
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseGeminiChat(lines, "c.jsonl")
    const systems = parsed.messages.filter((m) => m.role === "system")
    expect(systems.map((m) => (m.parts[0] as Record<string, unknown>).text)).toEqual([
      "compaction happened",
      "rate limited",
    ])
  })

  it("marks a failed tool call as an error and applies rewind records", () => {
    const lines = [
      {
        id: "m1",
        type: "gemini",
        content: [{ text: "x" }],
        toolCalls: [{ id: "c1", name: "shell", args: {}, result: "denied", status: "error" }],
      },
      { id: "m2", type: "user", content: [{ text: "discard me" }] },
      { $rewindTo: "m2" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseGeminiChat(lines, "c.jsonl")
    const tool = (parsed.messages[0].parts as Array<Record<string, unknown>>).find((p) =>
      String(p.type).startsWith("tool-")
    )!
    expect(tool.state).toBe("output-error")
    expect(parsed.messages).toHaveLength(1)
  })

  it("applies metadata updates and message checkpoints in insertion order", () => {
    const content = [
      { sessionId: "gem-checkpoint", directories: ["/old"], kind: "main" },
      { id: "old", type: "user", content: [{ text: "old prompt" }] },
      {
        $set: {
          directories: ["/new"],
          kind: "subagent",
          memoryScratchpad: "remember this",
          messages: [
            { id: "fresh", type: "user", content: [{ text: "fresh prompt" }] },
            { id: "answer", type: "gemini", content: [{ text: "fresh answer" }] },
          ],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")

    const parsed = parseGeminiChat(content, "/tmp/chats/parent/gem-checkpoint.jsonl")
    expect(parsed.cwd).toBe("/new")
    expect(parsed.kind).toBe("subagent")
    expect(parsed.memoryScratchpad).toBe("remember this")
    expect(parsed.messages).toHaveLength(2)
    expect((parsed.messages[0].parts[0] as { text: string }).text).toBe("fresh prompt")
  })

  it("parses the official JSON content-array export including tools and media", () => {
    const content = JSON.stringify([
      {
        role: "user",
        parts: [{ text: "inspect this" }, { inlineData: { mimeType: "image/png", data: "YWJj" } }],
      },
      {
        role: "model",
        parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "read_file", response: { output: "ok" } } }],
      },
    ])
    const parsed = parseGeminiChat(content, "shared.json")

    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[0].parts.map((part) => part.type)).toEqual(["text", "file"])
    expect(parsed.messages[1].parts[0].type).toBe("tool-read_file")
    expect((parsed.messages[2].parts[0] as { type: string }).type).toBe("tool-read_file")
  })

  it("preserves display content, tool agent identity, warnings, and token classes", () => {
    const content = [
      { sessionId: "rich" },
      { id: "warn", type: "warning", content: [{ text: "context nearly full" }] },
      {
        id: "answer",
        type: "gemini",
        content: [{ text: "internal" }],
        displayContent: [{ text: "visible" }],
        toolCalls: [
          {
            id: "call",
            name: "delegate",
            args: {},
            status: "success",
            result: "done",
            agentId: "researcher",
            displayName: "Research agent",
            description: "Find evidence",
            resultDisplay: "Evidence found",
          },
        ],
        tokens: { input: 10, output: 8, cached: 4, thoughts: 3, tool: 2, total: 18 },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")
    const parsed = parseGeminiChat(content, "rich.jsonl")

    expect(parsed.messages[0].role).toBe("system")
    const assistant = parsed.messages[1]
    expect((assistant.parts[0] as { text: string }).text).toBe("visible")
    expect(assistant.metadata).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 8, cacheReadInputTokens: 4, reasoningTokens: 3 },
      geminiTokens: { tool: 2, total: 18 },
    })
    expect(assistant.parts[1]).toMatchObject({
      agentId: "researcher",
      displayName: "Research agent",
      description: "Find evidence",
      resultDisplay: "Evidence found",
    })
  })
})

describe("geminiCliSessionSource", () => {
  const fs = {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  }

  it("detects by path hint", () => {
    expect(
      geminiCliSessionSource.detect([
        { name: "s.jsonl", path: "/home/.gemini/tmp/abc/chats/s.jsonl", content: "" },
      ])
    ).toBe("match")
    expect(geminiCliSessionSource.detect([])).toBe("no")
  })

  it("lists and parses from picked files", async () => {
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [{ name: "s.jsonl", path: "/p/s.jsonl", content: CONTENT }],
    }
    const list = await geminiCliSessionSource.listSessions(input)
    expect(list).toHaveLength(1)
    const conv = await geminiCliSessionSource.parseSession(list[0].ref, input)
    expect(conv.session.id).toBe("import:gemini-cli:gem-1")
  })

  it("keeps scratchpad, summary compaction, and tool agent identity in the graph", async () => {
    const content = [
      {
        sessionId: "rich-graph",
        summary: "older context",
        memoryScratchpad: "private working memory",
      },
      { id: "u1", type: "user", content: [{ text: "delegate" }] },
      {
        id: "a1",
        type: "gemini",
        content: [{ text: "working" }],
        toolCalls: [
          {
            id: "call-1",
            name: "delegate",
            args: {},
            status: "success",
            result: "done",
            agentId: "researcher",
          },
        ],
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [{ name: "rich.jsonl", path: "/p/rich.jsonl", content }],
    }

    const ref = (await geminiCliSessionSource.listSessions(input))[0].ref
    const conversation = await geminiCliSessionSource.parseSession(ref, input)
    expect(conversation.session.scratchpad).toBe("private working memory")
    const graph = await geminiCliSessionSource.parseGraph!(ref, input)
    expect(graph.nodes[0].session.history?.[0]).toMatchObject({
      kind: "compaction",
      summary: "older context",
    })
    expect(graph.nodes[0].session.turns[1].toolCalls?.[0]).toMatchObject({
      callId: "call-1",
      taskId: "researcher",
    })
  })

  it("accepts official .json exports and keeps nested subagents out of the root list", async () => {
    const exportContent = JSON.stringify([{ role: "user", parts: [{ text: "exported" }] }])
    const subagent = [
      { sessionId: "child", kind: "subagent" },
      { id: "c1", type: "user", content: [{ text: "research" }] },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [
        { name: "shared.json", path: "/picked/shared.json", content: exportContent },
        { name: "child.jsonl", path: "/picked/chats/gem-1/child.jsonl", content: subagent },
        { name: "s.jsonl", path: "/picked/chats/s.jsonl", content: CONTENT },
      ],
    }
    const list = await geminiCliSessionSource.listSessions(input)
    expect(geminiCliSessionSource.acceptedExtensions).toContain(".json")
    expect(list.map((item) => item.ref.originalSessionId)).toEqual(
      expect.arrayContaining(["shared.json", "gem-1"])
    )
    expect(list.some((item) => item.ref.originalSessionId === "child")).toBe(false)

    const main = list.find((item) => item.ref.originalSessionId === "gem-1")!
    const conversation = await geminiCliSessionSource.parseSession(main.ref, input)
    expect(conversation.nested).toHaveLength(1)
    expect(conversation.nested?.[0].session).toMatchObject({
      id: "import:gemini-cli:child",
      kind: "subagent",
      parentSessionId: "import:gemini-cli:gem-1",
    })
  })

  it("auto-scans the tmp dir recursively and parses via the fs", async () => {
    const dir = "/home/u/.gemini/tmp/abc/chats"
    const files: Record<string, string> = { [`${dir}/s.jsonl`]: CONTENT }
    const paths = Object.keys(files)
    const scanFs = {
      exists: async () => true,
      readDir: async (d: string) =>
        paths
          .filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes("/"))
          .map((p) => p.slice(d.length + 1))
          .concat(
            // surface intermediate dir names so walkFiles recurses
            [
              ...new Set(
                paths
                  .filter((p) => p.startsWith(`${d}/`))
                  .map((p) => p.slice(d.length + 1).split("/")[0])
              ),
            ].filter((n) => !paths.includes(`${d}/${n}`))
          ),
      stat: async (p: string) => ({ size: 0, isFile: p in files }),
      readTextFile: async (p: string) => files[p] ?? "",
    }
    const input: SessionScanInput = { fs: scanFs, home: "/home/u" }
    const list = await geminiCliSessionSource.listSessions(input)
    expect(list).toHaveLength(1)
    const conv = await geminiCliSessionSource.parseSession(list[0].ref, input)
    expect(conv.session.id).toBe("import:gemini-cli:gem-1")
  })

  it("content-sniffs a gemini metadata first line without a path hint", () => {
    const meta = JSON.stringify({ sessionId: "g", projectHash: "abc" })
    expect(
      geminiCliSessionSource.detect([{ name: "s.jsonl", path: "/tmp/s.jsonl", content: meta }])
    ).toBe("maybe")
  })

  describe("scan roots", () => {
    it("prefers the resolved vendor root over a bare home join", () => {
      // Only the Rust resolver can see where a vendor's tree really lives; this
      // adapter used to derive the path itself from `home`, one of only two that
      // still did (`lib/agent-roots/index.ts` was written to end exactly that).
      const roots = { geminiDir: "/relocated/vendor" } as never
      expect(geminiCliSessionSource.scanRoots("/home/u", roots)).toEqual(["/relocated/vendor/tmp"])
    })

    it("falls back to the home-relative path when the root is unresolved", () => {
      expect(geminiCliSessionSource.scanRoots("/home/u", { geminiDir: "" } as never)).toEqual([
        "/home/u/.gemini/tmp",
      ])
      expect(geminiCliSessionSource.scanRoots("", undefined)).toEqual([])
    })
  })
})
