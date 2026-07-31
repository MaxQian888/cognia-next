import {
  PERMALINK_MESSAGE_PARAM,
  PERMALINK_SESSION_PARAM,
  buildMessagePermalink,
  messagePermalinkQuery,
  parseMessagePermalink,
} from "./message-permalink"

const target = { sessionId: "ses_1", messageId: "msg_2" }

describe("messagePermalinkQuery", () => {
  it("carries both ids", () => {
    const params = new URLSearchParams(messagePermalinkQuery(target))
    expect(params.get(PERMALINK_SESSION_PARAM)).toBe("ses_1")
    expect(params.get(PERMALINK_MESSAGE_PARAM)).toBe("msg_2")
  })

  it("escapes ids that would otherwise break the query", () => {
    const query = messagePermalinkQuery({ sessionId: "a&b=c", messageId: "d e" })
    const params = new URLSearchParams(query)
    expect(params.get(PERMALINK_SESSION_PARAM)).toBe("a&b=c")
    expect(params.get(PERMALINK_MESSAGE_PARAM)).toBe("d e")
  })
})

describe("buildMessagePermalink", () => {
  it("is absolute when an origin is available, so it survives being pasted", () => {
    expect(buildMessagePermalink(target, { origin: "https://app.example" })).toBe(
      "https://app.example/?session=ses_1&message=msg_2"
    )
  })

  it("falls back to a relative link with no origin (SSR / prerender)", () => {
    expect(buildMessagePermalink(target, { origin: null })).toBe("/?session=ses_1&message=msg_2")
  })

  it("does not double the slash on an origin that has one", () => {
    expect(buildMessagePermalink(target, { origin: "https://app.example/" })).toBe(
      "https://app.example/?session=ses_1&message=msg_2"
    )
  })

  it("round-trips through the parser", () => {
    const url = new URL(buildMessagePermalink(target, { origin: "https://app.example" }))
    expect(parseMessagePermalink(url.searchParams)).toEqual(target)
  })
})

describe("parseMessagePermalink", () => {
  it("reads a target from the query", () => {
    expect(parseMessagePermalink(new URLSearchParams("?session=s&message=m"))).toEqual({
      sessionId: "s",
      messageId: "m",
    })
  })

  it("ignores an ordinary visit", () => {
    expect(parseMessagePermalink(new URLSearchParams(""))).toBeNull()
    expect(parseMessagePermalink(null)).toBeNull()
  })

  it("requires both ids", () => {
    // A session alone is just "open this conversation"; a message alone cannot
    // be resolved, because messages are stored per session.
    expect(parseMessagePermalink(new URLSearchParams("?session=s"))).toBeNull()
    expect(parseMessagePermalink(new URLSearchParams("?message=m"))).toBeNull()
  })

  it("treats an empty value as absent rather than as a real id", () => {
    expect(parseMessagePermalink(new URLSearchParams("?session=&message=m"))).toBeNull()
    expect(parseMessagePermalink(new URLSearchParams("?session=s&message="))).toBeNull()
  })
})
