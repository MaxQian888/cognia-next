import {
  MAX_COMMENT_MENTIONS,
  containsMentionToken,
  declaredMentionIds,
  insertMention,
  mentionToken,
  typedMentionTrigger,
} from "./comment-mentions"

const ADA = { userId: "usr_ada", displayName: "Ada Lovelace" }
const BOB = { userId: "usr_bob", displayName: "Bob" }

describe("containsMentionToken", () => {
  it("finds a token with spaces in the name", () => {
    expect(containsMentionToken("hi @Ada Lovelace, look", "Ada Lovelace")).toBe(true)
  })

  it("finds a token at either end", () => {
    expect(containsMentionToken("@Bob", "Bob")).toBe(true)
    expect(containsMentionToken("ping @Bob", "Bob")).toBe(true)
  })

  it("is not fooled by a longer name or an address", () => {
    expect(containsMentionToken("@Bobby please", "Bob")).toBe(false)
    expect(containsMentionToken("mail ops@Bob", "Bob")).toBe(false)
  })

  it("keeps looking past a false match", () => {
    expect(containsMentionToken("@Bobby and @Bob", "Bob")).toBe(true)
  })

  it("is gone once the name is edited away", () => {
    expect(containsMentionToken("hi @Ada Love", "Ada Lovelace")).toBe(false)
  })
})

describe("declaredMentionIds", () => {
  it("keeps only recorded mentions still present in the text", () => {
    expect(declaredMentionIds("@Ada Lovelace hi", [ADA, BOB])).toEqual(["usr_ada"])
  })

  it("never derives an id from text nobody picked", () => {
    expect(declaredMentionIds("@Bob hi", [ADA])).toEqual([])
  })

  it("sends each id once, in pick order", () => {
    expect(declaredMentionIds("@Bob @Ada Lovelace @Bob", [BOB, ADA, BOB])).toEqual([
      "usr_bob",
      "usr_ada",
    ])
  })

  it("caps at the server's limit", () => {
    const many = Array.from({ length: MAX_COMMENT_MENTIONS + 5 }, (_, i) => ({
      userId: `usr_${i}`,
      displayName: `P${i}`,
    }))
    const body = many.map((mention) => mentionToken(mention.displayName)).join(" ")
    expect(declaredMentionIds(body, many)).toHaveLength(MAX_COMMENT_MENTIONS)
  })
})

describe("insertMention", () => {
  it("inserts at the caret with a trailing space", () => {
    expect(insertMention("", { start: 0, end: 0 }, "Bob")).toEqual({ body: "@Bob ", caret: 5 })
  })

  it("separates the token from a preceding word", () => {
    expect(insertMention("hi", { start: 2, end: 2 }, "Bob")).toEqual({
      body: "hi @Bob ",
      caret: 8,
    })
  })

  it("replaces a typed @ rather than doubling it", () => {
    expect(insertMention("hi @", { start: 3, end: 4 }, "Bob")).toEqual({
      body: "hi @Bob ",
      caret: 8,
    })
  })

  it("replaces a selection and reuses the following space", () => {
    expect(insertMention("hi there you", { start: 3, end: 8 }, "Bob")).toEqual({
      body: "hi @Bob you",
      caret: 8,
    })
  })

  it("clamps an out-of-range selection", () => {
    expect(insertMention("hi", { start: 9, end: 4 }, "Bob").body).toBe("hi @Bob ")
  })
})

describe("typedMentionTrigger", () => {
  it("fires for an @ that starts a word", () => {
    expect(typedMentionTrigger("", "@", 1)).toBe(0)
    expect(typedMentionTrigger("hi ", "hi @", 4)).toBe(3)
    expect(typedMentionTrigger("a\n", "a\n@", 3)).toBe(2)
  })

  it("ignores an @ inside a word, like an address", () => {
    expect(typedMentionTrigger("ops", "ops@", 4)).toBeNull()
  })

  it("ignores pastes and deletions", () => {
    expect(typedMentionTrigger("", "@Bob", 4)).toBeNull()
    expect(typedMentionTrigger("@B", "@", 1)).toBeNull()
  })

  it("ignores any other character", () => {
    expect(typedMentionTrigger("", "a", 1)).toBeNull()
  })
})
