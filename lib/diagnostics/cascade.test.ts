import { CASCADE_THRESHOLD, CASCADE_WINDOW_MS, isCascadingAt, isCascadingIso } from "./cascade"

const BASE = 1_700_000_000_000

describe("isCascadingAt", () => {
  it("needs at least the threshold count", () => {
    expect(isCascadingAt([BASE, BASE + 10])).toBe(false)
    expect(isCascadingAt([BASE, BASE + 10, BASE + 20])).toBe(true)
  })

  it("requires the span to fit inside the window", () => {
    expect(isCascadingAt([BASE, BASE + 10, BASE + CASCADE_WINDOW_MS])).toBe(true)
    expect(isCascadingAt([BASE, BASE + 10, BASE + CASCADE_WINDOW_MS + 1])).toBe(false)
  })

  it("drops non-finite values instead of treating them as zero", () => {
    // A single unparseable timestamp would otherwise stretch the span to ~55
    // years and mask every real cascade.
    expect(isCascadingAt([BASE, BASE + 10, BASE + 20, Number.NaN])).toBe(true)
  })

  it("falls below the threshold once non-finite values are dropped", () => {
    expect(isCascadingAt([BASE, Number.NaN, Number.NaN])).toBe(false)
  })

  it("is false for an empty list", () => {
    expect(isCascadingAt([])).toBe(false)
  })

  it("ignores ordering", () => {
    expect(isCascadingAt([BASE + 20, BASE, BASE + 10])).toBe(true)
  })
})

describe("isCascadingIso", () => {
  it("parses ISO timestamps from the log ring", () => {
    expect(
      isCascadingIso([
        "2026-06-23T10:00:00.000Z",
        "2026-06-23T10:00:01.000Z",
        "2026-06-23T10:00:02.000Z",
      ])
    ).toBe(true)
  })

  it("is false when the entries straddle the window", () => {
    expect(
      isCascadingIso([
        "2026-06-23T10:00:00.000Z",
        "2026-06-23T10:00:01.000Z",
        "2026-06-23T10:00:30.000Z",
      ])
    ).toBe(false)
  })

  it("survives unparseable input", () => {
    expect(isCascadingIso(["nope", "also nope"])).toBe(false)
  })

  it("exposes the shared threshold so callers cannot drift from it", () => {
    expect(CASCADE_THRESHOLD).toBe(3)
    expect(CASCADE_WINDOW_MS).toBe(5000)
  })
})
