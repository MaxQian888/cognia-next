import { segmentAtColumn } from "./status-bar-hit"
import type { StatusSegmentView } from "./status-bar"

const seg = (id: StatusSegmentView["id"], text: string): StatusSegmentView => ({ id, text })

describe("segmentAtColumn", () => {
  // "claude" (6) " · " (3) "anthropic" (9) " · " (3) "plan" (4)
  const segments = [seg("model", "claude"), seg("provider", "anthropic"), seg("mode", "plan")]

  it("maps a click inside the first segment", () => {
    expect(segmentAtColumn(segments, 0)).toBe("model")
    expect(segmentAtColumn(segments, 5)).toBe("model")
  })

  it("returns null inside the separator gap", () => {
    expect(segmentAtColumn(segments, 6)).toBeNull()
    expect(segmentAtColumn(segments, 8)).toBeNull()
  })

  it("maps a click inside a middle segment", () => {
    // provider starts at col 9 (6 + 3).
    expect(segmentAtColumn(segments, 9)).toBe("provider")
    expect(segmentAtColumn(segments, 17)).toBe("provider")
  })

  it("maps a click inside the last segment", () => {
    // mode starts at col 21 (6 + 3 + 9 + 3).
    expect(segmentAtColumn(segments, 21)).toBe("mode")
    expect(segmentAtColumn(segments, 24)).toBe("mode")
  })

  it("returns null past the last segment and before the first", () => {
    expect(segmentAtColumn(segments, 25)).toBeNull()
    expect(segmentAtColumn(segments, -1)).toBeNull()
  })

  it("returns null for an empty segment list", () => {
    expect(segmentAtColumn([], 0)).toBeNull()
  })

  it("accounts for CJK double-width glyphs", () => {
    // "工作" is 2 glyphs × 2 cells = width 4.
    const cjk = [seg("model", "工作"), seg("mode", "x")]
    expect(segmentAtColumn(cjk, 0)).toBe("model")
    expect(segmentAtColumn(cjk, 3)).toBe("model")
    // separator occupies 4,5,6 → null; "x" at col 7.
    expect(segmentAtColumn(cjk, 5)).toBeNull()
    expect(segmentAtColumn(cjk, 7)).toBe("mode")
  })
})
