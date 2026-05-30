import { RELEASES, type ReleaseNote } from "./release-notes"

describe("RELEASES", () => {
  it("is non-empty and well-formed", () => {
    expect(RELEASES.length).toBeGreaterThan(0)
    for (const r of RELEASES as ReleaseNote[]) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.highlightKeys.length).toBeGreaterThan(0)
      expect(new Set(r.highlightKeys).size).toBe(r.highlightKeys.length)
    }
  })

  it("is ordered newest-first by date", () => {
    const dates = RELEASES.map((r) => r.date)
    const sorted = [...dates].sort((a, b) => (a < b ? 1 : -1))
    expect(dates).toEqual(sorted)
  })
})
