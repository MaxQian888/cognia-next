/** @jest-environment jsdom */

import { spawnerMessage } from "./spawner-message-arg"
import { useChatStore } from "@/stores/chat"

const msg = (id: string, role: "user" | "assistant") =>
  ({ id, role, parts: [{ type: "text", text: id }] }) as never

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, messages: [], sessions: {} })
})

describe("spawnerMessage", () => {
  it("produces a spreadable option when the turn can be identified", () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messages: [msg("u1", "user"), msg("a1", "assistant")],
    })
    expect(spawnerMessage("s1")).toEqual({ agentSpawnerMessageId: "a1" })
  })

  it("omits the key entirely when it cannot tell", () => {
    // This is spread into the spawn options, so "unknown" has to be an ABSENT
    // key rather than an explicit `undefined` — the latter would still overwrite
    // a value in the object it merges into.
    expect(Object.keys(spawnerMessage("s1"))).toHaveLength(0)
  })

  it("omits the key with no session", () => {
    expect(spawnerMessage(null)).toEqual({})
    expect(spawnerMessage(undefined)).toEqual({})
  })
})
