import type { UIMessage } from "ai"

import {
  liveVoiceMessageId,
  liveVoiceTurnsToMessages,
  persistLiveVoiceTurns,
  type LiveVoiceTurnProvenance,
} from "./persist-turns"

const PROVENANCE: LiveVoiceTurnProvenance = {
  provider: "openai",
  modelOrResource: "gpt-realtime-2.1",
  region: "global",
}

const TURNS = [
  { id: "item_1", role: "user" as const, text: "what is the weather" },
  { id: "item_2", role: "assistant" as const, text: "sunny" },
]

function metaOf(message: UIMessage): Record<string, unknown> {
  return (message.metadata ?? {}) as Record<string, unknown>
}

describe("liveVoiceTurnsToMessages", () => {
  it("projects each turn onto a text message", () => {
    const messages = liveVoiceTurnsToMessages("s1", {
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      id: liveVoiceMessageId("s1", "item_1"),
      role: "user",
      parts: [{ type: "text", text: "what is the weather" }],
    })
    expect(messages[1]).toMatchObject({ role: "assistant" })
  })

  it("stamps every turn so it cannot fire chat-message workflows", () => {
    // Speech never went through the send path; firing workflows off it would
    // surprise the user. The flag has to be present on the first write.
    const messages = liveVoiceTurnsToMessages("s1", {
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    for (const message of messages) {
      expect(metaOf(message).triggerWorkflows).toBe(false)
    }
  })

  it("records which provider and region the turn was spoken to", () => {
    const [first] = liveVoiceTurnsToMessages("s1", {
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(metaOf(first)).toMatchObject({
      provider: "openai",
      modelOrResource: "gpt-realtime-2.1",
      region: "global",
      modality: "audio",
      final: true,
    })
  })

  it("gives each turn a strictly increasing timestamp", () => {
    // listMessages sorts by createdAt and a whole voice session lands inside
    // one millisecond, so equal stamps would scramble the transcript.
    const messages = liveVoiceTurnsToMessages("s1", {
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(metaOf(messages[0]).createdAt).toBe(1_000)
    expect(metaOf(messages[1]).createdAt).toBe(1_001)
  })

  it("derives ids from the provider item id so a re-write updates in place", () => {
    const first = liveVoiceTurnsToMessages("s1", {
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })
    const again = liveVoiceTurnsToMessages("s1", {
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 9_000,
    })

    expect(first.map((m) => m.id)).toEqual(again.map((m) => m.id))
  })

  it("scopes ids to the session so two sessions never collide", () => {
    expect(liveVoiceMessageId("s1", "item_1")).not.toBe(liveVoiceMessageId("s2", "item_1"))
  })

  it("drops a turn the provider heard as silence", () => {
    const messages = liveVoiceTurnsToMessages("s1", {
      turns: [{ id: "item_1", role: "user", text: "   " }],
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(messages).toEqual([])
  })

  it("stores no audio, only the transcript", () => {
    const [first] = liveVoiceTurnsToMessages("s1", {
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
    })

    expect(first.parts).toEqual([{ type: "text", text: "what is the weather" }])
  })
})

describe("persistLiveVoiceTurns", () => {
  it("writes the voice turns alongside the existing history", async () => {
    // persistMessages reconciles the full list and deletes what is missing, so
    // dropping the prior history here would wipe the conversation.
    const persist = jest.fn(async () => {})
    const existing = [
      { id: "old_1", role: "user", parts: [{ type: "text", text: "typed earlier" }] },
    ] as unknown as UIMessage[]

    const written = await persistLiveVoiceTurns({
      sessionId: "s1",
      turns: TURNS,
      provenance: PROVENANCE,
      startedAt: 1_000,
      existing,
      persist,
    })

    expect(written).toBe(2)
    const [, messages] = persist.mock.calls[0] as unknown as [string, UIMessage[]]
    expect(messages.map((m) => m.id)).toEqual([
      "old_1",
      liveVoiceMessageId("s1", "item_1"),
      liveVoiceMessageId("s1", "item_2"),
    ])
  })

  it("replaces an earlier version of the same turn rather than duplicating it", async () => {
    const persist = jest.fn(async () => {})
    const existing = [
      {
        id: liveVoiceMessageId("s1", "item_1"),
        role: "user",
        parts: [{ type: "text", text: "stale partial" }],
      },
    ] as unknown as UIMessage[]

    await persistLiveVoiceTurns({
      sessionId: "s1",
      turns: [TURNS[0]],
      provenance: PROVENANCE,
      startedAt: 1_000,
      existing,
      persist,
    })

    const [, messages] = persist.mock.calls[0] as unknown as [string, UIMessage[]]
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toEqual([{ type: "text", text: "what is the weather" }])
  })

  it("writes nothing at all for a session where nobody spoke", async () => {
    const persist = jest.fn(async () => {})

    const written = await persistLiveVoiceTurns({
      sessionId: "s1",
      turns: [],
      provenance: PROVENANCE,
      startedAt: 1_000,
      existing: [],
      persist,
    })

    expect(written).toBe(0)
    expect(persist).not.toHaveBeenCalled()
  })
})
