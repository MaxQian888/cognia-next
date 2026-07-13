import {
  bareMatrixEventId,
  buildMatrixMessageId,
  parseMatrixConversationKey,
  splitMatrixMessageId,
} from "./ids"

describe("buildMatrixMessageId / splitMatrixMessageId", () => {
  it("round-trips a room id containing colons", () => {
    const composite = buildMatrixMessageId("!abc:server.org", "$evt123")
    expect(composite).toBe("!abc:server.org|$evt123")
    expect(splitMatrixMessageId(composite)).toEqual({
      roomId: "!abc:server.org",
      eventId: "$evt123",
    })
  })

  it("round-trips a room id with an explicit port", () => {
    const composite = buildMatrixMessageId("!r:server.org:8448", "$e")
    expect(splitMatrixMessageId(composite)).toEqual({
      roomId: "!r:server.org:8448",
      eventId: "$e",
    })
  })

  it("keeps legacy event ids (containing colons) intact", () => {
    // v1/v2 event ids look like $local:server — only the FIRST | splits.
    expect(splitMatrixMessageId("!r:s|$legacy:server.org")).toEqual({
      roomId: "!r:s",
      eventId: "$legacy:server.org",
    })
  })

  it("throws a descriptive error on malformed composites", () => {
    expect(() => splitMatrixMessageId("$bareEventId")).toThrow(/"<roomId>\|<eventId>"/)
    expect(() => splitMatrixMessageId("|$noRoom")).toThrow(/"<roomId>\|<eventId>"/)
    expect(() => splitMatrixMessageId("!r:s|")).toThrow(/"<roomId>\|<eventId>"/)
  })
})

describe("bareMatrixEventId", () => {
  it("strips the room prefix from a composite", () => {
    expect(bareMatrixEventId("!r:server.org|$evt")).toBe("$evt")
  })
  it("passes bare event ids through unchanged", () => {
    expect(bareMatrixEventId("$evt")).toBe("$evt")
  })
})

describe("parseMatrixConversationKey", () => {
  it("recovers a room id containing colons", () => {
    expect(parseMatrixConversationKey("matrix:mx-1:!abc:server.org")).toEqual({
      adapterId: "mx-1",
      roomId: "!abc:server.org",
    })
  })

  it("recovers a room id with a port", () => {
    expect(parseMatrixConversationKey("matrix:mx-1:!abc:server.org:8448")).toEqual({
      adapterId: "mx-1",
      roomId: "!abc:server.org:8448",
    })
  })

  it("splits off a trailing thread-root event id", () => {
    expect(parseMatrixConversationKey("matrix:mx-1:!abc:server.org:$threadRoot")).toEqual({
      adapterId: "mx-1",
      roomId: "!abc:server.org",
      threadId: "$threadRoot",
    })
  })

  it("does not mistake a numeric port for a thread id", () => {
    const parsed = parseMatrixConversationKey("matrix:mx-1:!abc:server.org:8448")
    expect(parsed.threadId).toBeUndefined()
  })

  it("throws on non-matrix or malformed keys", () => {
    expect(() => parseMatrixConversationKey("discord:a:b")).toThrow(/invalid matrix/)
    expect(() => parseMatrixConversationKey("matrix:only")).toThrow(/invalid matrix/)
  })
})
