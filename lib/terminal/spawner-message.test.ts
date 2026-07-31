import { lastAssistantMessageId, type SpawnerMessageLookup } from "./spawner-message"

const msg = (id: string, role: string) => ({ id, role })

function state(overrides: Partial<SpawnerMessageLookup> = {}): SpawnerMessageLookup {
  return { sessions: {}, activeSessionId: null, messages: [], ...overrides }
}

describe("lastAssistantMessageId", () => {
  it("returns the assistant message the tool call is streaming into", () => {
    const s = state({
      sessions: { s1: { messages: [msg("u1", "user"), msg("a1", "assistant")] } },
    })
    expect(lastAssistantMessageId(s, "s1")).toBe("a1")
  })

  it("takes the LAST assistant message, not the first", () => {
    const s = state({
      sessions: {
        s1: {
          messages: [
            msg("u1", "user"),
            msg("a1", "assistant"),
            msg("u2", "user"),
            msg("a2", "assistant"),
          ],
        },
      },
    })
    expect(lastAssistantMessageId(s, "s1")).toBe("a2")
  })

  it("prefers the session's own slice over the active projection", () => {
    // In split view — or a background agent run — the top-level `messages`
    // projection belongs to a different conversation entirely, so reading it
    // would attribute the spawn to a message in the wrong thread.
    const s = state({
      sessions: { bg: { messages: [msg("bg-a1", "assistant")] } },
      activeSessionId: "fg",
      messages: [msg("fg-a1", "assistant")],
    })
    expect(lastAssistantMessageId(s, "bg")).toBe("bg-a1")
  })

  it("falls back to the active projection when the slice is missing", () => {
    // `sessions[activeSessionId]` can legitimately be absent while `messages`
    // is live — see the chat store's projection note.
    const s = state({ activeSessionId: "s1", messages: [msg("a1", "assistant")] })
    expect(lastAssistantMessageId(s, "s1")).toBe("a1")
  })

  it("does not read the active projection for a different session", () => {
    const s = state({ activeSessionId: "other", messages: [msg("a1", "assistant")] })
    expect(lastAssistantMessageId(s, "s1")).toBeNull()
  })

  it("returns null when the turn has no assistant message yet", () => {
    // A slash command or workflow trigger can spawn a terminal before any
    // assistant reply exists; guessing there is worse than offering
    // session-level navigation.
    const s = state({ sessions: { s1: { messages: [msg("u1", "user")] } } })
    expect(lastAssistantMessageId(s, "s1")).toBeNull()
  })

  it("returns null without a session id", () => {
    expect(lastAssistantMessageId(state(), null)).toBeNull()
    expect(lastAssistantMessageId(state(), undefined)).toBeNull()
    expect(lastAssistantMessageId(state(), "")).toBeNull()
  })

  it("returns null for an unknown session", () => {
    expect(lastAssistantMessageId(state(), "nope")).toBeNull()
  })
})
