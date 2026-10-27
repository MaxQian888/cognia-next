import type { UIMessage } from "ai"
import type { TranscriptTimelineItem } from "@cognia/agent-config-types"

import type { TranscriptLiveTurn } from "./live-frames"
import { settledReplyCaughtUp, withLiveReply, withLiveTurn } from "./live-turn-view"

const live = (overrides: Partial<TranscriptLiveTurn> = {}): TranscriptLiveTurn => ({
  sessionId: "s1",
  messageId: "assistant-a1",
  replyTo: "u2",
  seq: 3,
  parts: [{ type: "text", text: "live" }] as UIMessage["parts"],
  state: "streaming",
  stale: false,
  ...overrides,
})

const reply: UIMessage = {
  id: "assistant-a1",
  role: "assistant",
  parts: [{ type: "text", text: "live" }],
}

const earlier: TranscriptTimelineItem = {
  kind: "completed-turn",
  itemKey: "turn:u1",
  turnKey: "turn:u1",
  revision: 4,
  detailRevision: 4,
  status: "completed",
  userMessages: [{ id: "u1", role: "user", text: "first", createdAt: 1 }],
  finalResponse: { id: "assistant-a0", role: "assistant", text: "done", createdAt: 2 },
  collapsed: { exists: false, messageCount: 2, trailingCount: 0, mediaCount: 0 },
  startedAt: 1,
}

const current: TranscriptTimelineItem = {
  kind: "completed-turn",
  itemKey: "turn:u2",
  turnKey: "turn:u2",
  revision: 4,
  detailRevision: 4,
  status: "completed",
  userMessages: [{ id: "u2", role: "user", text: "second", createdAt: 3 }],
  finalResponse: { id: "assistant-a1", role: "assistant", text: "li", createdAt: 4 },
  visibleResult: { id: "assistant-a1", role: "assistant", text: "li", createdAt: 4 },
  collapsed: { exists: true, messageCount: 3, trailingCount: 0, mediaCount: 0 },
  startedAt: 3,
}

const tail: UIMessage[] = [{ id: "u2", role: "user", parts: [{ type: "text", text: "second" }] }]

describe("withLiveTurn", () => {
  it("p6e leaves the timeline and tail alone without a live reply", () => {
    const view = withLiveTurn({ items: [earlier, current], tail, live: null })
    expect(view).toEqual({ items: [earlier, current], liveMessages: tail })
  })

  it("p6e keeps the turn's user side in the timeline and draws its reply live", () => {
    const view = withLiveTurn({ items: [earlier, current], tail, live: live() })
    expect(view.items[0]).toBe(earlier)
    expect(view.items[1]).toEqual({
      kind: "completed-turn",
      itemKey: "turn:u2",
      turnKey: "turn:u2",
      revision: 4,
      detailRevision: 4,
      status: "completed",
      userMessages: current.kind === "completed-turn" ? current.userMessages : [],
      collapsed: { exists: false, messageCount: 3, trailingCount: 0, mediaCount: 0 },
      startedAt: 3,
    })
    // The user's message is the timeline's; drawing the tail's copy would double it.
    expect(view.liveMessages).toEqual([reply])
  })

  it("p6e keeps another message's reply preview in the live turn", () => {
    const other = {
      ...current,
      finalResponse: { id: "assistant-z", role: "assistant" as const, createdAt: 5 },
    }
    const view = withLiveTurn({ items: [other], tail, live: live() })
    expect((view.items[0] as typeof other).finalResponse?.id).toBe("assistant-z")
    expect((view.items[0] as typeof other).visibleResult).toBeUndefined()
  })

  it("p6e finds the turn by its user message, and drops the reply from an active turn", () => {
    const active: TranscriptTimelineItem = {
      kind: "active-turn",
      itemKey: "k",
      turnKey: "explicit-key",
      revision: 4,
      status: "active",
      messages: [
        { id: "u2", sessionId: "s1", role: "user", parts: [], createdAt: 3 },
        { id: "assistant-a1", sessionId: "s1", role: "assistant", parts: [], createdAt: 4 },
      ],
      startedAt: 3,
    }
    const view = withLiveTurn({ items: [active], tail, live: live() })
    expect((view.items[0] as typeof active).messages.map((message) => message.id)).toEqual(["u2"])
    expect(view.liveMessages).toEqual([reply])
  })

  it("p6e draws a turn the timeline has not read from the store's tail plus the reply", () => {
    expect(withLiveTurn({ items: [earlier], tail, live: live() }).liveMessages).toEqual([
      ...tail,
      reply,
    ])
    const stale: UIMessage = { id: "assistant-a1", role: "assistant", parts: [] }
    expect(
      withLiveTurn({ items: [earlier], tail: [...tail, stale], live: live() }).liveMessages
    ).toEqual([...tail, reply])
  })
})

describe("settledReplyCaughtUp", () => {
  it("p6e lets go of a finished reply once the timeline reads past its revision", () => {
    expect(settledReplyCaughtUp(live(), 9, 1)).toBe(false)
    const settled = live({ state: "settled", afterRevision: 6 })
    expect(settledReplyCaughtUp(settled, null, null)).toBe(false)
    // A read of the one-second write before the final one is not enough.
    expect(settledReplyCaughtUp(settled, 6, 5)).toBe(false)
    expect(settledReplyCaughtUp(settled, 7, 5)).toBe(true)
  })

  it("p6e without a revision, takes any timeline read after the settle", () => {
    const settled = live({ state: "settled" })
    expect(settledReplyCaughtUp(settled, 5, 5)).toBe(false)
    expect(settledReplyCaughtUp(settled, 6, 5)).toBe(true)
    expect(settledReplyCaughtUp(settled, 6, null)).toBe(false)
  })
})

describe("withLiveReply (ADR-0241)", () => {
  const turn: TranscriptLiveTurn = {
    sessionId: "s",
    messageId: "a",
    replyTo: "u",
    seq: 2,
    parts: [{ type: "text", text: "live" }],
    state: "streaming",
    stale: false,
  }
  const user = { id: "u", role: "user", parts: [{ type: "text", text: "q" }] } as UIMessage

  it("leaves the list alone without a live reply", () => {
    const list = [user]
    expect(withLiveReply(list, null)).toBe(list)
  })

  it("appends a reply nothing stored yet", () => {
    expect(withLiveReply([user], turn)).toEqual([
      user,
      { id: "a", role: "assistant", parts: turn.parts },
    ])
  })

  it("draws over the stored copy and keeps its other fields", () => {
    const stored = {
      id: "a",
      role: "assistant",
      parts: [{ type: "text", text: "old" }],
      metadata: { model: "m" },
    } as UIMessage
    expect(withLiveReply([user, stored], turn)).toEqual([user, { ...stored, parts: turn.parts }])
  })
})
