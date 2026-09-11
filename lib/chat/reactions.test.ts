const setMessageReaction = jest.fn(async () => [{ emoji: "👍", actorIds: ["local"] }])
jest.mock("@/lib/db/messages", () => ({
  setMessageReaction: (...args: unknown[]) => setMessageReaction(...(args as [])),
}))
jest.mock("@/lib/connectors/inbox-writes/route", () => ({
  resolveInboxWriteRoute: () => "unavailable",
}))
const reflectMessageReactions = jest.fn()
jest.mock("./reactions-store", () => ({
  reflectMessageReactions: (...args: unknown[]) => reflectMessageReactions(...(args as [])),
}))

import {
  MESSAGE_REACTION_EMOJIS,
  messageAllowsReactions,
  platformAddressOf,
  reactionAbilityFor,
  ReactionNeedsHostError,
  readReactions,
  toggleMessageReaction,
  type ReactionMirror,
} from "./reactions"

beforeEach(() => {
  setMessageReaction.mockClear()
  reflectMessageReactions.mockClear()
})

const imMessage = {
  id: "m1",
  metadata: {
    platformMessage: { messageId: "42", adapterId: "tg-1", platform: "telegram" },
    reactions: [{ emoji: "❤️", actorIds: ["local"], platformReactionIds: { local: "r-9" } }],
  },
}

function mirror(overrides: Partial<ReactionMirror> = {}): ReactionMirror & {
  calls: { add: unknown[][]; remove: unknown[][] }
} {
  const calls = { add: [] as unknown[][], remove: [] as unknown[][] }
  return {
    calls,
    add: async (...args) => {
      calls.add.push(args)
      return "r-new"
    },
    remove: async (...args) => {
      calls.remove.push(args)
    },
    ...overrides,
  }
}

describe("messageAllowsReactions", () => {
  it("applies to an IM row and to a row that already carries reactions", () => {
    expect(messageAllowsReactions(imMessage)).toBe(true)
    expect(
      messageAllowsReactions({ metadata: { reactions: [{ emoji: "👍", actorIds: ["x"] }] } })
    ).toBe(true)
  })

  it("does not apply to a solo assistant row, where a reaction reaches nobody", () => {
    expect(messageAllowsReactions({ metadata: {} })).toBe(false)
    expect(messageAllowsReactions({})).toBe(false)
    expect(messageAllowsReactions({ metadata: { reactions: [] } })).toBe(false)
  })
})

describe("readers", () => {
  it("reads reactions and the IM address defensively", () => {
    expect(readReactions({ metadata: { reactions: "no" } })).toEqual([])
    expect(readReactions(imMessage)).toHaveLength(1)
    expect(platformAddressOf(imMessage)).toEqual({ adapterId: "tg-1", platformMessageId: "42" })
    expect(platformAddressOf({ metadata: { platformMessage: { messageId: "x" } } })).toBeNull()
    expect(platformAddressOf({})).toBeNull()
    expect(MESSAGE_REACTION_EMOJIS).toContain("👍")
  })

  it("maps the write route onto what a shell may do", () => {
    expect(reactionAbilityFor("local")).toBe("write-and-mirror")
    expect(reactionAbilityFor("unavailable")).toBe("write-only")
    expect(reactionAbilityFor("remote")).toBe("host-only")
  })
})

describe("toggleMessageReaction", () => {
  it("adds when the actor has not reacted, mirrors, and keeps the platform id", async () => {
    const m = mirror()
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: { route: () => "local", mirror: async () => m },
    })
    expect(m.calls.add).toEqual([["tg-1", "42", "👍"]])
    expect(setMessageReaction).toHaveBeenCalledWith("s1", "m1", {
      emoji: "👍",
      actorId: "local",
      add: true,
      platformReactionId: "r-new",
    })
    expect(result).toMatchObject({ added: true, mirror: "done" })
    // The open pane sees the pill at once, not after the next reload.
    expect(reflectMessageReactions).toHaveBeenCalledWith("s1", "m1", [
      { emoji: "👍", actorIds: ["local"] },
    ])
  })

  it("removes with the stored platform id when the actor already reacted", async () => {
    const m = mirror()
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "❤️",
      deps: { route: () => "local", mirror: async () => m },
    })
    expect(m.calls.remove).toEqual([["tg-1", "42", { reactionId: "r-9", emoji: "❤️" }]])
    expect(setMessageReaction).toHaveBeenCalledWith("s1", "m1", {
      emoji: "❤️",
      actorId: "local",
      add: false,
    })
    expect(result.added).toBe(false)
  })

  it("still records the reaction when the platform refuses it, and says so", async () => {
    const m = mirror({
      add: async () => {
        throw new Error("adapter cannot add reactions")
      },
    })
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: { route: () => "local", mirror: async () => m },
    })
    expect(setMessageReaction).toHaveBeenCalledTimes(1)
    expect(result.mirror).toEqual({ failed: "adapter cannot add reactions" })
  })

  it("skips the mirror for a message with no IM address and off the local route", async () => {
    const m = mirror()
    const plain = await toggleMessageReaction({
      sessionId: "s1",
      message: { id: "m2", metadata: {} },
      emoji: "👍",
      deps: { route: () => "local", mirror: async () => m },
    })
    expect(plain.mirror).toBe("skipped")
    const standalone = await toggleMessageReaction({
      sessionId: "s1",
      message: imMessage,
      emoji: "👍",
      deps: {
        route: () => "unavailable",
        mirror: async () => {
          throw new Error("must not load")
        },
      },
    })
    expect(standalone.mirror).toBe("skipped")
    expect(m.calls.add).toEqual([])
  })

  it("refuses to write on a companion, whose rows belong to the host", async () => {
    await expect(
      toggleMessageReaction({
        sessionId: "s1",
        message: imMessage,
        emoji: "👍",
        deps: { route: () => "remote" },
      })
    ).rejects.toBeInstanceOf(ReactionNeedsHostError)
    expect(setMessageReaction).not.toHaveBeenCalled()
  })

  it("resolves the route from production when no seam is given", async () => {
    const result = await toggleMessageReaction({
      sessionId: "s1",
      message: { id: "m2", metadata: {} },
      emoji: "👀",
    })
    expect(result.mirror).toBe("skipped")
  })
})
