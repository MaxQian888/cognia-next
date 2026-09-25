import { isSidedTranscript } from "../build-state"
import type { ScreenBubble } from "./bubble-grouper"
import { buildScreenTranscript } from "./screen-transcript"

function bubble(text: string, side: ScreenBubble["side"], speaker: string | null = null) {
  return { text, side, top: 0, speaker }
}

describe("buildScreenTranscript", () => {
  it("keeps trusted sides for a known two-sided app", () => {
    const read = buildScreenTranscript(
      [bubble("在吗", "other"), bubble("在", "me"), bubble("明天见？", "other")],
      "two_sided"
    )
    expect(read.unsidedReason).toBeNull()
    expect(isSidedTranscript(read.transcript)).toBe(true)
    expect(read.transcript).toEqual({
      turns: [
        { from: "other", text: "在吗" },
        { from: "me", text: "在" },
        { from: "other", text: "明天见？" },
      ],
      latestFrom: "other",
      latestOtherSender: null,
      isGroup: false,
    })
  })

  it("trusts a known two-sided app even when only the other person spoke", () => {
    const read = buildScreenTranscript([bubble("在吗", "other"), bubble("?", "other")], "two_sided")
    expect(read.unsidedReason).toBeNull()
  })

  it("forgets sides in a single-column app", () => {
    const read = buildScreenTranscript(
      [bubble("hi", "other"), bubble("yo", "other")],
      "single_column"
    )
    expect(read.unsidedReason).toBe("single_column")
    expect(read.transcript.turns.map((turn) => turn.from)).toEqual(["unknown", "unknown"])
    expect(read.transcript.latestFrom).toBe("unknown")
  })

  it("does not trust an unknown app that never shows the user's side", () => {
    const read = buildScreenTranscript([bubble("hi", "other"), bubble("yo", "other")], "unknown")
    expect(read.unsidedReason).toBe("one_sided")
    expect(isSidedTranscript(read.transcript)).toBe(false)
  })

  it("trusts an unknown app once both sides appear", () => {
    const read = buildScreenTranscript([bubble("hi", "other"), bubble("yo", "me")], "unknown")
    expect(read.unsidedReason).toBeNull()
  })

  it("marks a window with an unplaced bubble ambiguous, keeping the sides it did read", () => {
    const read = buildScreenTranscript(
      [bubble("hi", "other"), bubble("??", "unknown")],
      "two_sided"
    )
    expect(read.unsidedReason).toBe("ambiguous")
    expect(read.transcript.turns.map((turn) => turn.from)).toEqual(["other", "unknown"])
  })

  it("keeps the calibrated window and counts every bubble read", () => {
    const many = Array.from({ length: 14 }, (_, i) => bubble(`m${i}`, i % 2 ? "me" : "other"))
    const read = buildScreenTranscript(many, "two_sided")
    expect(read.bubbleCount).toBe(14)
    expect(read.transcript.turns).toHaveLength(10)
    expect(read.transcript.turns[0].text).toBe("m4")
  })

  it("labels group speakers neutrally instead of sending nicknames", () => {
    const read = buildScreenTranscript(
      [bubble("收到", "other", "Bob 王"), bubble("好的", "other", "Carol"), bubble("嗯", "me")],
      "two_sided"
    )
    expect(read.transcript.isGroup).toBe(true)
    expect(read.transcript.turns.map((turn) => turn.text)).toEqual([
      "Person A: 收到",
      "Person B: 好的",
      "嗯",
    ])
    expect(JSON.stringify(read.transcript)).not.toContain("Bob")
  })

  it("does not prefix a lone speaker", () => {
    const read = buildScreenTranscript([bubble("收到", "other", "Bob")], "two_sided")
    expect(read.transcript.isGroup).toBe(false)
    expect(read.transcript.turns[0].text).toBe("收到")
  })
})
