import type { UIMessage } from "ai"

import { useChatStore } from "@/stores/chat"
import { reflectMessageReactions } from "./reactions-store"

const message = (id: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: id }], metadata: { foo: 1 } }) as never

beforeEach(() => {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("s1")
  useChatStore.getState().replaceSessionMessages("s1", [message("a"), message("b")])
})

it("rewrites exactly the one message's reactions and keeps the rest of its metadata", () => {
  const before = useChatStore.getState().sessions.s1!.messages
  expect(reflectMessageReactions("s1", "b", [{ emoji: "👍", actorIds: ["local"] }])).toBe(true)
  const after = useChatStore.getState().sessions.s1!.messages
  expect(after[0]).toBe(before[0])
  expect(after[1]!.metadata).toEqual({ foo: 1, reactions: [{ emoji: "👍", actorIds: ["local"] }] })
})

it("leaves a session with no open slice, or an unknown message, untouched", () => {
  const before = useChatStore.getState()
  expect(reflectMessageReactions("s9", "a", [])).toBe(false)
  expect(reflectMessageReactions("s1", "ghost", [])).toBe(false)
  expect(useChatStore.getState()).toBe(before)
})
