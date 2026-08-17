import { MentionAccumulator } from "./mention-extractor"

describe("MentionAccumulator", () => {
  it("starts empty and reports no self-mention", () => {
    const acc = new MentionAccumulator("bot_1")
    expect(acc.finalize()).toEqual({ selfMentioned: false, users: [] })
  })

  it("dedupes user ids while preserving insertion order", () => {
    const acc = new MentionAccumulator("bot_1")
    acc.add("alice")
    acc.add("bob")
    acc.add("alice")
    acc.add("charlie")
    expect(acc.finalize().users).toEqual(["alice", "bob", "charlie"])
  })

  it("auto-detects selfId in the candidate list", () => {
    const acc = new MentionAccumulator("bot_1")
    acc.add("alice")
    acc.add("bot_1")
    expect(acc.finalize().selfMentioned).toBe(true)
  })

  it("flips selfMentioned even when the self id is re-added after dedup", () => {
    const acc = new MentionAccumulator("bot_1")
    acc.add("bot_1")
    acc.add("alice")
    acc.add("bot_1") // duplicate add but still asserts self
    expect(acc.finalize().selfMentioned).toBe(true)
    expect(acc.finalize().users).toEqual(["bot_1", "alice"])
  })

  it("ignores empty/null/undefined ids", () => {
    const acc = new MentionAccumulator("bot_1")
    acc.add("")
    acc.add(null)
    acc.add(undefined)
    acc.add("alice")
    expect(acc.finalize()).toEqual({ selfMentioned: false, users: ["alice"] })
  })

  it("markSelfMentioned forces the flag without adding a user id", () => {
    const acc = new MentionAccumulator("bot_1")
    acc.markSelfMentioned()
    acc.add("alice")
    expect(acc.finalize()).toEqual({ selfMentioned: true, users: ["alice"] })
  })
})
