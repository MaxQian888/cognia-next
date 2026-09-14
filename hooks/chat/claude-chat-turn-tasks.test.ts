const getSessionMock = jest.fn()
const updateSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSessionMock(...args),
  updateSession: (...args: unknown[]) => updateSessionMock(...args),
}))

import {
  applyInstantTitle,
  extractAssistantText,
  extractPlainText,
  renderGoalExitCard,
} from "./claude-chat-turn-tasks"
import { composeTurnText } from "@/lib/chat/prompt-preamble"

describe("Claude chat turn tasks", () => {
  const message = { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] } as never

  it("extracts rendered message text", () => {
    expect(extractAssistantText(message)).toBe("done")
    expect(extractPlainText(message)).toBe("done")
  })

  it("renders terminal goal cards", () => {
    expect(renderGoalExitCard("completed", "shipped")).toContain("Goal completed")
  })
})

describe("the composer's context envelope", () => {
  const turn = composeTurnText(
    "summarize the incident",
    [{ kind: "references", text: "Referenced context:\n\nIssue COG-9 body" }],
    { nonce: "a1b2c3d4e5" }
  )

  beforeEach(() => {
    getSessionMock.mockReset().mockResolvedValue({ id: "s1", title: "New chat" })
    updateSessionMock.mockReset().mockResolvedValue(undefined)
  })

  // Title, timeline label and memory extraction all ask what the user SAID.
  it("is not part of a user message's plain text", () => {
    const user = { id: "u1", role: "user", parts: [{ type: "text", text: turn.text }] } as never
    expect(extractPlainText(user)).toBe("summarize the incident")
  })

  it("does not become the instant title", async () => {
    await applyInstantTitle("s1", turn.text)
    expect(updateSessionMock).toHaveBeenCalledWith("s1", {
      title: expect.stringContaining("summarize the incident"),
      titleAuto: true,
    })
    const [, patch] = updateSessionMock.mock.calls[0]
    expect(patch.title).not.toContain("cognia_context")
  })
})
