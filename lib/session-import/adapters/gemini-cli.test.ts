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

  it("marks a failed tool call as an error and skips $-update records", () => {
    const lines = [
      {
        id: "m1",
        type: "gemini",
        content: [{ text: "x" }],
        toolCalls: [{ id: "c1", name: "shell", args: {}, result: "denied", status: "error" }],
      },
      { $rewindTo: "m0" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    const parsed = parseGeminiChat(lines, "c.jsonl")
    const tool = (parsed.messages[0].parts as Array<Record<string, unknown>>).find((p) =>
      String(p.type).startsWith("tool-")
    )!
    expect(tool.state).toBe("output-error")
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
})
