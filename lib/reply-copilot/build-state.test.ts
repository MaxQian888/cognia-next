import {
  COPILOT_STATE_TRIM,
  COPILOT_WINDOW,
  buildCopilotTranscript,
  isSidedTranscript,
  sideOf,
  toCopilotState,
  type TranscriptRow,
} from "./build-state"

function inbound(text: string, userId = "u1", name = "Ann"): TranscriptRow {
  return {
    role: "user",
    parts: [{ type: "text", text }],
    metadata: {
      platformMessage: {
        messageId: `m-${text}`,
        platform: "telegram",
        sender: {
          id: `pi-${userId}`,
          platform: "telegram",
          remoteUserId: userId,
          displayName: name,
        },
      },
    },
  }
}

const mine = (
  text: string,
  meta: Record<string, unknown> = { outboundJobId: "j1" }
): TranscriptRow => ({
  role: "user",
  parts: [{ type: "text", text }],
  metadata: meta,
})

describe("sideOf", () => {
  it("classifies operator sends, agent replies, self echoes and inbound", () => {
    const none = new Set<string>()
    expect(sideOf(mine("hi"), none)).toBe("me")
    expect(sideOf(mine("hi", { relayIdempotencyKey: "k" }), none)).toBe("me")
    expect(sideOf({ role: "assistant", parts: [] }, none)).toBe("me")
    expect(sideOf(mine("hi", {}), none)).toBe("me")
    expect(sideOf(inbound("yo"), none)).toBe("other")
    expect(sideOf(inbound("echo", "bot-1"), new Set(["bot-1"]))).toBe("me")
  })
})

describe("buildCopilotTranscript", () => {
  it("keeps the last window of readable turns and the latest other sender", () => {
    const rows: TranscriptRow[] = [
      { role: "system", parts: [{ type: "text", text: "sys" }] },
      inbound("deleted", "u1", "Ann"),
      ...Array.from({ length: COPILOT_WINDOW + 2 }, (_, i) =>
        i % 2 ? mine(`me ${i}`) : inbound(`them ${i}`)
      ),
      mine("   "),
    ]
    rows[1].metadata = { ...rows[1].metadata, deletedAt: 1 }
    const t = buildCopilotTranscript(rows)
    expect(t.turns).toHaveLength(COPILOT_WINDOW)
    expect(t.turns.some((turn) => turn.text === "sys" || turn.text === "deleted")).toBe(false)
    expect(t.turns.at(-1)).toEqual({ from: "me", text: `me ${COPILOT_WINDOW + 1}` })
    expect(t.latestFrom).toBe("me")
    expect(t.latestOtherSender?.remoteUserId).toBe("u1")
    expect(t.isGroup).toBe(false)
    expect(t.turns.find((turn) => turn.from === "other")?.text).toMatch(/^them/)
  })

  it("names speakers in a group chat", () => {
    const t = buildCopilotTranscript([inbound("hi", "u1", "Ann"), inbound("hey", "u2", "Bo")])
    expect(t.isGroup).toBe(true)
    expect(t.turns.map((turn) => turn.text)).toEqual(["Ann: hi", "Bo: hey"])
    expect(t.latestOtherSender?.remoteUserId).toBe("u2")
  })

  it("handles an empty session", () => {
    expect(buildCopilotTranscript([])).toEqual({
      turns: [],
      latestFrom: "other",
      latestOtherSender: null,
      isGroup: false,
    })
  })
})

describe("toCopilotState", () => {
  it("emits the calibrated wire shape, background only when present", () => {
    const t = buildCopilotTranscript([inbound("在吗"), mine("在")])
    expect(toCopilotState(t, "friends")).toEqual({
      chat: {
        relationship: "friends",
        messages: [
          { from: "other", text: "在吗" },
          { from: "me", text: "在" },
        ],
        latest_from: "me",
      },
    })
    expect(toCopilotState(t, "friends", "  likes tea ")).toHaveProperty("background", "likes tea")
    expect(COPILOT_STATE_TRIM).toEqual(["chat", "messages"])
  })

  it("refuses a transcript with an unknown sender", () => {
    const t = buildCopilotTranscript([inbound("在吗")])
    const unsided = { ...t, turns: [...t.turns, { from: "unknown" as const, text: "?" }] }
    expect(isSidedTranscript(t)).toBe(true)
    expect(isSidedTranscript(unsided)).toBe(false)
    expect(() => toCopilotState(unsided, "friends")).toThrow(/unknown/)
  })
})
