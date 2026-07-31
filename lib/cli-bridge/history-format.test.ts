import {
  HISTORY_FILE_NAME,
  HISTORY_LIMIT,
  capHistory,
  parseHistory,
  serializeHistory,
} from "./history-format"

describe("history-format constants", () => {
  it("matches Claude Code's 100-entry cap and the CLI filename", () => {
    expect(HISTORY_LIMIT).toBe(100)
    expect(HISTORY_FILE_NAME).toBe("history.json")
  })
})

describe("serializeHistory / parseHistory round-trip", () => {
  it("round-trips plain entries oldest → newest", () => {
    const entries = ["first", "second", "third"]
    const body = serializeHistory(entries)
    expect(body.endsWith("\n")).toBe(true)
    expect(parseHistory(body)).toEqual(entries)
  })

  it("escapes and restores multi-line entries as a single line on disk", () => {
    const entries = ["line one\nline two", "with a \\ backslash"]
    const body = serializeHistory(entries)
    // The multi-line entry must not introduce extra physical lines.
    expect(body.split("\n").filter((l) => l.length > 0)).toHaveLength(2)
    expect(parseHistory(body)).toEqual(entries)
  })

  it("drops blank padding lines on parse", () => {
    expect(parseHistory("a\n\nb\n")).toEqual(["a", "b"])
    expect(parseHistory("")).toEqual([])
  })
})

describe("capHistory", () => {
  it("keeps the newest HISTORY_LIMIT entries (tail)", () => {
    const entries = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => `e${i}`)
    const capped = capHistory(entries)
    expect(capped).toHaveLength(HISTORY_LIMIT)
    expect(capped[0]).toBe("e5")
    expect(capped[capped.length - 1]).toBe(`e${HISTORY_LIMIT + 4}`)
  })

  it("returns the list unchanged when under the cap", () => {
    const entries = ["a", "b"]
    expect(capHistory(entries)).toBe(entries)
  })
})
