const submitMock = jest.fn()
jest.mock("@/lib/memory/agent-findings", () => ({
  submitAgentMemoryFinding: (finding: unknown) => submitMock(finding),
}))

import {
  memoryDraftTitle,
  saveMessageAsMemory,
  saveMessagesAsMemory,
} from "./save-message-as-memory"

const text = (value: string) => [{ type: "text", text: value }]

beforeEach(() => {
  submitMock.mockReset().mockResolvedValue({ status: "accepted" })
})

describe("memoryDraftTitle", () => {
  it("uses a short body whole", () => {
    expect(memoryDraftTitle("Prefers pnpm")).toBe("Prefers pnpm")
  })

  it("collapses whitespace", () => {
    expect(memoryDraftTitle("  Prefers\n\n  pnpm  ")).toBe("Prefers pnpm")
  })

  // A mid-word cut reads as corruption, which is why the aside titler does the
  // same thing.
  it("elides a long body on a word boundary", () => {
    const title = memoryDraftTitle(`${"word ".repeat(40)}end`)
    expect(title.endsWith("…")).toBe(true)
    expect(title).not.toMatch(/wor…$/)
  })
})

describe("saveMessageAsMemory", () => {
  it("files the turn's prose as a pending draft", async () => {
    const title = await saveMessageAsMemory({
      parts: text("Restacking needs --contained"),
      sessionId: "s1",
      projectId: "p1",
    })
    expect(title).toBe("Restacking needs --contained")
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Restacking needs --contained",
        body: "Restacking needs --contained",
        kind: "fact",
        authorKind: "subagent",
        sessionId: "s1",
        projectId: "p1",
      })
    )
  })

  // A captured reply is a statement; `skill` would file it as steps to follow.
  it("files it as a fact, not a procedure", async () => {
    await saveMessageAsMemory({ parts: text("x"), sessionId: "s1" })
    expect(submitMock.mock.calls[0]![0].kind).toBe("fact")
  })

  // A memory draft should be the turn's PROSE. Folding in tool outputs would
  // file a file listing as something to remember about the user.
  it("keeps the tool call's shape out of the body", async () => {
    await saveMessageAsMemory({
      parts: [
        { type: "text", text: "here is the file" },
        {
          type: "tool-Read",
          state: "output-available",
          input: { file_path: "/tmp/a" },
          output: "SECRET FILE BODY",
        },
      ],
      sessionId: "s1",
    })
    expect(submitMock.mock.calls[0]![0].body).not.toContain("SECRET FILE BODY")
    expect(submitMock.mock.calls[0]![0].body).toContain("here is the file")
  })

  it("omits an absent workspace rather than storing undefined", async () => {
    await saveMessageAsMemory({ parts: text("x"), sessionId: "s1" })
    expect("projectId" in submitMock.mock.calls[0]![0]).toBe(false)
  })

  it("returns null and files nothing for a turn with no readable body", async () => {
    expect(await saveMessageAsMemory({ parts: [], sessionId: "s1" })).toBeNull()
    expect(submitMock).not.toHaveBeenCalled()
  })

  // A PII-gate refusal is a real answer the caller must show, not something to
  // swallow into a success.
  it("propagates a refusal from the distiller", async () => {
    submitMock.mockRejectedValue(new Error("contains an email address"))
    await expect(saveMessageAsMemory({ parts: text("x"), sessionId: "s1" })).rejects.toThrow(
      "contains an email address"
    )
  })
})

describe("saveMessagesAsMemory", () => {
  it("files the ticked messages as ONE draft, each passage under who said it", async () => {
    const title = await saveMessagesAsMemory({
      messages: [
        { role: "user", parts: text("Why does restacking drop commits?") },
        { role: "assistant", parts: text("It needs --contained.") },
      ],
      sessionId: "s1",
      projectId: "p1",
    })
    expect(title).toBe("Why does restacking drop commits?")
    expect(submitMock).toHaveBeenCalledTimes(1)
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "user: Why does restacking drop commits?\n\nassistant: It needs --contained.",
        kind: "fact",
        authorKind: "subagent",
        sessionId: "s1",
        projectId: "p1",
      })
    )
  })

  it("skips a message with nothing to keep, and files nothing when none has", async () => {
    await saveMessagesAsMemory({
      messages: [
        { role: "assistant", parts: [] },
        { role: "user", parts: text("only this") },
      ],
      sessionId: "s1",
    })
    expect(submitMock.mock.calls[0]![0].body).toBe("user: only this")

    submitMock.mockClear()
    expect(
      await saveMessagesAsMemory({ messages: [{ role: "user", parts: [] }], sessionId: "s1" })
    ).toBeNull()
    expect(submitMock).not.toHaveBeenCalled()
  })

  // In an IM group a `user` row is another person.
  it("names someone else by their prompt-safe name and files the draft as untrusted", async () => {
    await saveMessagesAsMemory({
      messages: [
        {
          role: "user",
          parts: text("The deploy key rotates on Fridays."),
          metadata: {
            platformMessage: { sender: { id: "u_42", kind: "user", displayName: "Ana" } },
          },
        },
        { role: "assistant", parts: text("Noted.") },
      ],
      sessionId: "s1",
    })
    const finding = submitMock.mock.calls[0]![0]
    expect(finding.body).toMatch(/^Ana · \S+: The deploy key rotates on Fridays\./)
    expect(finding.body).toContain("assistant: Noted.")
    expect(finding.authorKind).toBe("external_agent")
  })

  it("keeps a named teammate's turn trusted", async () => {
    await saveMessagesAsMemory({
      messages: [{ role: "assistant", parts: text("Reviewed."), metadata: { senderId: "c-rev" } }],
      sessionId: "s1",
    })
    expect(submitMock.mock.calls[0]![0].authorKind).toBe("subagent")
  })

  it("propagates a refusal from the distiller", async () => {
    submitMock.mockRejectedValue(new Error("contains a phone number"))
    await expect(
      saveMessagesAsMemory({ messages: [{ role: "user", parts: text("x") }], sessionId: "s1" })
    ).rejects.toThrow("contains a phone number")
  })
})
