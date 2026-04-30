// Tests for the Claude.ai importer.

import { detectClaude, parseClaude } from "./claude-import"

const SAMPLE = [
  {
    uuid: "c1",
    name: "Project Q&A",
    created_at: "2024-01-01T10:00:00Z",
    updated_at: "2024-01-01T10:30:00Z",
    chat_messages: [
      {
        uuid: "m1",
        sender: "human",
        text: "What's TDD?",
        created_at: "2024-01-01T10:01:00Z",
      },
      {
        uuid: "m2",
        sender: "assistant",
        content: [{ type: "text", text: "Test-driven development." }],
        created_at: "2024-01-01T10:02:00Z",
      },
    ],
  },
]

describe("detectClaude", () => {
  it("matches the official shape (uuid + chat_messages)", () => {
    expect(detectClaude(SAMPLE)).toBe(true)
  })
  it("rejects empty / wrong shapes", () => {
    expect(detectClaude(null)).toBe(false)
    expect(detectClaude([])).toBe(false)
    expect(detectClaude([{ uuid: "x" }])).toBe(false)
    expect(detectClaude([{ uuid: "x", chat_messages: "wrong" }])).toBe(false)
  })
})

describe("parseClaude", () => {
  it("emits user/assistant pairs with the right roles", async () => {
    const out = await parseClaude(SAMPLE, {})
    expect(out).toHaveLength(1)
    expect(out[0].session.title).toBe("Project Q&A")
    expect(out[0].messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(out[0].messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual([
      "What's TDD?",
      "Test-driven development.",
    ])
  })

  it("uses content[].text when there's no top-level text", async () => {
    const data = [
      {
        ...SAMPLE[0],
        chat_messages: [SAMPLE[0].chat_messages[1]],
      },
    ]
    const out = await parseClaude(data as never, {})
    expect((out[0].messages[0].parts[0] as { text: string }).text).toBe("Test-driven development.")
  })

  it("falls back to defaultTitle when name is missing", async () => {
    const data = [{ ...SAMPLE[0], name: undefined }]
    const out = await parseClaude(data as never, { defaultTitle: "Untitled" })
    expect(out[0].session.title).toBe("Untitled")
  })

  it("drops messages with no extractable text", async () => {
    const data = [
      {
        ...SAMPLE[0],
        chat_messages: [{ uuid: "m1", sender: "human", text: "", content: [] }],
      },
    ]
    const out = await parseClaude(data as never, {})
    expect(out).toHaveLength(0)
  })

  it("parses ISO timestamps to epoch ms", async () => {
    const out = await parseClaude(SAMPLE, {})
    const expected = Date.parse("2024-01-01T10:01:00Z")
    expect(out[0].messages[0].createdAt).toBe(expected)
  })
})
