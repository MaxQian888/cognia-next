/** @jest-environment jsdom */

import { countMobileUnread, type UnreadCountSession } from "./unread-count"

const session = (over: Partial<UnreadCountSession> & { id: string }): UnreadCountSession =>
  ({ kind: "direct", ...over }) as UnreadCountSession

const unread = (...ids: string[]) => new Map(ids.map((id) => [id, 1]))

describe("countMobileUnread", () => {
  it("counts an unread conversation once, whatever its unread depth", () => {
    const counts = countMobileUnread(
      [session({ id: "a" }), session({ id: "b" })],
      new Map([
        ["a", 12],
        ["b", 1],
      ])
    )
    expect(counts).toEqual({ chat: 2, inbox: 0 })
  })

  it("ignores a conversation with no unread pointer", () => {
    expect(countMobileUnread([session({ id: "a" }), session({ id: "b" })], unread("a"))).toEqual({
      chat: 1,
      inbox: 0,
    })
  })

  it("skips a pointer whose session is gone, which is why the table needs no tombstones", () => {
    expect(countMobileUnread([undefined], unread("a"))).toEqual({ chat: 0, inbox: 0 })
  })

  it("excludes archived conversations, which the list would not show", () => {
    expect(countMobileUnread([session({ id: "a", archivedAt: 1 })], unread("a"))).toEqual({
      chat: 0,
      inbox: 0,
    })
  })

  it("excludes transcripts the main list never shows", () => {
    // Same exclusion the desktop guild badge applies: a badge must not promise
    // something tappable that the list cannot show.
    const embedded = session({ id: "a", kind: "subagent" as UnreadCountSession["kind"] })
    expect(countMobileUnread([embedded], unread("a"))).toEqual({ chat: 0, inbox: 0 })
  })

  it("files an IM-bound conversation under both chat and inbox", () => {
    const counts = countMobileUnread(
      [
        session({ id: "a" }),
        session({ id: "b", platformConversationKey: "lark:oc_1" }),
        session({
          id: "c",
          integrationBinding: { integrationId: "i1" } as UnreadCountSession["integrationBinding"],
        }),
      ],
      unread("a", "b", "c")
    )
    expect(counts).toEqual({ chat: 3, inbox: 2 })
  })

  it("counts nothing when every pointer is read", () => {
    expect(countMobileUnread([session({ id: "a" })], new Map())).toEqual({ chat: 0, inbox: 0 })
  })
})
