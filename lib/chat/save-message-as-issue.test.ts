const mockCreate = jest.fn(async (req: unknown) => ({
  id: "i1",
  identifier: "MERC-3",
  ...(req as object),
}))
jest.mock("@/lib/issues/service", () => ({
  createIssueRecord: (req: unknown) => mockCreate(req),
}))
jest.mock("@/lib/chat/search/project-text", () => ({
  projectSearchText: (parts: unknown) =>
    Array.isArray(parts) ? parts.map((p) => (p as { text?: string }).text ?? "").join("\n") : "",
}))

import { issueTitleFromBody, saveMessageAsIssue } from "./save-message-as-issue"

beforeEach(() => mockCreate.mockClear())

describe("issueTitleFromBody", () => {
  it("takes the first readable line, stripped of markdown lead-ins", () => {
    expect(issueTitleFromBody("\n## Login returns 500\n\nDetails")).toBe("Login returns 500")
    expect(issueTitleFromBody("- fix   the   thing")).toBe("fix the thing")
  })

  it("elides a long first line at a word boundary", () => {
    const title = issueTitleFromBody(`${"word ".repeat(40)}tail`)
    expect(title.length).toBeLessThanOrEqual(121)
    expect(title.endsWith("…")).toBe(true)
    expect(title).toMatch(/word…$/)
  })
})

describe("saveMessageAsIssue", () => {
  it("files the reply with the session and message as its origin", async () => {
    const issue = await saveMessageAsIssue({
      parts: [{ text: "Login returns 500" }, { text: "when the token expired" }],
      sessionId: "ses_a",
      messageId: "msg_1",
      projectId: "w1",
    })
    expect(issue).toMatchObject({ identifier: "MERC-3" })
    expect(mockCreate).toHaveBeenCalledWith({
      title: "Login returns 500",
      description: "Login returns 500\nwhen the token expired",
      by: { kind: "human" },
      projectId: "w1",
      origin: { kind: "chat", sessionId: "ses_a", messageId: "msg_1" },
    })
  })

  it("returns null for an unreadable reply and lets a tracker refusal through", async () => {
    expect(await saveMessageAsIssue({ parts: [], sessionId: "s", messageId: "m" })).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
    mockCreate.mockRejectedValueOnce(new Error("Create a project first"))
    await expect(
      saveMessageAsIssue({ parts: [{ text: "x" }], sessionId: "s", messageId: "m" })
    ).rejects.toThrow(/project first/)
  })
})
