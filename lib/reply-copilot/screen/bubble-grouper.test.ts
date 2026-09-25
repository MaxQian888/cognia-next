import {
  groupBubbles,
  isTimestampLine,
  resolvePane,
  sideOfLine,
  type ScreenLine,
} from "./bubble-grouper"

const frame = { width: 1000, height: 800 }
/** The focused composer spans the conversation pane (x 300–980). */
const composer = { x: 300, y: 600, width: 680, height: 150 }

function line(text: string, x: number, y: number, width: number, height = 24): ScreenLine {
  return { text, bbox: { x, y, width, height } }
}

describe("isTimestampLine", () => {
  it.each([
    "18:30",
    "9:05 PM",
    "昨天 18:30",
    "星期三 上午 9:15",
    "下午3:20",
    "Yesterday 10:12 AM",
    "2026年9月25日 18:00",
    "9月25日",
    "9/25/26, 6:30 PM",
  ])("drops %s", (text) => expect(isTimestampLine(text)).toBe(true))

  it.each(["明天18:30见", "ok", "Meeting at 18:30?", "3"])("keeps %s", (text) =>
    expect(isTimestampLine(text)).toBe(false)
  )
})

describe("resolvePane", () => {
  it("uses a focused composer as the pane and the input edge", () => {
    expect(resolvePane(frame, composer)).toEqual({
      left: 300,
      right: 980,
      top: 64,
      bottom: 600,
      source: "composer",
    })
  })

  it("ignores a focused field that cannot be the message composer", () => {
    // A search box at the top of the window.
    expect(resolvePane(frame, { x: 20, y: 40, width: 240, height: 30 }).source).toBe("window")
    // Too narrow to span a conversation.
    expect(resolvePane(frame, { x: 700, y: 650, width: 100, height: 30 }).source).toBe("window")
    expect(resolvePane(frame, null)).toEqual({
      left: 0,
      right: 1000,
      top: 64,
      bottom: 640,
      source: "window",
    })
  })
})

describe("sideOfLine", () => {
  const pane = resolvePane(frame, composer)
  it("reads the anchored edge", () => {
    expect(sideOfLine({ x: 370, y: 0, width: 200, height: 24 }, pane, "two_sided")).toBe("other")
    expect(sideOfLine({ x: 780, y: 0, width: 160, height: 24 }, pane, "two_sided")).toBe("me")
  })

  it("refuses to call a line whose margins are too close", () => {
    expect(sideOfLine({ x: 340, y: 0, width: 610, height: 24 }, pane, "two_sided")).toBe("unknown")
  })

  it("never gives sides in a single-column app", () => {
    expect(sideOfLine({ x: 370, y: 0, width: 200, height: 24 }, pane, "single_column")).toBe(
      "unknown"
    )
  })
})

describe("groupBubbles", () => {
  const lines: ScreenLine[] = [
    line("Search", 20, 20, 120),
    line("Ann(3)", 320, 20, 90, 28),
    line("Bob: 在吗", 20, 120, 200), // conversation list, left of the pane
    line("明天的会你来吗", 370, 100, 200),
    line("昨天 18:30", 590, 150, 100), // centered timestamp
    line("来", 780, 200, 160),
    line("第一行很长很长", 370, 260, 500),
    line("第二行", 370, 288, 300),
    line("以下为新消息", 580, 330, 120), // centered system line
    line("ok", 880, 380, 40, 16),
    line("-", 700, 400, 10, 10),
    line("ok", 370, 500, 30, 16), // a short message, not a name
    line("draft I am typing", 320, 650, 300), // inside the composer
  ]

  it("keeps the pane's messages in order with sides and drops the noise", () => {
    const grouped = groupBubbles({ lines, frame, composer, layout: "two_sided" })
    expect(grouped.bubbles.map(({ text, side }) => ({ text, side }))).toEqual([
      { text: "明天的会你来吗", side: "other" },
      { text: "来", side: "me" },
      { text: "第一行很长很长第二行", side: "other" },
      { text: "ok", side: "me" },
      { text: "ok", side: "other" },
    ])
    expect(grouped.header).toBe("Ann")
    // Search, the header, the conversation list and the composer draft.
    expect(grouped.dropped).toEqual({ outside: 4, timestamps: 1, system: 2 })
    expect(grouped.pane.source).toBe("composer")
  })

  it("joins Latin lines with a space", () => {
    const grouped = groupBubbles({
      lines: [line("see you", 370, 100, 400), line("tomorrow", 370, 128, 200)],
      frame,
      composer,
      layout: "two_sided",
    })
    expect(grouped.bubbles.map((b) => b.text)).toEqual(["see you tomorrow"])
  })

  it("reads a group sender name above the bubble, merged or apart", () => {
    const grouped = groupBubbles({
      lines: [
        line("Bob", 370, 100, 60, 16),
        line("收到", 370, 126, 80),
        line("Carol", 370, 200, 70, 16),
        line("明天见", 370, 240, 120),
        line("好", 900, 300, 40),
      ],
      frame,
      composer,
      layout: "two_sided",
    })
    expect(grouped.bubbles).toEqual([
      { text: "收到", side: "other", top: 126, speaker: "Bob" },
      { text: "明天见", side: "other", top: 240, speaker: "Carol" },
      { text: "好", side: "me", top: 300, speaker: null },
    ])
  })

  it("leaves every bubble unsided in a single-column app", () => {
    const grouped = groupBubbles({ lines, frame, composer, layout: "single_column" })
    expect(new Set(grouped.bubbles.map((b) => b.side))).toEqual(new Set(["unknown"]))
  })

  it("returns nothing for an empty frame", () => {
    expect(groupBubbles({ lines: [], frame, composer: null, layout: "unknown" })).toMatchObject({
      bubbles: [],
      header: null,
    })
  })
})
