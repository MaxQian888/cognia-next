import {
  buildReplyTo,
  parseReplyToPayload,
  prefixReplyContext,
  readReplyTo,
  replyContextLine,
} from "./reply-to"

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
