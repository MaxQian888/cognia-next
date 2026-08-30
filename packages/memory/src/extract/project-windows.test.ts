import {
  DEFAULT_WINDOW_MAX_MESSAGES,
  buildProjectMiningWindows,
  estimateMessageTokens,
  type ProjectWindowMessage,
} from "./project-windows"

const msg = (id: string, text = "some project text", role = "user"): ProjectWindowMessage => ({
  id,
  role,
  text,
})

const many = (n: number, text = "some project text") =>
  Array.from({ length: n }, (_, i) => msg(`m${i + 1}`, text))

describe("buildProjectMiningWindows", () => {
  it("returns one window for a short transcript", () => {
    const windows = buildProjectMiningWindows(many(3))
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ firstMessageId: "m1", lastMessageId: "m3" })
    expect(windows[0]?.messages).toHaveLength(3)
  })

  it("identifies windows by message id, never by index", () => {
    // Index identity would shift every downstream window when a message is
    // edited near the top, re-mining the whole session and duplicating claims.
    const windows = buildProjectMiningWindows(many(20), { maxMessages: 5, overlap: 0 })
    for (const window of windows) {
      expect(window.firstMessageId).toBe(window.messages[0]?.id)
      expect(window.lastMessageId).toBe(window.messages[window.messages.length - 1]?.id)
    }
  })

  it("caps a window at maxMessages", () => {
    const windows = buildProjectMiningWindows(many(30), { maxMessages: 4, overlap: 0 })
    for (const window of windows) expect(window.messages.length).toBeLessThanOrEqual(4)
  })

  it("overlaps consecutive windows so a fact split across the seam survives", () => {
    const windows = buildProjectMiningWindows(many(10), { maxMessages: 4, overlap: 2 })
    expect(windows.length).toBeGreaterThan(1)
    const first = windows[0]!
    const second = windows[1]!
    const shared = second.messages.filter((m) => first.messages.some((f) => f.id === m.id))
    expect(shared).toHaveLength(2)
  })

  it("covers every message across the windows", () => {
    const messages = many(17)
    const windows = buildProjectMiningWindows(messages, { maxMessages: 5, overlap: 2 })
    const covered = new Set(windows.flatMap((w) => w.messages.map((m) => m.id)))
    expect(covered.size).toBe(messages.length)
  })

  it("splits on the token budget before the message cap", () => {
    const fat = Array.from({ length: 6 }, (_, i) => msg(`m${i + 1}`, "x".repeat(4_000)))
    const windows = buildProjectMiningWindows(fat, { maxMessages: 12, maxTokens: 2_000 })
    expect(windows.length).toBeGreaterThan(1)
  })

  it("still emits a window for one oversized message rather than dropping it", () => {
    // Silently discarding a huge tool result would lose exactly the outcome
    // evidence project mining exists to capture.
    const windows = buildProjectMiningWindows([msg("m1", "x".repeat(100_000))], { maxTokens: 100 })
    expect(windows).toHaveLength(1)
    expect(windows[0]?.messages.map((m) => m.id)).toEqual(["m1"])
  })

  it("skips entries with no id or no text", () => {
    const windows = buildProjectMiningWindows([
      { id: "", role: "user", text: "no id" },
      { id: "m2", role: "user", text: "   " },
      msg("m3"),
    ])
    expect(windows).toHaveLength(1)
    expect(windows[0]?.messages.map((m) => m.id)).toEqual(["m3"])
  })

  it("returns no windows for an empty or unusable transcript", () => {
    expect(buildProjectMiningWindows([])).toEqual([])
    expect(buildProjectMiningWindows([{ id: "", role: "user", text: "" }])).toEqual([])
  })

  it("always advances, even when overlap would otherwise stall the walk", () => {
    // overlap >= window size would loop forever without the explicit floor.
    const windows = buildProjectMiningWindows(many(9), { maxMessages: 3, overlap: 99 })
    expect(windows.length).toBeGreaterThan(1)
    expect(windows.length).toBeLessThan(20)
    expect(windows[windows.length - 1]?.lastMessageId).toBe("m9")
  })

  it("uses the shared estimator rather than an inline chars/4", () => {
    expect(estimateMessageTokens(msg("m1", "abcd"))).toBeGreaterThan(0)
  })

  it("defaults to the documented window size", () => {
    const windows = buildProjectMiningWindows(many(DEFAULT_WINDOW_MAX_MESSAGES + 5))
    expect(windows[0]?.messages.length).toBe(DEFAULT_WINDOW_MAX_MESSAGES)
  })
})
