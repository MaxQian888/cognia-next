import { resolveReplySnippet, REPLY_SNIPPET_MAX_CHARS } from "./inbound-reply"
import type { OneBotTransport, OneBotRpcResponse } from "./transport"

function makeTransport(send: jest.Mock): OneBotTransport {
  return {
    start: jest.fn(),
    send: send as unknown as OneBotTransport["send"],
    stop: jest.fn(),
  }
}

function okResponse(data: unknown): OneBotRpcResponse {
  return { status: "ok", retcode: 0, data, echo: "e" }
}

function replyEvent(data: Record<string, unknown>) {
  return {
    post_type: "message",
    message: [
      { type: "reply", data },
      { type: "text", data: { text: "ack" } },
    ],
  }
}

describe("resolveReplySnippet", () => {
  it("fetches get_msg and injects the referenced message's text as data.snippet", async () => {
    const send = jest.fn().mockResolvedValue(
      okResponse({
        message: [{ type: "text", data: { text: "the quoted original" } }],
      })
    )
    const event = replyEvent({ id: "5555" })
    const result = (await resolveReplySnippet(event, makeTransport(send))) as typeof event

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].action).toBe("get_msg")
    expect(send.mock.calls[0][0].params.message_id).toBe(5555)
    expect((result.message[0] as { data: Record<string, unknown> }).data.snippet).toBe(
      "the quoted original"
    )
  })

  it("parses a CQ-string get_msg body through the shared CQ parser", async () => {
    const send = jest.fn().mockResolvedValue(okResponse({ message: "hi [CQ:at,qq=1] a&amp;b" }))
    const event = replyEvent({ id: "1" })
    const result = (await resolveReplySnippet(event, makeTransport(send))) as typeof event
    expect((result.message[0] as { data: Record<string, unknown> }).data.snippet).toBe("hi  a&b")
  })

  it("falls back to raw_message when no message payload is present", async () => {
    const send = jest.fn().mockResolvedValue(okResponse({ raw_message: "raw text" }))
    const event = replyEvent({ id: "2" })
    const result = (await resolveReplySnippet(event, makeTransport(send))) as typeof event
    expect((result.message[0] as { data: Record<string, unknown> }).data.snippet).toBe("raw text")
  })

  it("truncates long snippets to the cap with an ellipsis", async () => {
    const long = "x".repeat(REPLY_SNIPPET_MAX_CHARS + 40)
    const send = jest
      .fn()
      .mockResolvedValue(okResponse({ message: [{ type: "text", data: { text: long } }] }))
    const event = replyEvent({ id: "3" })
    const result = (await resolveReplySnippet(event, makeTransport(send))) as typeof event
    const snippet = (result.message[0] as { data: Record<string, unknown> }).data.snippet as string
    expect(snippet).toHaveLength(REPLY_SNIPPET_MAX_CHARS + 1) // +1 for the ellipsis
    expect(snippet.endsWith("…")).toBe(true)
  })

  it("swallows fetch failures and keeps the empty-snippet fallback", async () => {
    const send = jest.fn().mockRejectedValue(new Error("timeout"))
    const event = replyEvent({ id: "4" })
    const result = (await resolveReplySnippet(event, makeTransport(send))) as typeof event
    expect((result.message[0] as { data: Record<string, unknown> }).data.snippet).toBeUndefined()
  })

  it("leaves the segment untouched on a non-ok response and on empty text", async () => {
    const failed = jest
      .fn()
      .mockResolvedValue({ status: "failed", retcode: 1, data: null, echo: "e" })
    const e1 = replyEvent({ id: "5" })
    await resolveReplySnippet(e1, makeTransport(failed))
    expect((e1.message[0] as { data: Record<string, unknown> }).data.snippet).toBeUndefined()

    const empty = jest.fn().mockResolvedValue(okResponse({ message: [] }))
    const e2 = replyEvent({ id: "6" })
    await resolveReplySnippet(e2, makeTransport(empty))
    expect((e2.message[0] as { data: Record<string, unknown> }).data.snippet).toBeUndefined()
  })

  it("skips already-enriched segments, v12-shaped replies, and reply-less messages (zero RPC)", async () => {
    const send = jest.fn()
    // Already enriched
    await resolveReplySnippet(replyEvent({ id: "7", snippet: "have one" }), makeTransport(send))
    // v12 reply shape uses message_id, not id — get_msg is v11-only.
    await resolveReplySnippet(replyEvent({ message_id: "m-1" }), makeTransport(send))
    // No reply segment at all
    await resolveReplySnippet(
      { message: [{ type: "text", data: { text: "plain" } }] },
      makeTransport(send)
    )
    // CQ-string message and non-object events
    await resolveReplySnippet({ message: "[CQ:reply,id=1] hi" }, makeTransport(send))
    await resolveReplySnippet(null, makeTransport(send))
    expect(send).not.toHaveBeenCalled()
  })
})
