/**
 * @jest-environment node
 */
import { externalPromptText, unsupportedAttachmentMessage } from "./external-prompt"

describe("externalPromptText", () => {
  it("passes a plain string through untouched", () => {
    expect(externalPromptText("hello")).toEqual({ text: "hello", unsupported: [] })
  })

  it("joins text blocks in order", () => {
    expect(
      externalPromptText([
        { type: "text", text: "context" },
        { type: "text", text: "question" },
      ] as never)
    ).toEqual({ text: "context\n\nquestion", unsupported: [] })
  })

  it("keeps the text it CAN send while naming what it cannot", () => {
    const out = externalPromptText([
      { type: "text", text: "look" },
      { type: "image", source: {} },
    ] as never)
    expect(out.text).toBe("look")
    expect(out.unsupported).toEqual(["image"])
  })

  it("reports each unsupported kind once, however many blocks there are", () => {
    const out = externalPromptText([
      { type: "image", source: {} },
      { type: "image", source: {} },
      { type: "document", source: {} },
    ] as never)
    expect(out.unsupported).toEqual(["image", "document"])
  })

  it("yields an empty prompt for an empty block list", () => {
    expect(externalPromptText([] as never)).toEqual({ text: "", unsupported: [] })
  })
})

describe("unsupportedAttachmentMessage", () => {
  it("names the backend, the attachment kinds, and a way forward", () => {
    const message = unsupportedAttachmentMessage("codex", ["image", "document"])
    expect(message).toContain("codex")
    expect(message).toContain("image, document")
    expect(message).toContain("built-in agent")
  })
})
