import { MARKETPLACE_TEASERS } from "./marketplace-teasers"

describe("MARKETPLACE_TEASERS", () => {
  it("contains 3-4 entries", () => {
    expect(MARKETPLACE_TEASERS.length).toBeGreaterThanOrEqual(3)
    expect(MARKETPLACE_TEASERS.length).toBeLessThanOrEqual(4)
  })

  it("each entry has the required shape and non-empty strings", () => {
    for (const t of MARKETPLACE_TEASERS) {
      expect(typeof t.id).toBe("string")
      expect(t.id.length).toBeGreaterThan(0)
      expect(typeof t.name).toBe("string")
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.description).toBe("string")
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.author).toBe("string")
      expect(typeof t.category).toBe("string")
    }
  })

  it("ids are unique", () => {
    const ids = MARKETPLACE_TEASERS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
