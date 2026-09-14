import type { UIMessage } from "ai"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { REFERENCE_PREAMBLE_OMITTED_NOTE } from "@/lib/chat/mentions/message-reference"
import {
  selectedInTranscriptOrder,
  selectionCopyText,
  selectionMaterial,
} from "./transcript-selection"

function msg(id: string, role: UIMessage["role"], ...parts: unknown[]): UIMessage {
  return { id, role, parts } as UIMessage
}

const text = (value: string) => ({ type: "text", text: value })
const LABELS = { user: "You", assistant: "Assistant", system: "System" }

describe("selectedInTranscriptOrder", () => {
  it("follows the transcript, not the order things were ticked", () => {
    const messages = [msg("a", "user"), msg("b", "assistant"), msg("c", "user")]
    expect(selectedInTranscriptOrder(messages, new Set(["c", "a"])).map((m) => m.id)).toEqual([
      "a",
      "c",
    ])
  })
})

describe("selectionMaterial", () => {
  it("gives one role-labelled segment per message and the unlabelled bodies as the source", () => {
    const material = selectionMaterial([
      msg("a", "user", text("Why is CI red?")),
      msg("b", "assistant", text("The lint step\n\nfails on one file.")),
    ])
    expect(material.segments).toEqual([
      "user: Why is CI red?",
      "assistant: The lint step\n\nfails on one file.",
    ])
    expect(material.quote).toBe("Why is CI red?\nThe lint step\n\nfails on one file.")
    expect(material.messageIds).toEqual(["a", "b"])
  })

  it("reads a message the way a message reference does", () => {
    const composed = composeTurnText("compare them", [
      { kind: "references", text: "Referenced context:\nbody" },
    ])
    const material = selectionMaterial([
      msg("a", "user", text(composed.text)),
      msg("b", "assistant", {
        type: "tool-bash",
        toolCallId: "t",
        state: "output-available",
        input: { command: "ls" },
        output: "README.md",
      }),
    ])
    expect(material.segments[0]).toBe(`user: compare them\n${REFERENCE_PREAMBLE_OMITTED_NOTE}`)
    expect(material.segments[1]).toContain("README.md")
  })

  it("leaves out a message with nothing to read", () => {
    const material = selectionMaterial([msg("a", "assistant"), msg("b", "user", text("hi"))])
    expect(material.messageIds).toEqual(["b"])
    expect(material.segments).toEqual(["user: hi"])
  })
})

describe("selectionCopyText", () => {
  it("labels each message by who said it", () => {
    expect(
      selectionCopyText(
        [msg("a", "user", text("Why is CI red?")), msg("b", "assistant", text("Lint fails."))],
        LABELS
      )
    ).toBe("You:\nWhy is CI red?\n\nAssistant:\nLint fails.")
  })

  it("copies what the user typed, not the context envelope", () => {
    const composed = composeTurnText("compare them", [
      { kind: "references", text: "Referenced context:\nsecret body" },
    ])
    const copied = selectionCopyText([msg("a", "user", text(composed.text))], LABELS)
    expect(copied).toBe("You:\ncompare them")
  })

  it("names an inline image instead of pasting its data", () => {
    const copied = selectionCopyText(
      [
        msg("a", "user", text("look"), {
          type: "file",
          mediaType: "image/png",
          filename: "shot.png",
          url: "data:image/png;base64,AAAA",
        }),
      ],
      LABELS
    )
    expect(copied).toContain("shot.png")
    expect(copied).not.toContain("base64")
  })

  it("skips a message with nothing to copy", () => {
    expect(
      selectionCopyText([msg("a", "assistant"), msg("b", "system", text("note"))], LABELS)
    ).toBe("System:\nnote")
  })
})
