import { SUB_SEPARATOR, subSessionId, decodeSubSession, isSubSessionId } from "./team-session-id"

describe("team-session-id", () => {
  it("round-trips team session + character through subSessionId/decodeSubSession", () => {
    const sub = subSessionId("sess-1", "char-a", "t1")
    expect(sub).toBe(`sess-1${SUB_SEPARATOR}char-a::t1`)
    expect(decodeSubSession(sub)).toEqual({ teamSessionId: "sess-1", characterId: "char-a" })
  })

  it("decodes ids without a turn suffix", () => {
    expect(decodeSubSession(`sess-1${SUB_SEPARATOR}char-a`)).toEqual({
      teamSessionId: "sess-1",
      characterId: "char-a",
    })
  })

  it("returns null for plain session ids", () => {
    expect(decodeSubSession("sess-1")).toBeNull()
    expect(decodeSubSession("")).toBeNull()
  })

  it("keeps supervisor round suffixes out of the characterId", () => {
    const sub = subSessionId("sess-1", "char-a", "t1r2")
    expect(decodeSubSession(sub)).toEqual({ teamSessionId: "sess-1", characterId: "char-a" })
  })

  it("isSubSessionId matches only sub-session ids", () => {
    expect(isSubSessionId(subSessionId("s", "c", "t"))).toBe(true)
    expect(isSubSessionId("s")).toBe(false)
  })
})
