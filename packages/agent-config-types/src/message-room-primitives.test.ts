import {
  applyReactionChange,
  buildReplyPreview,
  formatReactionSummary,
  hasReacted,
  platformReactorId,
  REPLY_PREVIEW_MAX,
  type MessageReaction,
} from "./message-room-primitives"

describe("buildReplyPreview", () => {
  it("joins text parts, collapses whitespace and caps the length", () => {
    const parts = [
      { type: "text", text: "  first\n\nline " },
      { type: "tool-Read", toolCallId: "t", state: "output-available" },
      { type: "text", text: "second" },
    ]
    expect(buildReplyPreview(parts)).toBe("first line second")
    expect(buildReplyPreview([{ type: "text", text: "x".repeat(500) }])).toHaveLength(
      REPLY_PREVIEW_MAX
    )
    expect(buildReplyPreview(undefined)).toBe("")
  })
})

describe("applyReactionChange", () => {
  const base: MessageReaction[] = [{ emoji: "👍", actorIds: ["local"] }]

  it("adds a new emoji and a second actor on an existing one", () => {
    const withHeart = applyReactionChange(base, { emoji: "❤️", actorId: "local", add: true })
    expect(withHeart).toEqual([
      { emoji: "👍", actorIds: ["local"] },
      { emoji: "❤️", actorIds: ["local"] },
    ])
    const two = applyReactionChange(withHeart, { emoji: "👍", actorId: "tg:u2", add: true })
    expect(two[0]).toEqual({ emoji: "👍", actorIds: ["local", "tg:u2"] })
  })

  it("returns the same array when the change is a no-op", () => {
    expect(applyReactionChange(base, { emoji: "👍", actorId: "local", add: true })).toBe(base)
    expect(applyReactionChange(base, { emoji: "🎉", actorId: "local", add: false })).toBe(base)
    expect(applyReactionChange(base, { emoji: "👍", actorId: "ghost", add: false })).toBe(base)
    expect(applyReactionChange(undefined, { emoji: "👍", actorId: "a", add: false })).toEqual([])
  })

  it("removes an actor, and the emoji once nobody is left", () => {
    const two = applyReactionChange(base, { emoji: "👍", actorId: "tg:u2", add: true })
    const one = applyReactionChange(two, { emoji: "👍", actorId: "local", add: false })
    expect(one).toEqual([{ emoji: "👍", actorIds: ["tg:u2"] }])
    expect(applyReactionChange(one, { emoji: "👍", actorId: "tg:u2", add: false })).toEqual([])
  })

  it("keeps the platform reaction id per actor and drops it with the actor", () => {
    const added = applyReactionChange(undefined, {
      emoji: "👍",
      actorId: "local",
      add: true,
      platformReactionId: "r-1",
    })
    expect(added[0]?.platformReactionIds).toEqual({ local: "r-1" })
    // A repeated add that carries a fresh platform id updates the id only.
    const renewed = applyReactionChange(added, {
      emoji: "👍",
      actorId: "local",
      add: true,
      platformReactionId: "r-2",
    })
    expect(renewed[0]).toEqual({
      emoji: "👍",
      actorIds: ["local"],
      platformReactionIds: { local: "r-2" },
    })
    const other = applyReactionChange(renewed, { emoji: "👍", actorId: "x", add: true })
    const removed = applyReactionChange(other, { emoji: "👍", actorId: "local", add: false })
    expect(removed[0]).toEqual({ emoji: "👍", actorIds: ["x"] })
  })

  it("never mutates its input", () => {
    const frozen = Object.freeze([Object.freeze({ emoji: "👍", actorIds: Object.freeze(["a"]) })])
    expect(() =>
      applyReactionChange(frozen as unknown as MessageReaction[], {
        emoji: "👍",
        actorId: "b",
        add: true,
      })
    ).not.toThrow()
    expect(frozen[0]?.actorIds).toEqual(["a"])
  })
})

describe("hasReacted and formatReactionSummary", () => {
  it("answers per actor and summarises counts without actor ids", () => {
    const reactions: MessageReaction[] = [
      { emoji: "👍", actorIds: ["local", "tg:u2"] },
      { emoji: "❤️", actorIds: ["tg:u2"] },
      { emoji: "🎉", actorIds: [] },
    ]
    expect(hasReacted(reactions, "👍", "local")).toBe(true)
    expect(hasReacted(reactions, "❤️", "local")).toBe(false)
    expect(hasReacted(undefined, "👍", "local")).toBe(false)
    expect(formatReactionSummary(reactions)).toBe("👍 2 · ❤️ 1")
    expect(formatReactionSummary([])).toBe("")
    expect(formatReactionSummary(undefined)).toBe("")
  })

  it("namespaces IM reactors by platform", () => {
    expect(platformReactorId("telegram", "42")).toBe("telegram:42")
  })
})
