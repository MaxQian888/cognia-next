import {
  PI_SOURCE_ID,
  parsePiSession,
  parsePiSessionFile,
  piSessionSource,
  summarizePiFile,
} from "./pi"
import type { SessionRef } from "../types"

const REF: SessionRef = {
  sourceId: PI_SOURCE_ID,
  originalSessionId: "sess-uuid",
  locator: "/home/u/.pi/agent/sessions/--work--/2026-08-14T00-00-00-000Z_sess-uuid.jsonl",
}

const line = (o: unknown) => JSON.stringify(o)

/** Import notes live on the first message's metadata (ChatSession has none). */
const notesOf = (messages: Array<{ metadata?: Record<string, unknown> }>) =>
  (messages[0]?.metadata?.piImport as { notes?: Record<string, number> } | undefined)?.notes

/** A realistic v3 file: header, thinking level, model, a turn with a tool. */
function fixture(extra: unknown[] = []): string {
  return [
    line({
      type: "session",
      version: 3,
      id: "sess-uuid",
      timestamp: "2026-08-14T10:00:00.000Z",
      cwd: "/work/repo",
    }),
    line({
      type: "thinking_level_change",
      id: "e1",
      parentId: null,
      timestamp: "2026-08-14T10:00:01.000Z",
      thinkingLevel: "high",
    }),
    line({
      type: "model_change",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-08-14T10:00:02.000Z",
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    }),
    line({
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-08-14T10:00:03.000Z",
      message: { role: "user", content: "list the files" },
    }),
    line({
      type: "message",
      id: "e4",
      parentId: "e3",
      timestamp: "2026-08-14T10:00:04.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should use ls" },
          { type: "text", text: "Listing now." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
        provider: "deepseek",
        model: "deepseek-v4-pro",
        usage: { input: 10, output: 5 },
      },
    }),
    line({
      type: "message",
      id: "e5",
      parentId: "e4",
      timestamp: "2026-08-14T10:00:05.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "a.ts\nb.ts" }],
        isError: false,
      },
    }),
    ...extra.map(line),
  ].join("\n")
}

describe("parsePiSessionFile", () => {
  it("separates the header from the tree entries", () => {
    const { header, entries } = parsePiSessionFile(fixture())
    expect(header).toMatchObject({ version: 3, id: "sess-uuid", cwd: "/work/repo" })
    expect(entries).toHaveLength(5)
  })

  /**
   * Pi being killed mid-write leaves a truncated final line. Losing the whole
   * transcript over one bad line would be the worst possible response.
   */
  it("skips corrupt lines and counts them", () => {
    const { entries, corruptLines } = parsePiSessionFile(
      fixture() + '\n{"type":"message","id":"trunc'
    )
    expect(entries).toHaveLength(5)
    expect(corruptLines).toBe(1)
  })

  it("tolerates blank lines and non-object JSON", () => {
    const { corruptLines } = parsePiSessionFile('\n\n[1,2]\n"str"\n')
    expect(corruptLines).toBe(2)
  })
})

describe("summarizePiFile", () => {
  it("summarizes without building messages", () => {
    const summary = summarizePiFile(fixture(), REF.locator)!
    expect(summary).toMatchObject({
      sourceId: PI_SOURCE_ID,
      title: "list the files",
      messageCount: 3,
      cwd: "/work/repo",
    })
    expect(summary.ref.originalSessionId).toBe("sess-uuid")
  })

  it("returns null for a file with no messages", () => {
    const header = line({ type: "session", version: 3, id: "x", cwd: "/w" })
    expect(summarizePiFile(header, "x.jsonl")).toBeNull()
  })

  it("returns null for a file that is not a Pi session", () => {
    expect(summarizePiFile('{"type":"user","message":{}}', "x.jsonl")).toBeNull()
  })

  /**
   * v1 and v2 files exist in the wild; Pi migrates them on load. Because
   * Cognia reads the file directly it has to accept them, or a user's older
   * history silently fails to appear.
   */
  it("accepts every session version Pi still migrates", () => {
    for (const version of [1, 2, 3]) {
      const content = [
        line({ type: "session", version, id: "s", timestamp: "2026-08-14T10:00:00Z", cwd: "/w" }),
        line({
          type: "message",
          id: "a",
          parentId: null,
          timestamp: "2026-08-14T10:00:01Z",
          message: { role: "user", content: "hi" },
        }),
      ].join("\n")
      expect(summarizePiFile(content, "x.jsonl")).not.toBeNull()
    }
  })

  it("rejects a version it does not understand", () => {
    const content = [
      line({ type: "session", version: 99, id: "s", cwd: "/w" }),
      line({ type: "message", id: "a", parentId: null, message: { role: "user", content: "hi" } }),
    ].join("\n")
    expect(summarizePiFile(content, "x.jsonl")).toBeNull()
  })
})

