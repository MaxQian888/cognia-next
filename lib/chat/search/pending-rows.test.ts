/** @jest-environment jsdom */

import { pendingSearchRows } from "./pending-rows"
import { useChatStore } from "@/stores/chat"

function message(id: string, text: string, createdAt?: number) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text", text }],
    ...(createdAt !== undefined ? { metadata: { createdAt } } : {}),
  }
}

function setStore(over: Record<string, unknown>): void {
  useChatStore.setState(over as never)
}

beforeEach(() => {
  setStore({ sessions: {}, messages: [], activeSessionId: null })
})

describe("pendingSearchRows", () => {
  it("is empty with nothing open", () => {
    expect(pendingSearchRows()).toEqual([])
  })

  // The idle index trails streaming writes, so the message a user is most
  // likely searching for is exactly the one Dexie does not have yet.
  it("projects the active conversation's in-memory messages", () => {
    setStore({ activeSessionId: "s1", messages: [message("m1", "just typed")] })
    const rows = pendingSearchRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ messageId: "m1", sessionId: "s1", text: "just typed" })
  })

  it("projects background slices too", () => {
    setStore({ sessions: { s2: { messages: [message("m2", "elsewhere")] } } })
    expect(pendingSearchRows().map((r) => r.sessionId)).toEqual(["s2"])
  })

  // The active slice is the newer copy of the same conversation.
  it("prefers the active slice over the stored one for the same session", () => {
    setStore({
      sessions: { s1: { messages: [message("m1", "stale")] } },
      activeSessionId: "s1",
      messages: [message("m1", "fresh")],
    })
    const rows = pendingSearchRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe("fresh")
  })

  it("deduplicates a message that appears in two slices", () => {
    setStore({
      sessions: {
        a: { messages: [message("shared", "once")] },
        b: { messages: [message("shared", "again")] },
      },
    })
    expect(pendingSearchRows()).toHaveLength(1)
  })

  it("skips a message with no searchable text", () => {
    setStore({ activeSessionId: "s1", messages: [{ id: "m1", role: "user", parts: [] }] })
    expect(pendingSearchRows()).toEqual([])
  })

  it("takes createdAt from metadata when it is there", () => {
    setStore({ activeSessionId: "s1", messages: [message("m1", "x", 4242)] })
    expect(pendingSearchRows()[0].createdAt).toBe(4242)
  })

  // These rows are scanned in memory and never reach a `[projectId+createdAt]`
  // index; the engine's workspace filter reads the SESSION, not the row.
  it("leaves projectId empty rather than guessing a workspace", () => {
    setStore({ activeSessionId: "s1", messages: [message("m1", "x")] })
    expect(pendingSearchRows()[0].projectId).toBe("")
  })
})
