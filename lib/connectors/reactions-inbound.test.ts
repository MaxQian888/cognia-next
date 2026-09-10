const setMessageReaction = jest.fn(async () => [])
jest.mock("@/lib/db/messages", () => ({
  setMessageReaction: (...args: unknown[]) => setMessageReaction(...(args as [])),
}))
const reflectMessageReactions = jest.fn()
jest.mock("@/lib/chat/reactions-store", () => ({
  reflectMessageReactions: (...args: unknown[]) => reflectMessageReactions(...(args as [])),
}))

import { isReactionSystemEvent, recordInboundReaction } from "./reactions-inbound"

beforeEach(() => {
  setMessageReaction.mockClear()
  reflectMessageReactions.mockClear()
})

const row = { id: "m1", sessionId: "s1" }
const sender = { remoteUserId: "u7", displayName: "Ada" } as never

it("classifies the two reaction kinds", () => {
  expect(isReactionSystemEvent("reaction_added")).toBe(true)
  expect(isReactionSystemEvent("reaction_removed")).toBe(true)
  expect(isReactionSystemEvent("member_added")).toBe(false)
  expect(isReactionSystemEvent(undefined)).toBe(false)
})

it("adds and removes under the platform-namespaced actor", async () => {
  expect(
    await recordInboundReaction({
      event: { platform: "telegram", sender, systemKind: "reaction_added" },
      row,
      emoji: "👍",
    })
  ).toBe(true)
  expect(setMessageReaction).toHaveBeenCalledWith("s1", "m1", {
    emoji: "👍",
    actorId: "telegram:u7",
    add: true,
  })
  expect(reflectMessageReactions).toHaveBeenCalledWith("s1", "m1", [])
  await recordInboundReaction({
    event: { platform: "telegram", sender, systemKind: "reaction_removed" },
    row,
    emoji: "👍",
  })
  expect(setMessageReaction).toHaveBeenLastCalledWith("s1", "m1", {
    emoji: "👍",
    actorId: "telegram:u7",
    add: false,
  })
})

it("writes nothing without an actor, an emoji, or a reaction kind", async () => {
  expect(
    await recordInboundReaction({
      event: {
        platform: "telegram",
        sender: { remoteUserId: "" } as never,
        systemKind: "reaction_added",
      },
      row,
      emoji: "👍",
    })
  ).toBe(false)
  expect(
    await recordInboundReaction({
      event: { platform: "telegram", sender, systemKind: "reaction_added" },
      row,
      emoji: "",
    })
  ).toBe(false)
  expect(
    await recordInboundReaction({
      event: { platform: "telegram", sender, systemKind: "poke" },
      row,
      emoji: "👍",
    })
  ).toBe(false)
  expect(setMessageReaction).not.toHaveBeenCalled()
})
