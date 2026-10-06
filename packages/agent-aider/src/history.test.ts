import {
  AIDER_HISTORY_FORMAT,
  AIDER_HISTORY_LOSSES,
  detectAiderHistory,
  parseAiderHistory,
  summarizeAiderHistory,
} from "./history"

const MD = `# aider chat started at 2025-01-01 12:00:00

> Aider v0.1 note
#### fix the bug
#### please

I'll fix it now.

Here is the change.

> Tokens: 100 sent
`

describe("parseAiderHistory", () => {
  it("splits #### user turns from assistant prose, skipping > notes", () => {
    const parsed = parseAiderHistory(MD, "/repo/.aider.chat.history.md")
    expect(parsed).toMatchObject({
      sourceId: "aider",
      originalSessionId: "/repo/.aider.chat.history.md",
      title: "fix the bug please",
      createdAt: Date.parse("2025-01-01 12:00:00"),
    })
    expect(parsed.messages).toEqual([
      {
        role: "user",
        parts: [{ type: "text", text: "fix the bug\nplease" }],
        createdAt: Date.parse("2025-01-01 12:00:00"),
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "I'll fix it now.\n\nHere is the change." }],
        createdAt: Date.parse("2025-01-01 12:00:00"),
      },
    ])
  })

  it("reports the Markdown loss on every session, never an empty loss list", () => {
    const parsed = parseAiderHistory(MD, "x.md")
    expect(parsed.losses).toEqual(AIDER_HISTORY_LOSSES)
    parsed.losses[0].detail = "mutated"
    expect(AIDER_HISTORY_LOSSES[0].detail).not.toBe("mutated")
  })

  it("handles an empty file with a fallback title and the current time", () => {
    const before = Date.now()
    const parsed = parseAiderHistory("", "x.md")
    expect(parsed.messages).toEqual([])
    expect(parsed.title).toBe("Aider session")
    expect(parsed.createdAt).toBeGreaterThanOrEqual(before)
  })

  it("spans restarts: created at the first start, updated at the last", () => {
    const parsed = parseAiderHistory(
      [
        "# aider chat started at 2026-01-01 00:00:00",
        "#### one",
        "a",
        "# aider chat started at 2026-01-02 00:00:00",
        "#### two",
        "b",
      ].join("\n"),
      "h.md"
    )
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(parsed.createdAt).toBe(Date.parse("2026-01-01 00:00:00"))
    expect(parsed.updatedAt).toBe(Date.parse("2026-01-02 00:00:00"))
  })
})

describe("summarizeAiderHistory", () => {
  it("agrees with the full parser across notes, empty turns and restart boundaries", () => {
    const content = [
      "# aider chat started at 2026-01-01 00:00:00",
      "#### first",
      "#### line two",
      "> ignored",
      "answer",
      "#### ",
      "",
      "# aider chat started at 2026-01-02 00:00:00",
      "#### last",
      "done",
    ].join("\n")
    const parsed = parseAiderHistory(content, "/history.md")
    expect(summarizeAiderHistory(content, "/history.md")).toEqual({
      sourceId: "aider",
      originalSessionId: "/history.md",
      title: parsed.title,
      messageCount: parsed.messages.length,
      updatedAt: parsed.updatedAt,
    })
  })
})

describe("detectAiderHistory", () => {
  it("matches by file name, falls back to content, refuses nothing", () => {
    expect(
      detectAiderHistory([
        { name: ".aider.chat.history.md", path: "/repo/.aider.chat.history.md", content: "" },
      ])
    ).toBe("match")
    expect(
      detectAiderHistory([
        { name: ".aider.chat.history.md", path: "/a", content: "" },
        { name: "other.md", path: "/b", content: "" },
      ])
    ).toBe("maybe")
    expect(detectAiderHistory([{ name: "x.md", path: "/x.md", content: MD }])).toBe("maybe")
    expect(detectAiderHistory([{ name: "x.md", path: "/x.md", content: "plain" }])).toBe("no")
    expect(detectAiderHistory([])).toBe("no")
  })

  it("names the verified format", () => {
    expect(AIDER_HISTORY_FORMAT).toEqual({
      sourceId: "aider",
      verifiedVersion: "0.86.2",
      verifiedAt: "2026-08-29",
      acceptedExtensions: [".md"],
    })
  })
})