describe("parsePiSession", () => {
  it("builds the conversation with model, cwd and title", () => {
    const { session, messages } = parsePiSession(REF, fixture())
    expect(session.title).toBe("list the files")
    expect(session.model).toBe("deepseek/deepseek-v4-pro")
    expect(session.workingDir).toBe("/work/repo")
    expect(messages).toHaveLength(2)
  })

  it("maps text, thinking and tool calls onto canonical parts", () => {
    const { messages } = parsePiSession(REF, fixture())
    const assistant = messages[1]
    const kinds = assistant.parts.map((p) => (p as { type: string }).type)
    expect(kinds).toEqual(["reasoning", "text", "tool-bash"])
  })

  /**
   * A tool result is its own entry in Pi. Rendering it as a separate turn
   * would show an assistant message followed by a bare output blob; folding it
   * back onto the call is what makes the transcript read correctly.
   */
  it("folds a tool result back onto the call that issued it", () => {
    const { messages } = parsePiSession(REF, fixture())
    const tool = messages[1].parts.find(
      (p) => (p as { type: string }).type === "tool-bash"
    ) as unknown as { state: string; output: string }
    expect(tool.state).toBe("output-available")
    expect(tool.output).toBe("a.ts\nb.ts")
  })

  it("marks a failed tool result as an error", () => {
    const content = fixture().replace('"isError":false', '"isError":true')
    const { messages } = parsePiSession(REF, content)
    const tool = messages[1].parts.find(
      (p) => (p as { type: string }).type === "tool-bash"
    ) as unknown as { state: string }
    expect(tool.state).toBe("output-error")
  })

  it("keeps an orphan tool result rather than dropping its output", () => {
    const content = [
      line({ type: "session", version: 3, id: "s", timestamp: "2026-08-14T10:00:00Z", cwd: "/w" }),
      line({
        type: "message",
        id: "a",
        parentId: null,
        timestamp: "2026-08-14T10:00:01Z",
        message: {
          role: "toolResult",
          toolCallId: "nope",
          toolName: "bash",
          content: [{ type: "text", text: "stranded output" }],
        },
      }),
    ].join("\n")
    const { messages } = parsePiSession(REF, content)
    expect(messages[0].parts[0]).toMatchObject({ text: "stranded output" })
    expect(notesOf(messages)).toMatchObject({ orphan_tool_result: 1 })
  })

  /**
   * `custom` entries are extension state that Pi's own context builder
   * excludes, so they never reached the model. Reporting them keeps the loss
   * report honest without inventing turns.
   */
  it("reports custom extension entries instead of rendering them", () => {
    const { messages } = parsePiSession(
      REF,
      fixture([
        {
          type: "custom",
          id: "e6",
          parentId: "e5",
          timestamp: "2026-08-14T10:00:06.000Z",
          customType: "plan-mode-state",
          data: { enabled: false },
        },
      ])
    )
    expect(messages).toHaveLength(2)
    expect(notesOf(messages)).toMatchObject({ "custom:plan-mode-state": 1 })
  })

  it("renders a custom_message, which does reach the model", () => {
    const { messages } = parsePiSession(
      REF,
      fixture([
        {
          type: "custom_message",
          id: "e6",
          parentId: "e5",
          timestamp: "2026-08-14T10:00:06.000Z",
          customType: "memory",
          content: "injected context",
        },
      ])
    )
    expect(messages).toHaveLength(3)
    expect(messages[2].parts[0]).toMatchObject({ text: "injected context" })
  })

  it("renders a compaction summary so the gap is visible", () => {
    const { messages } = parsePiSession(
      REF,
      fixture([
        {
          type: "compaction",
          id: "e6",
          parentId: "e5",
          timestamp: "2026-08-14T10:00:06.000Z",
          summary: "Earlier: the user asked about files.",
          tokensBefore: 50000,
        },
      ])
    )
    expect(messages[2].parts[0]).toMatchObject({ text: "Earlier: the user asked about files." })
  })

  it("imports an abandoned branch as a nested conversation", () => {
    const result = parsePiSession(
      REF,
      fixture([
        // A branch off e3 that the user later abandoned.
        {
          type: "message",
          id: "b1",
          parentId: "e3",
          timestamp: "2026-08-14T10:00:04.500Z",
          message: { role: "assistant", content: [{ type: "text", text: "alternate answer" }] },
        },
      ])
    )
    expect(result.nested).toHaveLength(1)
    expect(result.nested![0].messages[1].parts[0]).toMatchObject({ text: "alternate answer" })
    // Nested branches use the subagent kind so they render as hidden inner
    // transcripts rather than as top-level sessions.
    expect(result.nested![0].session.kind).toBe("subagent")
  })

  it("records the fork origin when the header carries one", () => {
    const content = fixture().replace(
      '"cwd":"/work/repo"',
      '"cwd":"/work/repo","parentSession":"/home/u/.pi/agent/sessions/--work--/orig.jsonl"'
    )
    const { messages } = parsePiSession(REF, content)
    const info = messages[0].metadata?.piImport as { forkedFrom?: string } | undefined
    expect(info?.forkedFrom).toContain("orig.jsonl")
  })

  it("counts corrupt lines in the loss notes", () => {
    const { messages } = parsePiSession(REF, fixture() + '\n{"type":"message","id":"tr')
    expect(notesOf(messages)).toMatchObject({ corrupt_lines: 1 })
  })
})

describe("piSessionSource", () => {
  it("scans Pi's documented session root", () => {
    expect(piSessionSource.scanRoots("/home/u")).toEqual(["/home/u/.pi/agent/sessions"])
  })

  it("detects by path hint", () => {
    expect(
      piSessionSource.detect([
        { name: "x.jsonl", path: "/home/u/.pi/agent/sessions/x.jsonl", content: "" },
      ])
    ).toBe("match")
  })

  it("detects by content when the path gives nothing away", () => {
    expect(
      piSessionSource.detect([
        { name: "x.jsonl", path: "/tmp/downloaded.jsonl", content: fixture() },
      ])
    ).toBe("match")
  })

  it("does not claim another agent's transcript", () => {
    expect(
      piSessionSource.detect([
        {
          name: "x.jsonl",
          path: "/home/u/.claude/projects/p/x.jsonl",
          content: '{"type":"user","parentUuid":null,"message":{}}',
        },
      ])
    ).toBe("no")
  })

  it("declares a structured import codec", () => {
    expect(piSessionSource.codec?.importFidelity).toBe("structured")
    // No create-from-messages API exists, so the reverse direction is a
    // replay prompt, not a forged session file.
    expect(piSessionSource.codec?.materialize?.fidelity).toBe("contextual")
  })
})
