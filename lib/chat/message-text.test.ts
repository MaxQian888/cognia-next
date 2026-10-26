import type { UIMessage } from "ai"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { extractAssistantText, extractPlainText } from "./message-text"

const message = (role: UIMessage["role"], parts: UIMessage["parts"]): UIMessage => ({
  id: "m",
  role,
  parts,
})

describe("extractAssistantText", () => {
  it("joins an assistant reply's text parts and skips the rest", () => {
    expect(
      extractAssistantText(
        message("assistant", [
          { type: "text", text: "First" },
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "Second" },
        ] as UIMessage["parts"])
      )
    ).toBe("First\nSecond")
  })

  it("reads nothing from a missing or non-assistant message", () => {
    expect(extractAssistantText(undefined)).toBe("")
    expect(extractAssistantText(message("user", [{ type: "text", text: "Hi" }]))).toBe("")
  })
})

describe("extractPlainText", () => {
  it("reads what the person typed, without the composer's context envelope", () => {
    const composed = composeTurnText(
      "What does this say?",
      [{ kind: "references", text: "A long referenced document" }],
      { nonce: "a1b2c3d4e5f6" }
    )
    expect(extractPlainText(message("user", [{ type: "text", text: composed.text }]))).toBe(
      "What does this say?"
    )
  })

  it("reads any role's text and nothing from a missing message", () => {
    expect(extractPlainText(message("assistant", [{ type: "text", text: "Reply" }]))).toBe("Reply")
    expect(extractPlainText(undefined)).toBe("")
  })
})
