import {
  buildReplyTo,
  parseReplyToPayload,
  prefixReplyContext,
  readReplyTo,
  replyContextLine,
  withReplyContextLines,
} from "./reply-to"
import { composeTurnText } from "@/lib/chat/prompt-preamble"

describe("buildReplyTo / readReplyTo", () => {
  it("builds a capped preview reference and reads it back", () => {
    const ref = buildReplyTo({
      id: "m1",
      parts: [
        { type: "text", text: "  hello\nthere " },
        { type: "tool-Read", state: "x" },
      ],
    })
    expect(ref).toEqual({ messageId: "m1", preview: "hello there" })
    expect(readReplyTo({ metadata: { replyTo: ref } })).toEqual(ref)
  })

  it("keeps the platform id when present and rejects malformed values", () => {
    expect(
      readReplyTo({
        metadata: { replyTo: { messageId: "p", preview: "", platformMessageId: "42" } },
      })
    ).toEqual({ messageId: "p", preview: "", platformMessageId: "42" })
    expect(readReplyTo({ metadata: { replyTo: { messageId: "", preview: "x" } } })).toBeNull()
    expect(readReplyTo({ metadata: { replyTo: { messageId: "a" } } })).toBeNull()
    expect(readReplyTo({ metadata: { replyTo: "a" } })).toBeNull()
    expect(readReplyTo({ metadata: undefined })).toBeNull()
    expect(readReplyTo({})).toBeNull()
  })

  it("parses an RPC payload with the same strictness and drops unknown keys", () => {
    expect(parseReplyToPayload({ messageId: "a", preview: "b", extra: 1 })).toEqual({
      messageId: "a",
      preview: "b",
    })
    expect(parseReplyToPayload(null)).toBeNull()
    expect(parseReplyToPayload({ messageId: 1, preview: "b" })).toBeNull()
  })
})

describe("replyContextLine / prefixReplyContext", () => {
  it("quotes the preview, or names an earlier message when the preview is empty", () => {
    expect(replyContextLine({ messageId: "a", preview: "the plan" })).toBe(
      '[Replying to: "the plan"]'
    )
    expect(replyContextLine({ messageId: "a", preview: "  " })).toBe(
      "[Replying to an earlier message]"
    )
  })

  it("prefixes a string and prepends a text block to block content", () => {
    const ref = { messageId: "a", preview: "p" }
    expect(prefixReplyContext("hi", ref)).toBe('[Replying to: "p"]\n\nhi')
    expect(prefixReplyContext([{ type: "text", text: "hi" }], ref)).toEqual([
      { type: "text", text: '[Replying to: "p"]' },
      { type: "text", text: "hi" },
    ])
  })
})

describe("withReplyContextLines", () => {
  const reply = { messageId: "m0", preview: "the plan" }

  // The standalone engine converts the message list, not the prefixed content,
  // so the reply line has to be rebuilt from metadata on every row it sends.
  it("puts the reply line back in front of every replying user turn", () => {
    const out = withReplyContextLines([
      { role: "user", parts: [{ type: "text", text: "first" }] },
      { role: "user", parts: [{ type: "text", text: "yes" }], metadata: { replyTo: reply } },
      { role: "assistant", parts: [{ type: "text", text: "ok" }], metadata: { replyTo: reply } },
    ])
    expect(out[1].parts).toEqual([
      { type: "text", text: '[Replying to: "the plan"]' },
      { type: "text", text: "yes" },
    ])
    // Only user turns reply; an assistant row is left as it is.
    expect(out[2].parts).toEqual([{ type: "text", text: "ok" }])
  })

  it("returns the same array, unmutated, when nothing replies", () => {
    const messages = [{ role: "user", parts: [{ type: "text", text: "hi" }] }]
    expect(withReplyContextLines(messages)).toBe(messages)
  })

  it("never mutates the stored row", () => {
    const row = {
      role: "user",
      parts: [{ type: "text", text: "yes" }],
      metadata: { replyTo: reply },
    }
    withReplyContextLines([row])
    expect(row.parts).toHaveLength(1)
  })
})

describe("buildReplyTo previews the typed text", () => {
  it("skips the composer's context envelope", () => {
    const { text } = composeTurnText("ship it?", [{ kind: "references", text: "ctx" }], {
      nonce: "9f8e7d6c5b",
    })
    expect(buildReplyTo({ id: "u1", parts: [{ type: "text", text }] }).preview).toBe("ship it?")
  })
})
