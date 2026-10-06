import { deriveAcpPermissionInput } from "./permission-input"
import type { AcpToolCallContent } from "@cognia/agent-contracts/external-agent"

const text = (value: string): AcpToolCallContent => ({
  type: "content",
  content: { type: "text", text: value },
})

/**
 * Captured from Kimi Code CLI 2.1.1 (`kimi acp`) asked to run `echo hi`
 * (session/tool ids trimmed). The `tool_call` announces Bash with empty text;
 * `tool_call_update`s stream the arguments as JSON text; the permission request
 * carries only the id, title and a prose line — no `rawInput`, no `kind`.
 */
const KIMI = {
  toolCall: {
    sessionUpdate: "tool_call",
    toolCallId: "0:tool_R29ulqpHV14RrFHO2zgathhW",
    title: "Bash",
    kind: "execute",
    status: "pending",
    content: [text("")],
  },
  streamed: ['{"command":"', '{"command":"echo', '{"command":"echo hi"', '{"command":"echo hi"}'],
  permission: {
    sessionId: "session_62166c5a",
    options: [
      { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
      { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "0:tool_R29ulqpHV14RrFHO2zgathhW",
      title: "Bash",
      content: [text("Requesting approval to Running: echo hi")],
    },
  },
} as const

describe("deriveAcpPermissionInput", () => {
  it("recovers Kimi Code's streamed Bash arguments and keeps its prose as the summary", () => {
    // The live cache holds the LAST streamed update (each re-sends the prefix).
    const cached = { content: [text(KIMI.streamed.at(-1)!)] }
    expect(
      deriveAcpPermissionInput({ content: [...KIMI.permission.toolCall.content] }, cached)
    ).toEqual({
      input: { command: "echo hi" },
      source: "content-json",
      summary: "Requesting approval to Running: echo hi",
    })
  })

  it.each(KIMI.streamed.slice(0, -1))(
    "does not mistake a partial stream %s for arguments",
    (partial) => {
      expect(deriveAcpPermissionInput({}, { content: [text(partial)] })).toEqual({})
    }
  )

  it("prefers a non-empty rawInput — the request's own, then the cached one", () => {
    expect(
      deriveAcpPermissionInput(
        { rawInput: { command: "ls" }, content: [text('{"command":"other"}')] },
        { rawInput: { command: "cached" } }
      )
    ).toEqual({ input: { command: "ls" }, source: "rawInput" })
    expect(deriveAcpPermissionInput({ rawInput: {} }, { rawInput: { command: "cached" } })).toEqual(
      { input: { command: "cached" }, source: "rawInput" }
    )
  })

  it("prefers JSON in the request's own content over the cached stream", () => {
    expect(
      deriveAcpPermissionInput(
        { content: [text('{"command":"newer"}')] },
        { content: [text('{"command":"older"}')] }
      ).input
    ).toEqual({ command: "newer" })
  })

  it("ignores JSON that is not an object with keys", () => {
    for (const value of ["{}", "[1,2]", '"str"', "{not json}"]) {
      expect(deriveAcpPermissionInput({}, { content: [text(value)] }).input).toBeUndefined()
    }
  })

  it("maps a single diff to the Edit shape (new file → empty old text)", () => {
    expect(
      deriveAcpPermissionInput({
        content: [{ type: "diff", path: "/w/a.ts", oldText: null, newText: "x" }],
      })
    ).toEqual({
      input: { file_path: "/w/a.ts", old_string: "", new_string: "x" },
      source: "diff",
    })
  })

  it("maps several diffs to the MultiEdit shape, naming the file once when shared", () => {
    const sameFile = deriveAcpPermissionInput({
      content: [
        { type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" },
        { type: "diff", path: "/w/a.ts", oldText: "c", newText: "d" },
      ],
    })
    expect(sameFile.input).toEqual({
      file_path: "/w/a.ts",
      edits: [
        { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
        { file_path: "/w/a.ts", old_string: "c", new_string: "d" },
      ],
    })
    const twoFiles = deriveAcpPermissionInput(
      {},
      {
        content: [
          { type: "diff", path: "/w/a.ts", oldText: "a", newText: "b" },
          { type: "diff", path: "/w/b.ts", oldText: "c", newText: "d" },
        ],
      }
    )
    expect(twoFiles.input).not.toHaveProperty("file_path")
    expect(twoFiles.source).toBe("diff")
  })

  it("falls back to locations", () => {
    expect(deriveAcpPermissionInput({ locations: [{ path: "/w/a.ts", line: 3 }] })).toEqual({
      input: { path: "/w/a.ts", line: 3 },
      source: "locations",
    })
    expect(
      deriveAcpPermissionInput({}, { locations: [{ path: "/w/a.ts" }, { path: "/w/b.ts" }] }).input
    ).toEqual({ paths: ["/w/a.ts", "/w/b.ts"] })
  })

  it("returns only the summary when there are no arguments anywhere", () => {
    expect(deriveAcpPermissionInput({ content: [text("  Delete the cache?  ")] })).toEqual({
      summary: "Delete the cache?",
    })
    expect(deriveAcpPermissionInput({}, undefined)).toEqual({})
  })

  it("never treats cached text as the summary — it may be stale output", () => {
    expect(deriveAcpPermissionInput({}, { content: [text("old output")] }).summary).toBeUndefined()
  })
})
