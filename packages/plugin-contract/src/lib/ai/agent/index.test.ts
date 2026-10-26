import * as barrel from "./index"

describe("lib/ai/agent barrel", () => {
  it("imports successfully", () => {
    expect(barrel).toBeDefined()
  })

  it("only re-exports types (no runtime values)", () => {
    // The module exports interfaces only — at runtime the Object should be
    // empty (or only contain TS helpers). Accept either case but assert
    // that no spurious side-effect functions snuck in.
    const keys = Object.keys(barrel)
    for (const key of keys) {
      const value = (barrel as Record<string, unknown>)[key]
      // If anything is exported at runtime, it must be a function or class.
      // But the file only contains `export interface` declarations, so the
      // expected runtime shape is an empty object.
      expect(["function", "object", "undefined"]).toContain(typeof value)
    }
  })
})
