import { conversationTarget } from "@/lib/policy/action-review/outbound-targets"

import { knownConversationsOf } from "./use-known-conversations"

function session(conversationKey: string, title: string, lastMessageAt: number) {
  return {
    title,
    lastMessageAt,
    updatedAt: 0,
    platformBinding: { conversationKey } as never,
  }
}

describe("knownConversationsOf", () => {
  it("names each chat once, by its newest session, newest first", () => {
    const known = knownConversationsOf([
      session("lark:bot-a:oc_1", "Old title", 1),
      session("lark:bot-a:oc_1:om_thread", "Team chat", 5),
      session("lark:bot-a:oc_2", "Ops", 3),
    ])
    expect(known.map((entry) => [entry.target, entry.title])).toEqual([
      [conversationTarget("lark:bot-a:oc_1"), "Team chat"],
      [conversationTarget("lark:bot-a:oc_2"), "Ops"],
    ])
  })

  it("keeps to one bot account when asked, and skips unbound or malformed sessions", () => {
    const known = knownConversationsOf(
      [
        session("lark:bot-a:oc_1", "A", 1),
        session("lark:bot-b:oc_9", "B", 2),
        { title: "Local", lastMessageAt: 3, updatedAt: 0 },
        session("not-a-key", "Broken", 4),
      ],
      "bot-a"
    )
    expect(known.map((entry) => entry.title)).toEqual(["A"])
  })

  it("falls back to the key for an untitled session", () => {
    expect(knownConversationsOf([session("lark:bot-a:oc_1", "  ", 1)])[0].title).toBe(
      "lark:bot-a:oc_1"
    )
  })
})
